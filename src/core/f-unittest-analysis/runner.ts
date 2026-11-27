/**
 * Runs the module's tests with Gradle from the plugin itself (no shell script): build, then test. Same on
 * Windows and Linux/macOS. Leaves status.json, gradle.log, test-results/ and (best-effort) jacoco.xml and jacoco-html/ in `outDir`, and reports short
 * progress texts (stage, elapsed time, finished test classes) while it works.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_FAILURE_PATTERN, JAVAC_ERROR_PATTERN, MAIN_JAVAC_ERROR_PATTERN } from "../f-unit-test/env-failure";

/** `assets/` sits three levels above this module's own directory, in both src/ and the bundled dist/. Coverage reuses
 * f-unit-test-code's bundled JaCoCo agent/cli instead of shipping a second copy. */
function assetsDir(): string {
  const here = import.meta.dir ?? path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "assets");
}
const JACOCO_TOOLS = (): string => path.join(assetsDir(), "fico-ai/skills/f-unit-test-code/tools");
const INIT_GRADLE = (): string => path.join(assetsDir(), "fico-ai/skills/f-unit-test-code/scripts/init.gradle");

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

/** "." (or "") is the root project of a single-project build: its tasks are `:test`, its files under `./`. */
export const gradlePath = (module: string): { gmod: string; mdir: string; taskPath: (name: string) => string } => {
  const gmod = module.replace(/\//g, ":").replace(/^:/, "").replace(/^\.$/, "");
  return { gmod, mdir: gmod ? gmod.replace(/:/g, "/") : ".", taskPath: (name) => (gmod ? `:${gmod}:${name}` : `:${name}`) };
};

/** The gradle test command as text, for the report. */
export function gradleCommandText(module: string, tests: string[]): string {
  const { taskPath } = gradlePath(module);
  return `gradlew ${taskPath("cleanTest")} ${taskPath("test")} --continue${tests.map((t) => ` --tests ${t}`).join("")}`;
}

/** cmd.exe line for `cmd /d /s /c "<line>"`: /s strips only the outer quotes, so args quoted here survive intact
 * (Node's own quoting of several spaced args gets mangled by plain `cmd /c`). */
export function windowsCmdLine(prog: string, args: string[]): string {
  const q = (a: string): string => (a === "" || /[\s&|<>^()%!"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  return `"${[prog, ...args].map(q).join(" ")}"`;
}

function gradleCommand(cwd: string, platform: NodeJS.Platform): { exe: string; prefix: string[]; win: boolean } {
  // .bat files cannot be spawned directly on current Node/Bun, they go through cmd.exe. cwd is the project, so
  // the wrapper is named relatively and the project path's spaces never reach the command line.
  if (platform === "win32") return { exe: "cmd.exe", prefix: [fs.existsSync(path.join(cwd, "gradlew.bat")) ? "gradlew.bat" : "gradle"], win: true };
  return fs.existsSync(path.join(cwd, "gradlew")) ? { exe: "sh", prefix: ["./gradlew"], win: false } : { exe: "gradle", prefix: [], win: false };
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
  const { mdir, taskPath } = gradlePath(req.module);
  const resultsDir = path.join(req.cwd, mdir, "build/test-results/test");
  const logFile = path.join(req.outDir, "gradle.log");
  fs.mkdirSync(req.outDir, { recursive: true });
  for (const stale of ["status.json", "test-results", "jacoco.xml", "jacoco-html"]) fs.rmSync(path.join(req.outDir, stale), { recursive: true, force: true });
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
      const child = gr.win
        ? spawn(gr.exe, ["/d", "/s", "/c", windowsCmdLine(gr.prefix[0]!, args)], { cwd: req.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true })
        : spawn(gr.exe, [...gr.prefix, ...args], { cwd: req.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      // An exited child's PID may be reused by another process: never kill after exit (taskkill /T takes the whole tree).
      const kill = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGTERM");
      };
      req.signal?.addEventListener("abort", kill, { once: true });
      const detach = (): void => req.signal?.removeEventListener("abort", kill);
      child.on("close", detach);
      child.on("error", detach);
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
    let build = await gradle([taskPath("testClasses"), "--offline"]);
    if (build.code !== 0 && build.code !== -1) {
      const online = hasLine(build.out, MAIN_JAVAC) || (!hasLine(build.out, JAVAC) && hasLine(build.out, RESOLUTION));
      if (online) {
        fs.appendFileSync(logFile, "[run-tests] offline build failed -> retried online\n");
        build = await gradle([taskPath("testClasses")]);
      }
    }
    if (build.code !== 0) return status("fail", "missing", build.out || "gradle could not be started (no wrapper, no gradle on PATH)");
    if (req.signal?.aborted) return status("fail", "missing", "cancelled");

    // 2) Run offline. Retried online only when no result was written and Gradle could not resolve a dependency
    // (a testRuntimeOnly dep that testClasses never needed): a failing test that mentions a connection is not that.
    // The JaCoCo agent (reused from f-unit-test-code's bundled tools) is attached via -I init.gradle so the
    // report can show overall coverage; a missing/failed coverage step never affects the test verdict.
    phase = "[2/2] 테스트 실행 중";
    fs.rmSync(resultsDir, { recursive: true, force: true });
    const execFile = path.join(req.outDir, "jacoco.exec");
    fs.rmSync(execFile, { force: true });
    const testArgs = (offline: boolean): string[] => [
      taskPath("cleanTest"),
      taskPath("test"),
      "--continue",
      ...(offline ? ["--offline"] : []),
      "-I",
      INIT_GRADLE(),
      `-Pfut.agent=${path.join(JACOCO_TOOLS(), "jacocoagent.jar")}`,
      `-Pfut.exec=${execFile}`,
      ...req.tests.flatMap((t) => ["--tests", t]),
    ];
    const hasResults = (): boolean => fs.existsSync(resultsDir) && fs.readdirSync(resultsDir).some((f) => /^TEST-.*\.xml$/.test(f));
    let run = await gradle(testArgs(true));
    if (!hasResults() && hasLine(run.out, RESOLUTION) && !req.signal?.aborted) {
      fs.appendFileSync(logFile, "[run-tests] offline test run resolved no dependency -> retried online\n");
      run = await gradle(testArgs(false));
    }
    fs.appendFileSync(logFile, `[run-tests] gradle test exit: ${run.code}\n`);
    const found = hasResults();
    if (fs.existsSync(resultsDir)) fs.cpSync(resultsDir, path.join(req.outDir, "test-results"), { recursive: true });
    await writeCoverageXml(req, execFile, mdir, platform);
    status("ok", found ? "run" : "none", build.out + run.out);
  } finally {
    clearInterval(heartbeat);
  }
}

/** Converts jacoco.exec to jacoco.xml and JaCoCo's own HTML (jacoco-html/) in outDir, best-effort: no java/classes/exec, or a failed cli run, just
 * leaves the file absent (the report then shows no coverage; it never affects the test verdict). */
async function writeCoverageXml(req: RunRequest, execFile: string, mdir: string, platform: NodeJS.Platform): Promise<void> {
  const classesDir = path.join(req.cwd, mdir, "build/classes/java/main");
  if (!fs.existsSync(execFile) || !fs.existsSync(classesDir)) return;
  const javaHome = process.env.JAVA_HOME;
  const javaBin = javaHome ? path.join(javaHome, "bin", platform === "win32" ? "java.exe" : "java") : "java";
  const xmlOut = path.join(req.outDir, "jacoco.xml");
  const code = await new Promise<number>((resolve) => {
    const child = spawn(
      javaBin,
      ["-jar", path.join(JACOCO_TOOLS(), "jacococli.jar"), "report", execFile, "--classfiles", classesDir, "--sourcefiles", path.join(req.cwd, mdir, "src/main/java"), "--xml", xmlOut, "--html", path.join(req.outDir, "jacoco-html")],
      { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
    );
    child.on("error", () => resolve(-1));
    child.on("close", (c) => resolve(c ?? -1));
  });
  if (code !== 0) for (const f of [xmlOut, path.join(req.outDir, "jacoco-html")]) fs.rmSync(f, { recursive: true, force: true });
}

/** Raw jacoco.xml text if `runTests` produced one in outDir, else null. */
export function readCoverageXmlText(outDir: string): string | null {
  const xmlFile = path.join(outDir, "jacoco.xml");
  return fs.existsSync(xmlFile) ? fs.readFileSync(xmlFile, "utf-8") : null;
}
