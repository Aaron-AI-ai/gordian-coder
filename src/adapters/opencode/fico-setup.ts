/**
 * `gdc fico-init` / `gdc fico-check`: put the FICO skill and MCP server in place
 * for OpenCode and confirm OpenCode really sees them.
 *
 * The skill stays a standard SKILL.md folder and the MCP server a standard
 * entry in opencode.json; this project only ships and installs them.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isGordianEntry, OpencodeInitError, readConfig } from "./init";
import { MCP_SERVER, SKILL_NAME } from "../../core/pb-online/names";

// ponytail: only the pb skill for now; the other vendored skills go here when their workflows move.
// Each environment points elsewhere with FICO_API_BASE_URL or --fico-api-url.
export const DEFAULT_FICO_API_URL = "http://localhost:8081";

type Config = Record<string, unknown>;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export type OpencodeRunner = (args: string[]) => { ok: boolean; stdout: string };

/** `assets/` sits three levels above both src/adapters/x and dist/adapters/x. */
export function resolveAssetsDir(
  fromDir: string = import.meta.dir ?? path.dirname(fileURLToPath(import.meta.url)),
): string {
  return path.resolve(fromDir, "..", "..", "..", "assets");
}

export function findWheel(assets: string): string {
  const dir = path.join(assets, "fico-mcp");
  const wheels = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".whl")) : [];
  if (wheels.length === 0) throw new OpencodeInitError(`fico-mcp 설치 파일(.whl)을 찾을 수 없습니다: ${dir}`);
  if (wheels.length > 1) {
    throw new OpencodeInitError(`fico-mcp 설치 파일이 ${wheels.length}개입니다. 하나만 남기세요: ${dir}\n  ${wheels.join(", ")}`);
  }
  return path.join(dir, wheels[0]!);
}

export function skillDirFor(options: { global: boolean; home?: string; cwd?: string }): string {
  return options.global
    ? path.join(options.home ?? os.homedir(), ".config", "opencode", "skills")
    : path.join(options.cwd ?? process.cwd(), ".opencode", "skills");
}

/** Where the skill is installed: this project's copy if it has one, else the global one. */
export function installedSkillsDir(forceGlobal: boolean): string {
  const project = skillDirFor({ global: false });
  return !forceGlobal && fs.existsSync(path.join(project, SKILL_NAME)) ? project : skillDirFor({ global: true });
}

const listFiles = (dir: string): string[] =>
  !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"));

/** Installed relative path → shipped source file. */
function expectedSkillFiles(assets: string): Map<string, string> {
  const root = path.join(assets, "fico-ai");
  const skill = path.join(root, "skills", SKILL_NAME);
  const rules = path.join(root, "rules");
  return new Map([
    ...listFiles(skill).map((f): [string, string] => [f, path.join(skill, f)]),
    ...listFiles(rules).map((f): [string, string] => [`rules/${f}`, path.join(rules, f)]),
  ]);
}

/** Shipped files that are missing or different in the installed skill. */
export function skillDrift(assets: string, skillsDir: string): string[] {
  const target = path.join(skillsDir, SKILL_NAME);
  return [...expectedSkillFiles(assets)]
    .filter(([rel, source]) => {
      const installed = path.join(target, rel);
      return !fs.existsSync(installed) || !fs.readFileSync(installed).equals(fs.readFileSync(source));
    })
    .map(([rel]) => rel);
}

/**
 * Rules go inside the skill rather than into `instructions`, which would load
 * them into every OpenCode session including f-review and f-log.
 */
export function installSkill(assets: string, skillsDir: string): string {
  const target = path.join(skillsDir, SKILL_NAME);
  fs.rmSync(target, { recursive: true, force: true });
  for (const [rel, source] of expectedSkillFiles(assets)) {
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.copyFileSync(source, path.join(target, rel));
  }
  return target;
}

export function findMcp(config: Config): unknown {
  const mcp = (config.mcp ?? {}) as Config;
  return mcp[MCP_SERVER] ?? ((mcp.servers ?? {}) as Config)[MCP_SERVER];
}

/** OpenCode accepts `mcp.<name>` and `mcp.servers.<name>`; keep whichever the file uses. */
export function withMcp(config: Config, entry: unknown): Config {
  const mcp = (config.mcp ?? {}) as Config;
  if (mcp.servers) {
    return { ...config, mcp: { ...mcp, servers: { ...(mcp.servers as Config), [MCP_SERVER]: entry } } };
  }
  return { ...config, mcp: { ...mcp, [MCP_SERVER]: entry } };
}

export function buildMcpEntry(python: string, apiUrl: string): Config {
  return {
    type: "local",
    command: [python, "-m", "fico_mcp.server", "--transport", "stdio"],
    environment: { FICO_API_BASE_URL: apiUrl },
  };
}

export function resolveApiUrl(flag: string | undefined, env: string | undefined): string {
  return flag || env || DEFAULT_FICO_API_URL;
}

/** A connected MCP process proves nothing about the API behind it, so call the API too. */
export async function checkFicoApi(
  config: Config,
  fetchFn: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckResult> {
  const entry = (findMcp(config) ?? {}) as { environment?: Config };
  // The server process inherits the environment when its entry sets no address.
  const base = String(entry.environment?.FICO_API_BASE_URL ?? resolveApiUrl(undefined, env.FICO_API_BASE_URL));
  const url = `${base.replace(/\/+$/, "")}/api/v1/console/fwk/collections`;
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    // fico-mcp logs in with its own account (FICO_API_USER_ID), so an anonymous 401 still proves the route.
    if (response.status === 401) return { name: "fico-api", ok: true, detail: `${base} (HTTP 401: 로그인은 fico-mcp 계정 설정으로 처리)` };
    return { name: "fico-api", ok: response.ok, detail: response.ok ? base : `${url} → HTTP ${response.status}` };
  } catch (err) {
    return { name: "fico-api", ok: false, detail: `${url} → ${err instanceof Error ? err.message : String(err)}` };
  }
}

function runUv(args: string[]): void {
  const result = spawnSync("uv", args, { stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" });
  if (result.error || result.status !== 0) {
    throw new OpencodeInitError(
      `uv ${args[0]} 실행에 실패했습니다.\n` +
        `  uv가 설치되어 있는지 확인하세요. 폐쇄망이면 UV_INDEX_URL 로 사내 패키지 저장소를 지정하세요.`,
      result.error,
    );
  }
}

/** Install the shipped wheel into its own venv; returns that venv's python. */
export function installMcpServer(assets: string, home: string = os.homedir()): string {
  const wheel = findWheel(assets);
  const venv = path.join(home, ".gordian-coder", "fico-mcp", ".venv");
  runUv(["venv", "--python", "3.13", "--allow-existing", venv]);
  const python =
    process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
  runUv(["pip", "install", "--python", python, "--reinstall-package", "fico-mcp", wheel]);
  return python;
}

function pluginCheck(config: Config): CheckResult {
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const entry = plugins.find((p): p is string => typeof p === "string" && isGordianEntry(p));
  if (!entry) return { name: "plugin", ok: false, detail: "gordian-coder 플러그인이 등록되어 있지 않습니다" };
  const file = entry.startsWith("file:") ? fileURLToPath(entry) : entry;
  const ok = entry === "gordian-coder" || fs.existsSync(file);
  return { name: "plugin", ok, detail: ok ? entry : `등록된 파일이 없습니다: ${file}` };
}

export function checkFico(
  options: { assets: string; skillsDir: string; config: Config },
  run: OpencodeRunner,
): CheckResult[] {
  const { assets, skillsDir, config } = options;
  const drift = skillDrift(assets, skillsDir);
  const skillsOutput = run(["debug", "skill"]);
  const mcpOutput = run(["mcp", "list"]);
  // eslint-disable-next-line no-control-regex
  const mcpLine = mcpOutput.stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.includes(MCP_SERVER));
  const connected = mcpOutput.ok && mcpLine !== undefined && /\bconnected\b/.test(mcpLine);
  const loaded = skillsOutput.ok && new RegExp(`"name":\\s*"${SKILL_NAME}"`).test(skillsOutput.stdout);

  return [
    pluginCheck(config),
    {
      name: "skill",
      ok: drift.length === 0,
      detail: drift.length === 0 ? path.join(skillsDir, SKILL_NAME) : `누락/변경 ${drift.length}개: ${drift.slice(0, 5).join(", ")}`,
    },
    {
      name: "mcp-config",
      ok: findMcp(config) !== undefined,
      detail: findMcp(config) !== undefined ? MCP_SERVER : `${MCP_SERVER} 설정이 없습니다`,
    },
    { name: "skill-loaded", ok: loaded, detail: loaded ? SKILL_NAME : "OpenCode가 스킬을 인식하지 못합니다" },
    { name: "mcp-connected", ok: connected, detail: connected ? MCP_SERVER : (mcpLine?.trim() ?? `${MCP_SERVER} 연결을 확인하지 못했습니다`) },
  ];
}

/** Real runner. Output goes to a file because OpenCode can exit before a pipe drains. */
export const runOpencode: OpencodeRunner = (args) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gdc-opencode-"));
  const file = path.join(dir, "out");
  const fd = fs.openSync(file, "w");
  try {
    const result = spawnSync("opencode", args, {
      stdio: ["ignore", fd, fd],
      timeout: 120_000,
      shell: process.platform === "win32",
    });
    return { ok: !result.error && result.status === 0, stdout: fs.readFileSync(file, "utf-8") };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * The merged config OpenCode actually uses, which may not be the file we would
 * guess. Null when OpenCode cannot be asked: unknown is not the same as empty.
 */
export function readEffectiveConfig(run: OpencodeRunner): Config | null {
  const { ok, stdout } = run(["debug", "config"]);
  if (!ok) return null;
  // Log lines (which may contain braces) come first on the shared stream; the JSON starts on its own line.
  for (const match of stdout.matchAll(/^\{/gm)) {
    try {
      return JSON.parse(stdout.slice(match.index)) as Config;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** The global config file itself, for when OpenCode cannot be asked. */
export function readGlobalConfig(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Config {
  const dir = path.join(home, ".config", "opencode");
  const candidates = [env.OPENCODE_CONFIG, path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      return readConfig(file).config;
    } catch {
      return {};
    }
  }
  return {};
}

/** Value of a `--flag value` pair; a missing value or another flag in its place is an error. */
export function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("-")) throw new OpencodeInitError(`${flag} 에 값이 필요합니다.`);
  return value;
}
