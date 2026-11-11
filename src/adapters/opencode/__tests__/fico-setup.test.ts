import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_FICO_API_URL,
  buildMcpEntry,
  checkFico,
  checkFicoApi,
  flagValue,
  readEffectiveConfig,
  readGlobalConfig,
  resolveApiUrl,
  findMcp,
  findWheel,
  installSkill,
  resolveAssetsDir,
  skillDirFor,
  skillDrift,
  withMcp,
} from "../fico-setup";
import { MCP_SERVER, SKILL_NAME } from "../../../core/pb-online/names";

let root: string;
let assets: string;
let skills: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fico-setup-"));
  assets = path.join(root, "assets");
  skills = path.join(root, "skills");
  write(path.join(assets, "fico-ai/skills", SKILL_NAME, "SKILL.md"), "skill");
  write(path.join(assets, "fico-ai/skills", SKILL_NAME, "docs/a.md"), "doc");
  write(path.join(assets, "fico-ai/skills/sql-query-gen/SKILL.md"), "other");
  write(path.join(assets, "fico-ai/rules/fico-overview.md"), "rule");
  write(path.join(assets, "fico-mcp/fico_mcp-0.1.0-py3-none-any.whl"), "whl");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("assets", () => {
  test("the repo really ships the skill and rules", () => {
    const real = resolveAssetsDir();
    expect(fs.existsSync(path.join(real, "fico-ai/skills", SKILL_NAME, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(real, "fico-ai/rules/fico-overview.md"))).toBe(true);
  });

  test("findWheel returns the wheel and fails with a clear message when absent", () => {
    expect(findWheel(assets)).toEndWith(".whl");
    fs.rmSync(path.join(assets, "fico-mcp"), { recursive: true });
    expect(() => findWheel(assets)).toThrow(/fico-mcp/);
  });
});

describe("review fixes", () => {
  test("more than one wheel is refused rather than picking one", () => {
    write(path.join(assets, "fico-mcp/fico_mcp-0.2.0-py3-none-any.whl"), "whl2");
    expect(() => findWheel(assets)).toThrow(/2/);
  });

  test("a value flag needs a real value", () => {
    expect(flagValue(["--fico-api-url", "http://x"], "--fico-api-url")).toBe("http://x");
    expect(flagValue(["--yes"], "--fico-api-url")).toBeUndefined();
    expect(() => flagValue(["--fico-api-url", "--yes"], "--fico-api-url")).toThrow(/--fico-api-url/);
    expect(() => flagValue(["--fico-api-url"], "--fico-api-url")).toThrow(/--fico-api-url/);
  });

  test("an unreadable effective config is unknown, not empty", () => {
    expect(readEffectiveConfig(() => ({ ok: false, stdout: "" }))).toBeNull();
    expect(readEffectiveConfig(() => ({ ok: true, stdout: "not json" }))).toBeNull();
  });

  test("log noise containing a brace before the JSON does not break parsing", () => {
    const stdout = '[plugin] loaded {v1}\n{\n  "mcp": {"fico-mcp": {}}\n}\n';
    expect(readEffectiveConfig(() => ({ ok: true, stdout }))).toEqual({ mcp: { "fico-mcp": {} } });
  });

  test("the global config file is read directly when OpenCode cannot be asked", () => {
    const home = path.join(root, "home");
    write(path.join(home, ".config/opencode/opencode.json"), JSON.stringify({ mcp: { servers: { [MCP_SERVER]: {} } } }));
    expect(findMcp(readGlobalConfig({}, home))).toEqual({});
    write(path.join(root, "custom.json"), JSON.stringify({ mcp: { [MCP_SERVER]: { a: 1 } } }));
    expect(findMcp(readGlobalConfig({ OPENCODE_CONFIG: path.join(root, "custom.json") }, home))).toEqual({ a: 1 });
    expect(readGlobalConfig({ OPENCODE_CONFIG: path.join(root, "missing.json") }, path.join(root, "nohome"))).toEqual({});
  });
});

describe("skill install", () => {
  test("only the pb skill is installed, with the rules beside it", () => {
    expect(skillDrift(assets, skills).length).toBeGreaterThan(0);
    installSkill(assets, skills);
    expect(fs.readFileSync(path.join(skills, SKILL_NAME, "SKILL.md"), "utf-8")).toBe("skill");
    expect(fs.existsSync(path.join(skills, SKILL_NAME, "rules/fico-overview.md"))).toBe(true);
    expect(fs.existsSync(path.join(skills, "sql-query-gen"))).toBe(false);
    expect(skillDrift(assets, skills)).toEqual([]);
  });

  test("drift reports a changed file and a reinstall clears stale ones", () => {
    installSkill(assets, skills);
    write(path.join(skills, SKILL_NAME, "docs/a.md"), "edited");
    write(path.join(skills, SKILL_NAME, "stale.md"), "old");
    expect(skillDrift(assets, skills)).toEqual(["docs/a.md"]);
    installSkill(assets, skills);
    expect(skillDrift(assets, skills)).toEqual([]);
    expect(fs.existsSync(path.join(skills, SKILL_NAME, "stale.md"))).toBe(false);
  });

  test("global and project skill locations", () => {
    expect(skillDirFor({ global: true, home: "/h", cwd: "/p" })).toBe(path.join("/h", ".config/opencode/skills"));
    expect(skillDirFor({ global: false, home: "/h", cwd: "/p" })).toBe(path.join("/p", ".opencode/skills"));
  });
});

describe("mcp config", () => {
  const entry = { type: "local", command: ["x"] };

  test("finds the server in both config shapes", () => {
    expect(findMcp({ mcp: { [MCP_SERVER]: entry } })).toEqual(entry);
    expect(findMcp({ mcp: { servers: { [MCP_SERVER]: entry } } })).toEqual(entry);
    expect(findMcp({})).toBeUndefined();
  });

  test("adds the entry in the shape the config already uses, keeping other servers", () => {
    const flat = withMcp({ mcp: { other: entry } }, entry);
    expect(flat.mcp).toEqual({ other: entry, [MCP_SERVER]: entry });
    const nested = withMcp({ mcp: { servers: { other: entry } } }, entry);
    expect(nested.mcp).toEqual({ servers: { other: entry, [MCP_SERVER]: entry } });
  });

  test("entry runs the installed module over stdio with the API url", () => {
    expect(buildMcpEntry("/py", "http://api")).toEqual({
      type: "local",
      command: ["/py", "-m", "fico_mcp.server", "--transport", "stdio"],
      environment: { FICO_API_BASE_URL: "http://api" },
    });
  });
});

describe("FICO API address", () => {
  test("defaults to localhost, and a flag or env overrides it", () => {
    expect(DEFAULT_FICO_API_URL).toBe("http://localhost:8081");
    expect(resolveApiUrl(undefined, undefined)).toBe(DEFAULT_FICO_API_URL);
    expect(resolveApiUrl(undefined, "http://env")).toBe("http://env");
    expect(resolveApiUrl("http://flag", "http://env")).toBe("http://flag");
  });
});

describe("api check", () => {
  const configFor = (url?: string) => ({ mcp: { [MCP_SERVER]: url ? { environment: { FICO_API_BASE_URL: url } } : {} } });
  const respond = (status: number) => (async () => new Response("", { status })) as unknown as typeof fetch;

  test("a 2xx from the collections endpoint passes", async () => {
    let called = "";
    const fetchFn = (async (url: string) => {
      called = url;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await checkFicoApi(configFor("http://api/base/"), fetchFn, {});
    expect(result).toMatchObject({ name: "fico-api", ok: true });
    expect(called).toBe("http://api/base/api/v1/console/fwk/collections");
  });

  test("401 means the route exists and login is left to fico-mcp's own account", async () => {
    const result = await checkFicoApi(configFor("http://api"), respond(401), {});
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("401");
  });

  test("a server that answers 404 fails even though the MCP process connects", async () => {
    const result = await checkFicoApi(configFor("http://api"), respond(404), {});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("404");
    expect(result.detail).toContain("http://api");
  });

  test("an unreachable server fails with the reason", async () => {
    const down = (async () => {
      throw new Error("connect refused");
    }) as unknown as typeof fetch;
    const result = await checkFicoApi(configFor("http://api"), down, {});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("connect refused");
  });

  test("without an address on the entry, uses the environment variable, then the default", async () => {
    const env = { FICO_API_BASE_URL: "http://from-env" };
    expect((await checkFicoApi(configFor(), respond(404), env)).detail).toContain("http://from-env");
    expect((await checkFicoApi(configFor(), respond(404), {})).detail).toContain(DEFAULT_FICO_API_URL);
  });
});

describe("check", () => {
  const healthy = (cmd: string[]) =>
    cmd[0] === "mcp"
      ? { ok: true, stdout: `\u001b[0m✓ ${MCP_SERVER} \u001b[90mconnected` }
      : { ok: true, stdout: `[{"name": "${SKILL_NAME}"}]` };

  const entryPath = () => path.join(root, "adapters/opencode/index.js");
  const options = () => ({ assets, skillsDir: skills, config: { plugin: [`file://${entryPath()}`], mcp: { [MCP_SERVER]: {} } } });

  function setUp(): void {
    installSkill(assets, skills);
    write(entryPath(), "");
  }

  test("all pass on a complete setup", () => {
    setUp();
    expect(checkFico(options(), healthy).every((c) => c.ok)).toBe(true);
  });

  test("each missing piece fails on its own line", () => {
    const results = checkFico({ assets, skillsDir: skills, config: {} }, () => ({ ok: false, stdout: "" }));
    expect(results.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "plugin",
      "skill",
      "mcp-config",
      "skill-loaded",
      "mcp-connected",
    ]);
  });

  test("a server that is configured but failing does not pass", () => {
    setUp();
    const failing = (cmd: string[]) =>
      cmd[0] === "mcp" ? { ok: true, stdout: `✗ ${MCP_SERVER} failed` } : healthy(cmd);
    const results = checkFico(options(), failing);
    expect(results.find((c) => c.name === "mcp-connected")!.ok).toBe(false);
  });
});
