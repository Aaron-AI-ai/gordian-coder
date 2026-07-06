import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setState,
  getState,
  clearState,
  currentFile,
  otherFiles,
  isDone,
  type ReviewState,
} from "../state";
import { MAX_ITER } from "../reader";
import { startReview, submitReview, reviewPromptFor, NO_ACTIVE_REVIEW } from "../loop";
import { REQUIRED_CATEGORIES } from "../contract";

function baseState(over: Partial<ReviewState> = {}): ReviewState {
  return {
    active: true,
    cwd: ".",
    targets: ["a.ts", "b.ts"],
    currentIndex: 0,
    categories: ["security"],
    diffRange: null,
    ref: null,
    diffMap: {},
    systemRule: "",
    frameworkRules: "",
    requirementBackground: "",
    planGuidance: "",
    findings: {},
    baseline: new Set<string>(),
    label: "L",
    language: "ko",
    iterations: 0,
    ...over,
  };
}

describe("state", () => {
  it("stores and retrieves by sessionId", () => {
    setState("s1", baseState());
    expect(getState("s1")?.targets).toEqual(["a.ts", "b.ts"]);
    clearState("s1");
    expect(getState("s1")).toBeUndefined();
  });

  it("currentFile/otherFiles track the pointer", () => {
    const st = baseState({ currentIndex: 1 });
    expect(currentFile(st)).toBe("b.ts");
    expect(otherFiles(st)).toEqual(["a.ts"]);
  });

  it("isDone when the index runs past targets", () => {
    expect(isDone(baseState({ currentIndex: 2 }))).toBe(true);
    expect(isDone(baseState({ currentIndex: 1 }))).toBe(false);
  });

  it("MAX_ITER is a positive guard", () => {
    expect(MAX_ITER).toBeGreaterThan(0);
  });
});

describe("startReview / submitReview (full loop)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    clearState("t");
    while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  });

  function gitRepo(): string {
    const d = mkdtempSync(join(tmpdir(), "k-loop-"));
    tmps.push(d);
    const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
    sh(["git", "init", "-q"]);
    sh(["git", "config", "user.email", "t@t"]);
    sh(["git", "config", "user.name", "t"]);
    writeFileSync(join(d, "a.ts"), "a1\n");
    writeFileSync(join(d, "b.ts"), "b1\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "init"]);
    writeFileSync(join(d, "a.ts"), "a2\n");
    writeFileSync(join(d, "b.ts"), "b2\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "change"]);
    return d;
  }

  const fullSubmit = (file: string) => ({
    assessed: [...REQUIRED_CATEGORIES],
    findings: [
      {
        category: "correctness",
        severity: "major",
        file,
        line: 1,
        rule: "r1",
        message: "issue",
      },
    ],
  });

  it("runs start → gate → advance → report with verdict", async () => {
    const d = gitRepo();
    const msg = await startReview({ failOn: "major" }, d, "t");
    expect(msg).toContain("Queued 2 file(s)");
    const st = getState("t")!;
    expect(st.targets).toEqual(["a.ts", "b.ts"]);
    expect(reviewPromptFor(st)).toContain("<current_file_path>a.ts</current_file_path>");

    // incomplete coverage → gate holds
    const gated = await submitReview({ assessed: ["security"], findings: [] }, "t");
    expect(gated).toContain("Incomplete");
    expect(getState("t")!.currentIndex).toBe(0);

    // full coverage → advance to b.ts
    const advanced = await submitReview(fullSubmit("a.ts"), "t");
    expect(advanced).toContain("Next file: b.ts");

    // last file → report written, verdict FAIL (one major ≥ major)
    const done = await submitReview(fullSubmit("b.ts"), "t");
    expect(done).toContain("Review complete");
    expect(done).toContain("Verdict: FAIL");
    expect(getState("t")).toBeUndefined();

    const report = /Report: (.+)$/.exec(done)![1];
    const md = readFileSync(join(d, report), "utf8");
    expect(md).toContain("**Verdict: FAIL**");
    expect(md).toContain("## a.ts");
    expect(existsSync(join(d, report.replace(/\.md$/, "-targets.md")))).toBe(true);
  });

  it("submit without an active review is rejected", async () => {
    expect(await submitReview({ assessed: [], findings: [] }, "nope")).toBe(NO_ACTIVE_REVIEW);
  });
});
