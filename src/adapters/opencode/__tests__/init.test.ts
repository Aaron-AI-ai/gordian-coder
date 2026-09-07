import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyPlugin,
  isGordianEntry,
  readConfig,
  removeConfiguredPlugin,
  resolvePluginEntry,
  removePlugin,
  resolveConfigPath,
  upsertPlugin,
  OpencodeInitError,
} from "../init";

const ENTRY = "/opt/gordian-coder/dist/adapters/opencode/index.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gdc-opencode-"));
}

// OpenCode는 file:// 로 시작하지 않는 plugin 항목을 npm 패키지로 보고 레지스트리에
// 설치를 시도한다. 폐쇄망에서는 npm 기본 타임아웃(5분)을 그대로 기다린다.
describe("resolvePluginEntry", () => {
  test("writes a file:// URL, not a bare path", () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, "opencode"), { recursive: true });
    fs.writeFileSync(path.join(dir, "opencode", "index.js"), "");

    const entry = resolvePluginEntry(path.join(dir, "cline"));

    expect(entry.startsWith("file://")).toBe(true);
    expect(entry.endsWith("adapters/opencode/index.js") || entry.endsWith("opencode/index.js")).toBe(
      true,
    );
  });
});

describe("isGordianEntry", () => {
  test("matches a file:// URL entry", () => {
    expect(isGordianEntry("file:///opt/gc/dist/adapters/opencode/index.js")).toBe(true);
  });

  test("matches any install path of our adapter", () => {
    expect(isGordianEntry(ENTRY)).toBe(true);
    expect(isGordianEntry("C:\\Users\\x\\gordian-coder\\dist\\adapters\\opencode\\index.js")).toBe(
      true,
    );
    expect(isGordianEntry("gordian-coder")).toBe(true);
  });

  test("leaves unrelated plugins alone", () => {
    expect(isGordianEntry("some-other-plugin")).toBe(false);
    expect(isGordianEntry("/opt/other/dist/adapters/opencode/index.mjs")).toBe(false);
  });
});

describe("upsertPlugin", () => {
  test("replaces a stale install path instead of appending it", () => {
    const before = ["other-plugin", "/old/install/dist/adapters/opencode/index.js"];
    expect(upsertPlugin(before, ENTRY)).toEqual(["other-plugin", ENTRY]);
  });

  test("is idempotent", () => {
    expect(upsertPlugin(upsertPlugin([], ENTRY), ENTRY)).toEqual([ENTRY]);
  });
});

describe("removePlugin", () => {
  test("drops every gordian entry, including stale install paths", () => {
    const before = ["other-plugin", "/old/install/dist/adapters/opencode/index.js", ENTRY];
    expect(removePlugin(before)).toEqual(["other-plugin"]);
  });

  test("is a no-op when nothing is registered", () => {
    expect(removePlugin(["other-plugin"])).toEqual(["other-plugin"]);
    expect(removePlugin([])).toEqual([]);
  });
});

describe("removeConfiguredPlugin", () => {
  test("removes the entry, backs up, and keeps other keys", () => {
    const file = path.join(tmpdir(), "opencode.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ plugin: ["keep-me", ENTRY], provider: { a: 1 } }),
    );

    const result = removeConfiguredPlugin(readConfig(file));

    expect(result.after).toEqual(["keep-me"]);
    expect(fs.existsSync(result.backup!)).toBe(true);

    const written = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(written.plugin).toEqual(["keep-me"]);
    expect(written.provider).toEqual({ a: 1 });
  });

  test("init then deinit round-trips back to the original list", () => {
    const file = path.join(tmpdir(), "opencode.json");
    fs.writeFileSync(file, JSON.stringify({ plugin: ["keep-me"] }));

    applyPlugin(readConfig(file), ENTRY);
    const result = removeConfiguredPlugin(readConfig(file));

    expect(result.after).toEqual(["keep-me"]);
  });
});

describe("resolveConfigPath", () => {
  const env = {
    OPENCODE_CONFIG: "/env/explicit.json",
    OPENCODE_CONFIG_DIR: "/env/dir",
    XDG_CONFIG_HOME: "/env/xdg",
  };

  test("--config wins over everything", () => {
    const r = resolveConfigPath({ global: true, configPath: "/a/b.json", env });
    expect(r).toEqual({ path: "/a/b.json", origin: "--config" });
  });

  test("OPENCODE_CONFIG names the config file", () => {
    expect(resolveConfigPath({ global: true, env })).toEqual({
      path: "/env/explicit.json",
      origin: "OPENCODE_CONFIG",
    });
  });

  // OPENCODE_CONFIG_DIR points at agents/commands/plugins, NOT at opencode.json;
  // XDG_CONFIG_HOME is not part of the documented lookup either. Honouring them
  // wrote to a file OpenCode never reads.
  test("ignores OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME", () => {
    const only = { OPENCODE_CONFIG_DIR: "/env/dir", XDG_CONFIG_HOME: "/env/xdg" };
    const r = resolveConfigPath({ global: true, env: only });
    expect(r.origin).toBe("전역 설정 (~/.config/opencode)");
    expect(r.path).toBe(path.join(os.homedir(), ".config", "opencode", "opencode.json"));
  });

  test("defaults to the documented global path on every platform", () => {
    expect(resolveConfigPath({ global: true, env: {} }).path).toBe(
      path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    );
  });

  test("local mode ignores the env chain", () => {
    expect(resolveConfigPath({ global: false, cwd: "/proj", env })).toEqual({
      path: "/proj/opencode.json",
      origin: "프로젝트 로컬",
    });
  });

  test("prefers an existing .jsonc over creating a new .json", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "opencode.jsonc"), "{}");
    expect(resolveConfigPath({ global: false, cwd: dir, env: {} }).path).toBe(
      path.join(dir, "opencode.jsonc"),
    );
  });
});

describe("readConfig", () => {
  test("a missing file is not an error", () => {
    const state = readConfig(path.join(tmpdir(), "opencode.json"));
    expect(state.exists).toBe(false);
    expect(state.plugins).toEqual([]);
  });

  // Windows PowerShell의 Set-Content -Encoding UTF8이 BOM을 붙인다.
  // OpenCode는 그런 파일을 읽으므로 우리도 읽어야 한다.
  test("reads a config written with a UTF-8 BOM", () => {
    const file = path.join(tmpdir(), "opencode.json");
    fs.writeFileSync(file, "﻿" + JSON.stringify({ plugin: ["keep-me"] }), "utf-8");

    const state = readConfig(file);

    expect(state.exists).toBe(true);
    expect(state.plugins).toEqual(["keep-me"]);
  });

  test("rewrites a BOM-prefixed config without the BOM", () => {
    const file = path.join(tmpdir(), "opencode.json");
    fs.writeFileSync(file, "﻿" + JSON.stringify({ plugin: [] }), "utf-8");

    applyPlugin(readConfig(file), ENTRY);

    expect(fs.readFileSync(file, "utf-8").startsWith("﻿")).toBe(false);
  });

  test("refuses to touch a file it cannot round-trip", () => {
    const file = path.join(tmpdir(), "opencode.json");
    fs.writeFileSync(file, '{ // comment\n "plugin": [] }');
    expect(() => readConfig(file)).toThrow(OpencodeInitError);
  });
});

describe("applyPlugin", () => {
  test("keeps other keys, backs up, and writes the new entry", () => {
    const file = path.join(tmpdir(), "opencode.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ $schema: "x", plugin: ["keep-me"], provider: { a: 1 } }),
    );

    const result = applyPlugin(readConfig(file), ENTRY);

    expect(result.after).toEqual(["keep-me", ENTRY]);
    expect(fs.existsSync(result.backup!)).toBe(true);

    const written = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(written.plugin).toEqual(["keep-me", ENTRY]);
    expect(written.provider).toEqual({ a: 1 });
    expect(written.$schema).toBe("x");
  });

  test("creates the file and its parent directory when absent", () => {
    const file = path.join(tmpdir(), "nested", "opencode.json");
    const result = applyPlugin(readConfig(file), ENTRY);

    expect(result.created).toBe(true);
    expect(result.backup).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).plugin).toEqual([ENTRY]);
  });
});
