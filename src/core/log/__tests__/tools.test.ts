import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_TOOLS, LOG_EXPLORERS, runLogTool, findCallers, gitBlame, NO_ACTIVE_LOG } from "../tools";
import { newLogSession } from "../state";
import { MAX_DUP_CALLS } from "../../guard";

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "f-log-tools-"));
  mkdirSync(join(cwd, "src/a"), { recursive: true });
  writeFileSync(join(cwd, "src/a/Svc.java"), "class Svc {\n  void run() { helper.save(1); }\n  void other() { helper.save(2); }\n}\n");
  writeFileSync(join(cwd, "src/a/Helper.java"), "class Helper {\n  void save(int x) {}\n}\n");
  const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=tester", ...args], { cwd });
  git(["init", "-q"]);
  git(["add", "."]);
  git(["commit", "-qm", "add svc"]);
  return cwd;
}

describe("f-log tools", () => {
  const cwd = repo();

  test("seven tools, all prefixed f_log_, all explorers", () => {
    expect(LOG_TOOLS.map((t) => t.name).sort()).toEqual(
      ["f_log_blame", "f_log_callers", "f_log_find", "f_log_history", "f_log_read", "f_log_related", "f_log_search"]
    );
    for (const t of LOG_TOOLS) expect(LOG_EXPLORERS.has(t.name)).toBe(true);
  });

  test("findCallers lists call sites of .method( with file:line, capped", () => {
    const out = findCallers(cwd, "save");
    expect(out).toContain("src/a/Svc.java:2");
    expect(out).toContain("src/a/Svc.java:3");
    expect(findCallers(cwd, "nothingHere")).toMatch(/^No callers found/);
    expect(findCallers(cwd, "save", 1).split("\n").filter((l) => l.includes("Svc.java")).length).toBe(1);
  });

  test("gitBlame returns commit, author and the line's history", () => {
    const out = gitBlame(cwd, "src/a/Svc.java", 2);
    expect(out).toContain("tester");
    expect(out).toContain("add svc");
    expect(gitBlame(cwd, "src/a/Nope.java", 1)).toMatch(/^No blame available/);
  });

  test("runLogTool: inactive → NO_ACTIVE_LOG; guarded; duplicate withheld with f_log_submit advice", () => {
    expect(runLogTool(undefined, "f_log_read", {})).toBe(NO_ACTIVE_LOG);
    const st = newLogSession(cwd, "run-1", 1, 10, 20);
    const args = { file_path: "src/a/Svc.java" };
    for (let i = 0; i < MAX_DUP_CALLS; i++) expect(runLogTool(st, "f_log_read", args)).toContain("class Svc");
    const withheld = runLogTool(st, "f_log_read", args);
    expect(withheld).toContain("Duplicate call");
    expect(withheld).toContain("f_log_submit");
    expect(st.callLog["run-1"].f_log_read).toBe(MAX_DUP_CALLS + 1);
    expect(runLogTool(st, "unknown_tool", {})).toContain("Unknown");
  });
});
