import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_TOOLS, runReviewTool } from "../index";
import type { ReviewState } from "../../pipeline/state";

const NAMES = ["file_read", "file_read_diff", "file_find", "code_search", "related_code", "git_history"];

describe("REVIEW_TOOLS", () => {
  it("declares every exploration tool exactly once", () => {
    expect(REVIEW_TOOLS.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("tells the model how to target a hunk from file_read", () => {
    // The hint is why read.ts clamps a non-positive start line. It was present
    // in one adapter and missing from the other before the table existed.
    const spec = REVIEW_TOOLS.find((t) => t.name === "file_read")!;
    expect(spec.description).toContain("@@ -x,y +m,n @@");
    expect(spec.description).toContain("start=m-50");
  });

  it("leaves start_line unbounded so the documented m-50 target is accepted", () => {
    // A `min` here would reject the very value file_read's description asks
    // for; read.ts clamps it instead.
    const args = REVIEW_TOOLS.find((t) => t.name === "file_read")!.args;
    expect(args.start_line.min).toBeUndefined();
    expect(args.end_line.min).toBe(1);
  });

  it("bounds the count arguments the way the adapters used to", () => {
    const related = REVIEW_TOOLS.find((t) => t.name === "related_code")!.args;
    const history = REVIEW_TOOLS.find((t) => t.name === "git_history")!.args;
    expect([related.max_results.min, related.max_results.max]).toEqual([1, 30]);
    expect([history.max_commits.min, history.max_commits.max]).toEqual([1, 10]);
  });

  it("describes every argument", () => {
    for (const spec of REVIEW_TOOLS) {
      for (const [name, arg] of Object.entries(spec.args)) {
        expect(arg.description, `${spec.name}.${name}`).toBeTruthy();
      }
    }
  });
});

describe("runReviewTool (against a real repository)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  });

  /** Two committed files, one importing the other, so related_code and
   * git_history have real edges to report. */
  function repo(): string {
    const d = mkdtempSync(join(tmpdir(), "k-tools-"));
    tmps.push(d);
    mkdirSync(join(d, "src"), { recursive: true });
    const git = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: d });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(d, "src/repo.ts"), "export const save = () => true;\n");
    writeFileSync(
      join(d, "src/service.ts"),
      'import { save } from "./repo";\nexport function create() {\n  return save();\n}\n'
    );
    git(["add", "-A"]);
    git(["commit", "-qm", "add service"]);
    return d;
  }

  function state(cwd: string): ReviewState {
    return {
      active: true,
      cwd,
      ref: "HEAD",
      targets: ["src/service.ts"],
      currentIndex: 0,
      iterations: 0,
      toolCalls: 0,
      maxIter: 20,
      maxToolCalls: 20,
      callLog: {},
      dupCalls: {},
      missStreak: 0,
      explorationSealed: false,
      extraRules: [],
      diffMap: { "src/repo.ts": "@@ -1 +1 @@\n+export const save = () => true;" },
    } as unknown as ReviewState;
  }

  it("every tool returns real content for a real file", () => {
    const cwd = repo();
    const st = state(cwd);
    expect(runReviewTool(st, "file_read", { file_path: "src/service.ts" })).toContain("function create");
    expect(runReviewTool(st, "file_read_diff", { path_array: ["src/repo.ts"] })).toContain("+export const save");
    expect(runReviewTool(st, "file_find", { query_name: "service" })).toContain("src/service.ts");
    // The code_search body was the one path no test drove.
    const found = runReviewTool(st, "code_search", { search_text: "save" });
    expect(found).toContain("src/repo.ts");
    expect(found).toContain("src/service.ts");
    expect(runReviewTool(st, "related_code", {})).toContain("src/repo.ts");
    expect(runReviewTool(st, "git_history", {})).toContain("add service");
  });

  it("passes the optional arguments through rather than ignoring them", () => {
    const cwd = repo();
    const st = state(cwd);
    // A line window the caller asked for must actually bound the output.
    const windowed = runReviewTool(st, "file_read", {
      file_path: "src/service.ts",
      start_line: 2,
      end_line: 3,
    });
    expect(windowed).toContain("LINE_RANGE: 2-3");
    expect(windowed).not.toContain("import { save }");

    // Case sensitivity and pathspec reach git grep.
    expect(runReviewTool(st, "code_search", { search_text: "SAVE", case_sensitive: true })).toContain(
      "No matches"
    );
    expect(
      runReviewTool(st, "code_search", { search_text: "save", file_patterns: ["src/repo.ts"] })
    ).not.toContain("src/service.ts");
    // Perl regex vs literal.
    expect(runReviewTool(st, "code_search", { search_text: "sa.e", use_perl_regexp: true })).toContain(
      "src/repo.ts"
    );
    expect(runReviewTool(st, "code_search", { search_text: "sa.e" })).toContain("No matches");

    // file_find honours case_sensitive.
    expect(runReviewTool(st, "file_find", { query_name: "SERVICE", case_sensitive: true })).toContain(
      "No file matches"
    );
  });

  it("uses an explicit file_path over the file under review", () => {
    const cwd = repo();
    const st = state(cwd);
    expect(runReviewTool(st, "related_code", { file_path: "src/repo.ts" })).toContain("src/service.ts");
    expect(runReviewTool(st, "git_history", { file_path: "src/repo.ts" })).toContain("add service");
  });

  it("counts every call against the exploration budget", () => {
    const cwd = repo();
    const st = state(cwd);
    for (const name of ["file_read", "code_search", "file_find", "related_code", "git_history"]) {
      runReviewTool(st, name, { file_path: "src/service.ts", search_text: "save", query_name: "repo" });
    }
    expect(st.iterations).toBe(5);
    expect(Object.keys(st.callLog["src/service.ts"] ?? {}).sort()).toEqual([
      "code_search",
      "file_find",
      "file_read",
      "git_history",
      "related_code",
    ]);
  });
});

describe("runReviewTool", () => {
  it("refuses every tool when no review is active", () => {
    for (const name of NAMES) {
      expect(runReviewTool(undefined, name, {})).toContain("No active review");
    }
  });

  it("reports an unknown tool instead of throwing", () => {
    const st = { active: true } as ReviewState;
    expect(runReviewTool(st, "nope", {})).toContain("Unknown review tool");
  });

  it("does not spend exploration budget when there is no file to act on", () => {
    // related_code / git_history default to the file under review; with none,
    // the call must not count against the iteration budget.
    const st = {
      active: true,
      cwd: process.cwd(),
      ref: null,
      iterations: 0,
      toolCalls: 0,
      callLog: {},
      targets: [],
      currentIndex: 0,
      extraRules: [],
    } as unknown as ReviewState;
    expect(runReviewTool(st, "related_code", {})).toBe("No current file under review.");
    expect(st.iterations).toBe(0);
  });
});
