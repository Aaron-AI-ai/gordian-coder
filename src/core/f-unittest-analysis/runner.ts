/**
 * Runs the module's tests with Gradle from the plugin itself (no shell script): build, then test. Same on
 * Windows and Linux/macOS. Leaves status.json, gradle.log and test-results/ in `outDir`, and reports short
 * progress texts (stage, elapsed time, finished test classes) while it works.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ENV_FAILURE_PATTERN, JAVAC_ERROR_PATTERN, MAIN_JAVAC_ERROR_PATTERN } from "../f-unit-test/env-failure";

export interface RunRequest {
  cwd: string;
  module: string;
  /** Full test class names, optionally `.method`; empty = every test. */
  tests: string[];
  /** Absolute scratch directory. */
  outDir: string;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

const RESOLUTION = new RegExp(ENV_FAILURE_PATTERN, "i");
const JAVAC = new RegExp(JAVAC_ERROR_PATTERN);
const MAIN_JAVAC = new RegExp(MAIN_JAVAC_ERROR_PATTERN);
const hasLine = (log: string, re: RegExp): boolean => log.split(/\r?\n/).some((l) => re.test(l));
/** English diagnostics: a different JAVA_TOOL_OPTIONS makes Gradle use its own daemon, so a ko daemon is not reused. */
const ENGLISH = "-Duser.language=en -Duser.country=US";

export const gradlePath = (module: string): { gmod: string; mdir: string } => {
  const gmod = module.replace(/\//g, ":").replace(/^:/, "");
  return { gmod, mdir: gmod.replace(/:/g, "/") };
};

/** The gradle test command as text, for the report. */
export function gradleCommandText(module: string, tests: string[]): string {
  const { gmod } = gradlePath(module);
  return `gradlew :${gmod}:cleanTest :${gmod}:test --continue${tests.map((t) => ` --tests ${t}`).join("")}`;
}

function gradleCommand(cwd: string, platform: NodeJS.Platform): { exe: string; prefix: string[] } {
  if (platform === "win32") {
    const bat = path.join(cwd, "gradlew.bat");
    // .bat files cannot be spawned directly on current Node/Bun, they go through cmd.exe.
    return { exe: "cmd.exe", prefix: ["/c", fs.existsSync(bat) ? bat : "gradle"] };
  }
  return fs.existsSync(path.join(cwd, "gradlew")) ? { exe: "sh", prefix: ["./gradlew"] } : { exe: "gradle", prefix: [] };
}

const fmt = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** status.json log: the first environment line leads the last 40 lines (same shape the old scripts wrote). */
function logTail(log: string): string {
  const lines = log.split(/\r?\n/);
  const env = hasLine(log, JAVAC) ? undefined : lines.find((l) => RESOLUTION.test(l));
  const tail = lines.slice(-40);
  return (env ? [`[run-tests] first environment line: ${env}`, ...tail] : tail).join("\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

export async function runTests(req: RunRequest): Promise<void> {
  const platform = req.platform ?? process.platform;
  const { gmod, mdir } = gradlePath(req.module);
  const resultsDir = path.join(req.cwd, mdir, "build/test-results/test");
  const logFile = path.join(req.outDir, "gradle.log");
  fs.mkdirSync(req.outDir, { recursive: true });
  for (const stale of ["status.json", "test-results"]) fs.rmSync(path.join(req.outDir, stale), { recursive: true, force: true });
  fs.writeFileSync(logFile, "");

  const startedAt = Date.now();
  let phase = "준비 중";
  let task = "";
  const doneClasses = (): number => (fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).filter((f) => /^TEST-.*\.xml$/.test(f)).length : 0);
  const selected = new Set(req.tests.map((t) => t.replace(/\.[a-z_]\w*$/, ""))).size;
  const report = (): void => {
    const done = phase.includes("테스트") ? ` · 클래스 ${doneClasses()}${selected > 0 ? `/${selected}` : ""}개 완료` : "";
    req.onProgress?.(`f-unittest-analysis · ${phase}${done}${task ? ` · ${task}` : ""} · ${fmt(Date.now() - startedAt)}`);
  };
  const heartbeat = setInterval(report, 1000);

  const gr = gradleCommand(req.cwd, platform);
  const env = { ...process.env, JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, ENGLISH].filter(Boolean).join(" ") };
  /** One gradle run; its whole output is returned and appended to gradle.log. -1 when gradle cannot be started. */
  const gradle = (args: string[]): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      let out = "";
      const child = spawn(gr.exe, [...gr.prefix, ...args], { cwd: req.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const kill = (): void => {
        if (platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGTERM");
      };
      req.signal?.addEventListener("abort", kill, { once: true });
      const feed = (d: Buffer): void => {
        const text = d.toString("utf-8");
        out += text;
        fs.appendFileSync(logFile, text);
        for (const m of text.matchAll(/^> Task (:\S+)/gm)) task = m[1]!;
      };
      child.stdout.on("data", feed);
      child.stderr.on("data", feed);
      child.on("error", (e) => resolve({ code: -1, out: `${out}${e.message}\n` }));
      child.on("close", (code) => resolve({ code: code ?? -1, out }));
    });

  const status = (compile: "ok" | "fail", tests: "run" | "none" | "missing", log: string): void =>
    fs.writeFileSync(path.join(req.outDir, "status.json"), `${JSON.stringify({ compile, log: logTail(log), tests })}\n`);

  try {
    // 1) Build. Offline first; online only for a dependency problem or main-source errors (never for test-source errors).
    phase = "[1/2] 컴파일 중";
    report();
    let build = await gradle([`:${gmod}:testClasses`, "--offline"]);
    if (build.code !== 0 && build.code !== -1) {
      const online = hasLine(build.out, MAIN_JAVAC) || (!hasLine(build.out, JAVAC) && hasLine(build.out, RESOLUTION));
      if (online) {
        fs.appendFileSync(logFile, "[run-tests] offline build failed -> retried online\n");
        build = await gradle([`:${gmod}:testClasses`]);
      }
    }
    if (build.code !== 0) return status("fail", "missing", build.out || "gradle could not be started (no wrapper, no gradle on PATH)");
    if (req.signal?.aborted) return status("fail", "missing", "cancelled");

    // 2) Run. One offline run, no online retry: a failing test that mentions a connection is not a dependency problem.
    phase = "[2/2] 테스트 실행 중";
    fs.rmSync(resultsDir, { recursive: true, force: true });
    const run = await gradle([`:${gmod}:cleanTest`, `:${gmod}:test`, "--continue", "--offline", ...req.tests.flatMap((t) => ["--tests", t])]);
    fs.appendFileSync(logFile, `[run-tests] gradle test exit: ${run.code}\n`);
    let found = false;
    if (fs.existsSync(resultsDir)) {
      fs.cpSync(resultsDir, path.join(req.outDir, "test-results"), { recursive: true });
      found = fs.readdirSync(resultsDir).some((f) => /^TEST-.*\.xml$/.test(f));
    }
    status("ok", found ? "run" : "none", build.out + run.out);
  } finally {
    clearInterval(heartbeat);
  }
}
