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
  FIX_FILE_MAX_LINES,
  FIX_CONTEXT_MAX_BYTES,
  fixWindows,
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

  it("says the context is all the code there is", async () => {
    // The fixer has no read tools: a fixer granted file_read got "No active
    // review" on every call and retried 35 times. The context has to be
    // self-sufficient and say so.
    const cwd = repo();
    const runId = await run(cwd);
    const ctx = fixContext(runId, "src/A.java", cwd);
    expect(ctx).toContain("This is the complete file");
    expect(ctx).toContain("no read tools");
  });

  it("shows the file up to FIX_FILE_MAX_LINES, not the reader's default", async () => {
    // Regression: FIX_FILE_MAX_LINES was passed as end_line only, so fileRead's
    // own 500-line default still applied and the constant was a lie.
    const cwd = repo();
    writeFileSync(
      join(cwd, "src/Big.java"),
      Array.from({ length: 900 }, (_, i) => `int v${i} = ${i};`).join("\n") + "\n"
    );
    const meta = await createRun(
      {
        targets: ["src/Big.java"],
        range: null,
        whole: true,
        label: "t",
        language: "en",
        fcq: { status: "ok", command: "fcq", durationMs: 1, reportPath: "r" },
      } as never,
      cwd
    );
    const { fcqShardPath } = await import("../../evidence/fcq");
    mkdirSync(join(runDir(meta.runId, cwd), "fcq", "files"), { recursive: true });
    writeFileSync(
      fcqShardPath(runDir(meta.runId, cwd), "src/Big.java"),
      JSON.stringify([{ ...VIOLATION, line: 800 }])
    );
    const ctx = fixContext(meta.runId, "src/Big.java", cwd);
    expect(ctx).toContain("LINE_RANGE: 1-900");
    expect(ctx).toContain("int v899");
    expect(ctx).toContain("This is the complete file");
  });

  it("keeps a large file under the host's tool-output ceiling and says what is visible", async () => {
    // Regression: a 1431-line file produced ~59KB of source, OpenCode's tool
    // output store cut it at 51200 bytes mid-file, and the context still said
    // "This is the complete file" — the fixer cannot read, so it fixed code it
    // could not see.
    const cwd = repo();
    const lines = Array.from(
      { length: 1431 },
      (_, i) => `  private final String field${i} = "some padding to make the line realistic ${i}";`
    );
    writeFileSync(join(cwd, "src/Wide.java"), lines.join("\n") + "\n");
    const meta = await createRun(
      {
        targets: ["src/Wide.java"],
        range: null,
        whole: true,
        label: "t",
        language: "en",
        fcq: { status: "ok", command: "fcq", durationMs: 1, reportPath: "r" },
      } as never,
      cwd
    );
    const { fcqShardPath } = await import("../../evidence/fcq");
    mkdirSync(join(runDir(meta.runId, cwd), "fcq", "files"), { recursive: true });
    writeFileSync(
      fcqShardPath(runDir(meta.runId, cwd), "src/Wide.java"),
      JSON.stringify([
        { ...VIOLATION, line: 12 },
        { ...VIOLATION, line: 1400 },
      ])
    );
    const ctx = fixContext(meta.runId, "src/Wide.java", cwd);
    expect(Buffer.byteLength(ctx, "utf8")).toBeLessThanOrEqual(FIX_CONTEXT_MAX_BYTES);
    expect(ctx).not.toContain("This is the complete file");
    expect(ctx).toContain("too large to show whole");
    // Both violations must still be fixable: the late one is the whole point.
    expect(ctx).toContain("field1400");
    expect(ctx).toContain("field12 ");
    expect(ctx).toContain("Every listed violation is inside a range above.");
  });

  it("merges overlapping violation windows and clamps them to the file", () => {
    expect(fixWindows([50, 60, 400], 500, 20)).toEqual([
      [30, 80],
      [380, 420],
    ]);
    expect(fixWindows([5, 495], 500, 20)).toEqual([
      [1, 25],
      [475, 500],
    ]);
  });

  it("warns when the file is longer than the fixer can be shown", async () => {
    const cwd = repo();
    writeFileSync(
      join(cwd, "src/Huge.java"),
      Array.from({ length: FIX_FILE_MAX_LINES + 50 }, (_, i) => `int v${i} = ${i};`).join("\n") + "\n"
    );
    const meta = await createRun(
      {
        targets: ["src/Huge.java"],
        range: null,
        whole: true,
        label: "t",
        language: "en",
        fcq: { status: "ok", command: "fcq", durationMs: 1, reportPath: "r" },
      } as never,
      cwd
    );
    const { fcqShardPath } = await import("../../evidence/fcq");
    mkdirSync(join(runDir(meta.runId, cwd), "fcq", "files"), { recursive: true });
    writeFileSync(
      fcqShardPath(runDir(meta.runId, cwd), "src/Huge.java"),
      JSON.stringify([{ ...VIOLATION, line: 10 }])
    );
    const ctx = fixContext(meta.runId, "src/Huge.java", cwd);
    // Silence here would have the fixer inventing code for lines it never saw.
    expect(ctx).toContain("too large to show whole");
    expect(ctx).toContain("Only these line ranges are below: L1-50");
    expect(ctx).toContain("10|int v9");
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

  it("fills in the TO-BE the fcq row does not have", () => {
    // fcq has no fix text, so an unfixed row carries none — its requirement
    // reaches the reader through `message`, not through a code block.
    expect(rows()[0]!.toBe).toBeUndefined();
    expect(rows()[0]!.message).toContain("block comment");
    const out = applyFixes(rows(), [
      { line: 2, ruleId: "NoBlockComment", asIs: "/* block */", toBe: "// block" },
    ]);
    expect(out[0]!.toBe).toBe("// block");
    expect(out[0]!.asIs).toBe("/* block */");
  });

  it("anchors on line AND rule id", () => {
    const wrongLine = applyFixes(rows(), [{ line: 9, ruleId: "NoBlockComment", toBe: "x" }]);
    const wrongRule = applyFixes(rows(), [{ line: 2, ruleId: "Other", toBe: "x" }]);
    expect(wrongLine[0]!.toBe).toBeUndefined();
    expect(wrongRule[0]!.toBe).toBeUndefined();
  });

  it("keeps a false positive visible, in the message rather than as code", () => {
    const out = applyFixes(rows(), [
      { line: 2, ruleId: "NoBlockComment", falsePositive: true, note: "generated file" },
    ]);
    expect(out).toHaveLength(1);
    // Not in toBe: the report renders that as a code block to paste.
    expect(out[0]!.toBe).toBeUndefined();
    expect(out[0]!.message).toContain("오탐");
    expect(out[0]!.message).toContain("generated file");
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
