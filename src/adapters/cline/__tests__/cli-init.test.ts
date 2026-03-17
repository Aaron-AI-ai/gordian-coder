/**
 * Tests for --init / --deinit arg parsing in the Cline CLI adapter.
 *
 * Written first (TDD) - tests define the expected behaviour before
 * the implementation exists.
 *
 * Each test spawns cli.ts as a subprocess and asserts on exit code / stderr.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CLI_PATH = path.resolve(__dirname, "../cli.ts");

/**
 * Spawn the CLI with the given args, optionally inside a temp cwd.
 */
function runCliWithArgs(
  args: string[],
  cwd?: string,
): { stdout: string; stderr: string; exitCode: number | null } {
  const result = spawnSync("bun", ["run", CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
    cwd,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
  };
}

/**
 * Create a fresh temporary directory for each test and clean it up afterward.
 */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gordian-cline-test-"));
}

// ── Helper constants ───────────────────────────────────────────

const HOOK_NAMES = [
  "TaskStart",
  "TaskResume",
  "TaskCancel",
  "TaskComplete",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "PreCompact",
];

// ── Tests ──────────────────────────────────────────────────────

describe("CLI adapter - --init / --deinit arg parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    // Best-effort cleanup; ignore errors (e.g., already removed).
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ── Test 1: --init creates .clinerules/hooks/ with 8 files ───

  it("--init creates .clinerules/hooks/ with 8 hook files in a temp dir", () => {
    const { exitCode, stderr } = runCliWithArgs(["--init"], tmpDir);

    expect(exitCode).toBe(0);

    const hooksDir = path.join(tmpDir, ".clinerules", "hooks");
    expect(fs.existsSync(hooksDir)).toBe(true);

    const files = fs.readdirSync(hooksDir);
    expect(files.length).toBe(8);

    // Each hook name should have a corresponding file.
    for (const hookName of HOOK_NAMES) {
      // On non-Windows the file has no extension; on Windows .ps1 — but
      // tests run on the current platform so we just check file existence.
      const ext = process.platform === "win32" ? ".ps1" : "";
      expect(fs.existsSync(path.join(hooksDir, `${hookName}${ext}`))).toBe(true);
    }

    // stderr should contain a confirmation message.
    expect(stderr).toContain("[gordian-coder:cline]");
  });

  // ── Test 2: --init --force overwrites existing files ─────────

  it("--init --force overwrites existing files and exits 0", () => {
    // First init to create the files.
    runCliWithArgs(["--init"], tmpDir);

    // Second init with --force should succeed (overwrite).
    const { exitCode, stderr } = runCliWithArgs(["--init", "--force"], tmpDir);

    expect(exitCode).toBe(0);
    // All 8 files should appear in the "created" list (overwritten).
    const createdCount = (stderr.match(/^\s+\+/gm) ?? []).length;
    expect(createdCount).toBe(8);
  });

  // ── Test 3: --init without --force skips existing files ──────

  it("--init without --force skips existing files and mentions 'skipped' in stderr", () => {
    // First init creates the files.
    runCliWithArgs(["--init"], tmpDir);

    // Second init without --force should skip all 8.
    const { exitCode, stderr } = runCliWithArgs(["--init"], tmpDir);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("skipped");
  });

  // ── Test 4: --deinit removes generated hooks ─────────────────

  it("--deinit removes all generated hook files", () => {
    // Create the hooks first.
    runCliWithArgs(["--init"], tmpDir);

    const hooksDir = path.join(tmpDir, ".clinerules", "hooks");
    expect(fs.readdirSync(hooksDir).length).toBe(8);

    // Now deinit.
    const { exitCode, stderr } = runCliWithArgs(["--deinit"], tmpDir);

    expect(exitCode).toBe(0);
    // Files should be gone.
    expect(fs.readdirSync(hooksDir).length).toBe(0);
    // stderr should report removal.
    expect(stderr).toContain("[gordian-coder:cline]");
    const removedCount = (stderr.match(/^\s+-\s/gm) ?? []).length;
    expect(removedCount).toBe(8);
  });

  // ── Test 5: --init --deinit together exits with code 1 ───────

  it("--init --deinit together exits with code 1 and an error message", () => {
    const { exitCode, stderr } = runCliWithArgs(["--init", "--deinit"], tmpDir);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("cannot use --init and --deinit together");
  });

  // ── Test 6: no flags still reads stdin (existing behavior) ───

  it("no flags reads stdin and returns JSON (existing hook flow)", () => {
    const payload = JSON.stringify({
      taskId: "test-task-noflag",
      hookName: "TaskStart",
      clineVersion: "3.0.0",
      timestamp: String(Date.now()),
      taskStart: { task: "TDD test" },
    });

    const result = spawnSync("bun", ["run", CLI_PATH], {
      input: payload,
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(output).toHaveProperty("cancel");
    expect(output).toHaveProperty("contextModification");
    expect(output).toHaveProperty("errorMessage");
  });

  // ── Test 7: --init stderr includes the hooks directory path ──

  it("--init stderr output includes the hooks directory path", () => {
    const { exitCode, stderr } = runCliWithArgs(["--init"], tmpDir);

    expect(exitCode).toBe(0);
    const expectedHooksDir = path.join(tmpDir, ".clinerules", "hooks");
    expect(stderr).toContain(expectedHooksDir);
  });

  // ── Test 8: --deinit on empty dir exits 0 (no crash) ─────────

  it("--deinit on empty (no hooks) directory exits 0 without crashing", () => {
    // tmpDir exists but has no .clinerules/hooks/ at all.
    const { exitCode, stderr } = runCliWithArgs(["--deinit"], tmpDir);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("[gordian-coder:cline]");
  });
});
