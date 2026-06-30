/**
 * Tests for Cline hook init/deinit
 * Written first (TDD) - these define the expected behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  resolveHooksDir,
  resolveCommand,
  generateHookScript,
  initClineHooks,
  deinitClineHooks,
  CLINE_HOOK_NAMES,
  InitError,
  DeinitError,
} from "../init";
import type { InitOptions } from "../init";

// ── resolveHooksDir ──────────────────────────────────────────────

describe("resolveHooksDir", () => {
  it("returns local .clinerules/hooks path when global=false with cwd override", () => {
    const options: InitOptions = { global: false, force: false, cwd: "/tmp/my-project" };
    const result = resolveHooksDir(options);
    expect(result).toBe(path.join("/tmp/my-project", ".clinerules", "hooks"));
  });

  it("uses process.cwd() when global=false and cwd is not provided", () => {
    const options: InitOptions = { global: false, force: false };
    const result = resolveHooksDir(options);
    expect(result).toBe(path.join(process.cwd(), ".clinerules", "hooks"));
  });

  it("returns global Documents/Cline/Hooks path when global=true", () => {
    const options: InitOptions = { global: true, force: false };
    const result = resolveHooksDir(options);
    expect(result).toBe(path.join(os.homedir(), "Documents", "Cline", "Hooks"));
  });
});

// ── resolveCommand ───────────────────────────────────────────────

describe("resolveCommand", () => {
  it("returns a non-empty string", () => {
    const result = resolveCommand();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── generateHookScript ───────────────────────────────────────────

describe("generateHookScript (linux/darwin)", () => {
  it("includes shebang line", () => {
    const script = generateHookScript("TaskStart", "gdc", "linux");
    expect(script).toContain("#!/usr/bin/env bash");
  });

  it("includes auto-generated marker comment", () => {
    const script = generateHookScript("TaskStart", "gdc", "linux");
    expect(script).toContain("# [gordian-coder:cline] auto-generated hook");
  });

  it("includes exec command with stdin redirect", () => {
    const script = generateHookScript("PreToolUse", "gdc", "darwin");
    expect(script).toContain("exec gdc <&0");
  });

  it("includes hook name in comment", () => {
    const script = generateHookScript("PostToolUse", "gdc", "linux");
    expect(script).toContain("# Hook: PostToolUse");
  });

  it("does not include PowerShell syntax on linux", () => {
    const script = generateHookScript("TaskStart", "gdc", "linux");
    expect(script).not.toContain("[Console]::In.ReadToEnd()");
  });
});

describe("generateHookScript (win32)", () => {
  it("includes marker comment", () => {
    const script = generateHookScript("TaskStart", "gdc", "win32");
    expect(script).toContain("# [gordian-coder:cline] auto-generated hook");
  });

  it("includes PowerShell stdin read syntax", () => {
    const script = generateHookScript("TaskStart", "gdc", "win32");
    expect(script).toContain("[Console]::In.ReadLine()");
  });

  it("pipes input to command", () => {
    const script = generateHookScript("TaskStart", "gdc", "win32");
    expect(script).toContain('$JsonInput | & "gdc"');
  });

  it("does not include bash shebang on win32", () => {
    const script = generateHookScript("TaskStart", "gdc", "win32");
    expect(script).not.toContain("#!/usr/bin/env bash");
  });

  it("includes hook name in comment", () => {
    const script = generateHookScript("TaskCancel", "gdc", "win32");
    expect(script).toContain("# Hook: TaskCancel");
  });
});

// ── initClineHooks ───────────────────────────────────────────────

describe("initClineHooks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gordian-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the hooks directory if it does not exist", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };
    const result = await initClineHooks(options);
    expect(fs.existsSync(result.hooksDir)).toBe(true);
  });

  it("creates all 8 hook files", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };
    const result = await initClineHooks(options);
    expect(result.created).toHaveLength(CLINE_HOOK_NAMES.length);
    expect(result.created).toHaveLength(8);
  });

  it("returns correct hooksDir in result", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };
    const result = await initClineHooks(options);
    expect(result.hooksDir).toBe(path.join(tmpDir, ".clinerules", "hooks"));
  });

  it("files are executable (mode 0o755) on non-win32", async () => {
    if (process.platform === "win32") return;
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };
    const result = await initClineHooks(options);

    for (const filePath of result.created) {
      const stat = fs.statSync(filePath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o755);
    }
  });

  it("skips existing files when force=false", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };

    // First run creates all files
    const firstResult = await initClineHooks(options);
    expect(firstResult.created).toHaveLength(8);
    expect(firstResult.skipped).toHaveLength(0);

    // Second run should skip all existing files
    const secondResult = await initClineHooks(options);
    expect(secondResult.created).toHaveLength(0);
    expect(secondResult.skipped).toHaveLength(8);
  });

  it("skipped array contains file paths of existing files", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };
    await initClineHooks(options);
    const secondResult = await initClineHooks(options);

    for (const skippedPath of secondResult.skipped) {
      expect(fs.existsSync(skippedPath)).toBe(true);
    }
  });

  it("overwrites existing files when force=true", async () => {
    const localOptions: InitOptions = { global: false, force: false, cwd: tmpDir };
    const forceOptions: InitOptions = { global: false, force: true, cwd: tmpDir };

    // First run
    await initClineHooks(localOptions);

    // Force run should overwrite
    const forceResult = await initClineHooks(forceOptions);
    expect(forceResult.created).toHaveLength(8);
    expect(forceResult.skipped).toHaveLength(0);
  });

  it("created files contain the marker comment", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };
    const result = await initClineHooks(options);

    for (const filePath of result.created) {
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toContain("# [gordian-coder:cline] auto-generated hook");
    }
  });
});

// ── deinitClineHooks ─────────────────────────────────────────────

describe("deinitClineHooks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gordian-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes hook files that contain the marker", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };

    // Create the hooks first
    const initResult = await initClineHooks(options);
    expect(initResult.created).toHaveLength(8);

    // Remove them
    const deinitResult = await deinitClineHooks(options);
    expect(deinitResult.removed).toHaveLength(8);
    expect(deinitResult.notFound).toHaveLength(0);

    // Verify files are gone
    for (const filePath of initResult.created) {
      expect(fs.existsSync(filePath)).toBe(false);
    }
  });

  it("leaves files without the marker untouched", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };

    // Create hooks dir and put a non-marker file for one hook name
    const hooksDir = resolveHooksDir(options);
    fs.mkdirSync(hooksDir, { recursive: true });

    // Use platform-appropriate extension
    const ext = process.platform === "win32" ? ".ps1" : "";
    const customHookPath = path.join(hooksDir, `TaskStart${ext}`);
    fs.writeFileSync(customHookPath, "#!/usr/bin/env bash\n# Custom hook without marker\necho hello\n");

    const deinitResult = await deinitClineHooks(options);

    // TaskStart should be in notFound (not our file)
    expect(deinitResult.notFound).toContain(customHookPath);
    // The custom file should still exist
    expect(fs.existsSync(customHookPath)).toBe(true);
  });

  it("handles absent hook files (puts them in notFound)", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };

    // Do not create any hooks first
    const result = await deinitClineHooks(options);

    expect(result.removed).toHaveLength(0);
    expect(result.notFound).toHaveLength(8);
  });

  it("returns hooksDir in result", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };
    const result = await deinitClineHooks(options);
    expect(result.hooksDir).toBe(path.join(tmpDir, ".clinerules", "hooks"));
  });

  it("partial removal: only removes our marker files", async () => {
    const options: InitOptions = { global: false, force: false, cwd: tmpDir };
    const hooksDir = resolveHooksDir(options);
    fs.mkdirSync(hooksDir, { recursive: true });

    // Use platform-appropriate extension and script generation
    const ext = process.platform === "win32" ? ".ps1" : "";
    const platform = process.platform === "win32" ? "win32" : "linux";

    // Create 4 files with marker, 4 without
    const withMarker = CLINE_HOOK_NAMES.slice(0, 4);
    const withoutMarker = CLINE_HOOK_NAMES.slice(4);

    for (const hookName of withMarker) {
      const content = generateHookScript(hookName, "gdc", platform);
      fs.writeFileSync(path.join(hooksDir, `${hookName}${ext}`), content);
    }

    for (const hookName of withoutMarker) {
      fs.writeFileSync(path.join(hooksDir, `${hookName}${ext}`), "#!/usr/bin/env bash\n# custom\necho hi\n");
    }

    const result = await deinitClineHooks(options);

    expect(result.removed).toHaveLength(4);
    expect(result.notFound).toHaveLength(4);
  });
});

// ── InitError / DeinitError ──────────────────────────────────────

describe("InitError", () => {
  it("has name 'InitError'", () => {
    const err = new InitError("something failed");
    expect(err.name).toBe("InitError");
  });

  it("extends Error", () => {
    const err = new InitError("something failed");
    expect(err).toBeInstanceOf(Error);
  });

  it("stores cause when provided", () => {
    const cause = new Error("root cause");
    const err = new InitError("wrapper", cause);
    expect(err.cause).toBe(cause);
  });

  it("has correct message", () => {
    const err = new InitError("init failed");
    expect(err.message).toBe("init failed");
  });
});

describe("DeinitError", () => {
  it("has name 'DeinitError'", () => {
    const err = new DeinitError("something failed");
    expect(err.name).toBe("DeinitError");
  });

  it("extends Error", () => {
    const err = new DeinitError("something failed");
    expect(err).toBeInstanceOf(Error);
  });

  it("stores cause when provided", () => {
    const cause = new TypeError("type mismatch");
    const err = new DeinitError("deinit failed", cause);
    expect(err.cause).toBe(cause);
  });

  it("has correct message", () => {
    const err = new DeinitError("deinit failed");
    expect(err.message).toBe("deinit failed");
  });
});
