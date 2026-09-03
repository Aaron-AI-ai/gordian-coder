import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyFixes,
  fixContext,
  fixCoverage,
  loadFixes,
  submitFix,
  FIX_MAX_ITEMS,
} from "../fixer";
import { createRun } from "../run-store";
import { runDir } from "../artifact";
import { fcqFindings } from "../../evidence/fcq";
import type { FcqFileViolation } from "../../evidence/fcq";
import type { Finding } from "../../contract";

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "k-fixer-"));
  tmps.push(d);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src/A.java"), "class A {\n  /* block */\n  int x;\n}\n");
  return d;
}

const VIOLATION: FcqFileViolation = {
  analyzer: "checkstyle",
  ruleId: "NoBlockComment",
  description: "블록 주석 금지",
  category: "code-style",
  severity: "MINOR",
  line: 2,
  message: "block comment",
  snippet: ["  /* block */"],
};

/** A planned run with an fcq shard already written for src/A.java. */
async function run(
  cwd: string,
  violations: FcqFileViolation[] = [VIOLATION]
): Promise<string> {
  const meta = await createRun(
    {
      targets: ["src/A.java"],
      range: null,
      whole: true,
      label: "t",
      language: "en",
      fcq: { status: "ok", command: "fcq", durationMs: 1, reportPath: "r" },
    } as never,
    cwd
  );
  const dir = join(runDir(meta.runId, cwd), "fcq", "files");
  mkdirSync(dir, { recursive: true });
  // Mirror fcq.ts's shard naming via the same slug the reader uses.
  const { fcqShardPath } = await import("../../evidence/fcq");
  writeFileSync(fcqShardPath(runDir(meta.runId, cwd), "src/A.java"), JSON.stringify(violations));
  return meta.runId;
}

describe("fixContext", () => {
  it("hands over the source and every violation, MINOR included", async () => {
    const cwd = repo();
    const runId = await run(cwd);
    const ctx = fixContext(runId, "src/A.java", cwd);
    expect(ctx).toContain("NoBlockComment");
    expect(ctx).toContain("블록 주석 금지");
    expect(ctx).toContain("class A {"); // the source itself
    // The whole point of the pass: MINOR hits get real code, not rule text.
    expect(ctx).toContain("whatever its severity");
    expect(ctx).toContain("f_review_fix_submit");
  });

  it("refuses a file that is not a target, and a run without fcq", async () => {
    const cwd = repo();
    const runId = await run(cwd);
    expect(fixContext(runId, "src/Other.java", cwd)).toContain("not a target");
    expect(fixContext("nope", "src/A.java", cwd)).toContain("Unknown run");
  });

  it("tells the fixer to skip a file with no violations", async () => {
    const cwd = repo();
    const runId = await run(cwd, []);
    expect(fixContext(runId, "src/A.java", cwd)).toContain("no fcq violations");
  });
});

describe("submitFix", () => {
  it("records fixes and reports what the file still lacks", async () => {
    const cwd = repo();
    const runId = await run(cwd, [VIOLATION, { ...VIOLATION, line: 3, ruleId: "Other" }]);
    const out = await submitFix(
      { runId, file: "src/A.java", fixes: [{ line: 2, ruleId: "NoBlockComment", asIs: "/* block */", toBe: "// block" }] },
      cwd
    );
    expect(out).toContain("1 fix(es) recorded");
    // Silence here would ship a violation with only its rule text.
    expect(out).toContain("1 violation(s) received no entry");
    expect(loadFixes(runId, "src/A.java", cwd).fixes).toHaveLength(1);
  });

  it("rejects a malformed submission and an unknown target", async () => {
    const cwd = repo();
    const runId = await run(cwd);
    expect(await submitFix({ runId, file: "src/A.java" }, cwd)).toContain("Invalid fix submission");
    expect(await submitFix({ runId, file: "src/X.java", fixes: [] }, cwd)).toContain("not a target");
    expect(loadFixes(runId, "src/A.java", cwd).fixes).toEqual([]);
  });

  it("caps a runaway submission", async () => {
    const cwd = repo();
    const runId = await run(cwd);
    const many = Array.from({ length: FIX_MAX_ITEMS + 10 }, (_, i) => ({
      line: i + 1,
      ruleId: `R${i}`,
      toBe: "x",
    }));
    await submitFix({ runId, file: "src/A.java", fixes: many }, cwd);
    expect(loadFixes(runId, "src/A.java", cwd).fixes).toHaveLength(FIX_MAX_ITEMS);
  });

  it("returns empty fixes when the pass never ran", async () => {
    const cwd = repo();
    const runId = await run(cwd);
    expect(loadFixes(runId, "src/A.java", cwd)).toEqual({ file: "src/A.java", fixes: [] });
    expect(existsSync(join(runDir(runId, cwd), "fixes"))).toBe(false);
  });
});

describe("applyFixes", () => {
  const rows = (): Finding[] => fcqFindings("src/A.java", [VIOLATION]);

  it("replaces the rule-text placeholder with real code", () => {
    // Before the fix pass a MINOR row's TO-BE is the rule description.
    expect(rows()[0]!.toBe).toBe("블록 주석 금지");
    const out = applyFixes(rows(), [
      { line: 2, ruleId: "NoBlockComment", asIs: "/* block */", toBe: "// block" },
    ]);
    expect(out[0]!.toBe).toBe("// block");
    expect(out[0]!.asIs).toBe("/* block */");
  });

  it("anchors on line AND rule id", () => {
    const wrongLine = applyFixes(rows(), [{ line: 9, ruleId: "NoBlockComment", toBe: "x" }]);
    const wrongRule = applyFixes(rows(), [{ line: 2, ruleId: "Other", toBe: "x" }]);
    expect(wrongLine[0]!.toBe).toBe("블록 주석 금지");
    expect(wrongRule[0]!.toBe).toBe("블록 주석 금지");
  });

  it("keeps a false positive visible instead of dropping the row", () => {
    const out = applyFixes(rows(), [
      { line: 2, ruleId: "NoBlockComment", falsePositive: true, note: "generated file" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.toBe).toContain("false positive");
    expect(out[0]!.toBe).toContain("generated file");
  });

  it("leaves findings untouched when the pass produced nothing", () => {
    expect(applyFixes(rows(), [])).toEqual(rows());
  });
});

describe("fixCoverage", () => {
  it("counts violations against fixes that carry code or a verdict", async () => {
    const cwd = repo();
    const runId = await run(cwd, [VIOLATION, { ...VIOLATION, line: 3, ruleId: "Other" }]);
    await submitFix(
      {
        runId,
        file: "src/A.java",
        fixes: [
          { line: 2, ruleId: "NoBlockComment", toBe: "// block" },
          { line: 3, ruleId: "Other", toBe: "   " }, // whitespace is not a fix
        ],
      },
      cwd
    );
    expect(fixCoverage(runId, ["src/A.java"], cwd)).toEqual([
      { file: "src/A.java", violations: 2, fixed: 1 },
    ]);
  });
});
