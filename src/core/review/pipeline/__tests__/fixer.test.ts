import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyFixes,
  fixContext,
  fixCoverage,
  fixPartPlan,
  loadFixes,
  submitFix,
  unfixedFixParts,
  FIX_MAX_ITEMS,
  FIX_FILE_MAX_LINES,
  FIX_CONTEXT_MAX_BYTES,
  fixWindows,
} from "../fixer";
import { createRun } from "../run-store";
import { renderPlanInstructions } from "../run";
import { loadRun, runDir } from "../artifact";
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
  it("sends the fixer back for the violations it left out, once", async () => {
    const cwd = repo();
    const runId = await run(cwd, [VIOLATION, { ...VIOLATION, line: 3, ruleId: "Other" }]);
    const first = { line: 2, ruleId: "NoBlockComment", asIs: "/* block */", toBe: "// block" };
    const out = await submitFix({ runId, file: "src/A.java", fixes: [first] }, cwd);
    expect(out).toContain("1 fix(es) recorded");
    // Naming the gap and calling the task done in the same breath is what let a
    // violation needing a refactor rather than a snippet swap ship unfixed.
    expect(out).toContain("L3");
    expect(out).not.toContain("COMPLETE");
    expect(loadFixes(runId, "src/A.java", cwd).fixes).toHaveLength(1);

    // Second submission: the gap is reported, but the fixer is not looped on it.
    const again = await submitFix({ runId, file: "src/A.java", fixes: [first] }, cwd);
    expect(again).toContain("1 violation(s) still have no entry");
    expect(again).toContain("COMPLETE");
  });

  it("matches entries by anchor, not by count", async () => {
    const cwd = repo();
    const runId = await run(cwd, [VIOLATION, { ...VIOLATION, line: 3, ruleId: "Other" }]);
    // Two entries for one violation used to net out against the one with none.
    const out = await submitFix(
      {
        runId,
        file: "src/A.java",
        fixes: [
          { line: 2, ruleId: "checkstyle/NoBlockComment", toBe: "// block" },
          { line: 2, ruleId: "NoBlockComment", toBe: "// block" },
        ],
      },
      cwd
    );
    expect(out).toContain("L3");
    expect(out).not.toContain("COMPLETE");
  });

  it("accepts a note-only entry as an entry", async () => {
    const cwd = repo();
    const runId = await run(cwd, [VIOLATION]);
    const out = await submitFix(
      {
        runId,
        file: "src/A.java",
        fixes: [{ line: 2, ruleId: "NoBlockComment", note: "extract the mapper call" }],
      },
      cwd
    );
    expect(out).toContain("COMPLETE");
    expect(out).not.toContain("NO entry");
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
    expect(loadFixes(runId, "src/A.java", cwd)).toEqual({ file: "src/A.java", fixes: [], dropped: 0 });
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
      { file: "src/A.java", violations: 2, fixed: 1, dropped: 0 },
    ]);
  });
});

describe("fixer part 분할", () => {
  /** n건의 위반과 1400줄 소스를 가진 런. */
  async function bigFixRun(n: number): Promise<{ d: string; runId: string }> {
    const d = repo();
    writeFileSync(
      join(d, "src/Big.java"),
      Array.from({ length: 1400 }, (_, i) => `  int f${i}() { return ${i}; } // 설명 주석`).join("\n") + "\n"
    );
    const meta = await createRun(
      {
        targets: ["src/Big.java"],
        range: null,
        whole: true,
        label: "L",
        language: "ko",
        fcqFix: true,
        fcq: { status: "ok", command: "fcq", durationMs: 1, reportPath: "r" },
      } as never,
      d
    );
    const rows: FcqFileViolation[] = Array.from({ length: n }, (_, i) => ({
      ...VIOLATION,
      ruleId: `Rule${i}`,
      line: 1 + i * 20,
      description: "설명 ".repeat(40),
      message: "메시지 ".repeat(40),
      snippet: ["코드 한 줄 ".repeat(10), "코드 두 줄 ".repeat(10)],
    }));
    const { fcqShardPath } = await import("../../evidence/fcq");
    mkdirSync(join(runDir(meta.runId, d), "fcq", "files"), { recursive: true });
    writeFileSync(fcqShardPath(runDir(meta.runId, d), "src/Big.java"), JSON.stringify(rows));
    return { d, runId: meta.runId };
  }

  it("위반이 60건이어도 소스를 한 줄도 못 보는 일이 없다", async () => {
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    expect(plan.length).toBeGreaterThan(1);
    for (let part = 0; part < plan.length; part++) {
      const ctx = fixContext(runId, "src/Big.java", d, part);
      // fixSource가 윈도우를 하나도 못 실었을 때 내놓는 문구. 브리프의
      // "ranges below: none"은 실제 출력("line ranges are below:")과 달라
      // 항상 통과하는 빈 단정이었다.
      expect(ctx).not.toContain("are below: none");
      expect(Buffer.byteLength(ctx, "utf8")).toBeLessThanOrEqual(FIX_CONTEXT_MAX_BYTES);
      // 이 part의 위반은 전부 보이는 범위 안에 있어야 한다.
      expect(ctx).toContain("Every listed violation is inside a range above.");
    }
  });

  it("모든 위반이 정확히 한 part에 배정된다", async () => {
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    expect(plan.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it("범위 밖 part를 요구하면 거절한다", async () => {
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    // 판정 경로에서 범위 밖 part가 프롬프트 조립까지 흘러가 리뷰를 영구
    // 종료시킨 적이 있다. 여기서는 조립 전에 막혀야 한다.
    expect(fixContext(runId, "src/Big.java", d, plan.length)).toContain("does not exist");
    expect(fixContext(runId, "src/Big.java", d, -1)).toContain("does not exist");
  });

  it("정수가 아닌 part는 TypeError가 아니라 거절로 끝난다", async () => {
    const { d, runId } = await bigFixRun(60);
    expect(fixContext(runId, "src/Big.java", d, 1.5)).toContain("does not exist");
  });

  it("위반이 적으면 part 하나로 끝나고 기존 컨텍스트와 같다", async () => {
    const { d, runId } = await bigFixRun(3);
    expect(fixPartPlan(runId, "src/Big.java", d)).toHaveLength(1);
    const whole = fixContext(runId, "src/Big.java", d);
    expect(whole).toBe(fixContext(runId, "src/Big.java", d, 0));
    // part가 하나면 part 개념 자체가 드러나지 않는다.
    expect(whole).not.toContain("part 1/1");
    expect(whole).not.toContain("fixed in");
  });

  it("같은 part의 두 번째 제출이 첫 제출의 fix를 지우지 않는다", async () => {
    // part를 선언하게 된 뒤 이 테스트는 같은-part 경로만 지난다. 교차 part
    // 보장은 바로 아래 테스트가 따로 지킨다.
    const { d, runId } = await bigFixRun(60);
    await submitFix(
      { runId, file: "src/Big.java", part: 0, fixes: [{ line: 1, ruleId: "Rule0", asIs: "a", toBe: "b" }] },
      d
    );
    await submitFix(
      { runId, file: "src/Big.java", part: 0, fixes: [{ line: 21, ruleId: "Rule1", asIs: "c", toBe: "d" }] },
      d
    );
    const fixes = loadFixes(runId, "src/Big.java", d).fixes;
    expect(fixes.map((f) => f.ruleId).sort()).toEqual(["Rule0", "Rule1"]);
  });

  it("따로 제출된 part 0과 part 1의 fix가 둘 다 남는다", async () => {
    // 분할 fix pass 전체가 이 보장 위에 서 있다 — Task 7 전에는 part 2가 part 1의
    // 작업을 지웠다. part 선언이 들어오면서 이 성질을 짚던 테스트가 같은-part
    // 경로로 옮겨갔고, 병합 코드는 part로 분기하지 않으므로 아무도 이 경우를
    // 밟지 않게 됐다.
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    const entry = (i: number) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: `fix${i}` });
    await submitFix({ runId, file: "src/Big.java", part: 0, fixes: plan[0]!.map(entry) }, d);
    await submitFix({ runId, file: "src/Big.java", part: 1, fixes: plan[1]!.map(entry) }, d);

    const fixes = loadFixes(runId, "src/Big.java", d).fixes;
    // 개수가 아니라 앵커로 본다: 엉뚱한 항목을 남긴 병합도 수는 맞을 수 있다.
    const anchors = new Set(fixes.map((f) => `${f.line}/${f.ruleId}`));
    for (const i of [...plan[0]!, ...plan[1]!]) {
      expect(anchors.has(`${1 + i * 20}/Rule${i}`), `Rule${i} must survive the merge`).toBe(true);
    }
    expect(fixes).toHaveLength(plan[0]!.length + plan[1]!.length);
    // 내용까지 그대로여야 한다 — 앵커만 남고 코드가 바뀌면 리포트가 거짓말을 한다.
    const first = plan[0]![0]!;
    expect(fixes.find((f) => f.ruleId === `Rule${first}`)!.toBe).toBe(`fix${first}`);
  });

  it("같은 앵커를 다시 제출하면 덮어쓴다", async () => {
    const { d, runId } = await bigFixRun(60);
    await submitFix(
      { runId, file: "src/Big.java", part: 0, fixes: [{ line: 1, ruleId: "Rule0", asIs: "a", toBe: "처음" }] },
      d
    );
    await submitFix(
      { runId, file: "src/Big.java", part: 0, fixes: [{ line: 1, ruleId: "Rule0", asIs: "a", toBe: "나중" }] },
      d
    );
    const fixes = loadFixes(runId, "src/Big.java", d).fixes;
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.toBe).toBe("나중");
  });

  it("앞 part로 삐져나간 항목 하나가 뒤 part의 재요청을 삼키지 않는다", async () => {
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    const entry = (i: number) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: "x" });
    // part 0은 자기 몫을 다 채워 기록을 남긴다.
    await submitFix({ runId, file: "src/Big.java", part: 0, fixes: plan[0]!.map(entry) }, d);
    // part 1은 자기 항목 하나를 빠뜨린 채, part 0의 앵커 하나를 함께 낸다.
    const skipped = plan[1]![0]!;
    const out = await submitFix(
      {
        runId,
        file: "src/Big.java",
        part: 1,
        fixes: [entry(plan[0]![0]!), ...plan[1]!.slice(1).map(entry)],
      },
      d
    );
    // part 0이 이미 기록됐다는 이유로 part 1의 진짜 누락이 COMPLETE 처리되면
    // 그 위반은 아무 fixer도 다시 보지 않는다.
    expect(out).toContain("NO entry");
    expect(out).toContain(`L${1 + skipped * 20} `);
    expect(out).not.toContain("COMPLETE");
    // 이미 기록된 part 0의 fix가 미기입으로 다시 세어지면 안 된다.
    expect(out).toContain("1 violation(s) got NO entry");
  });

  it("줄 번호와 규칙 사이 경계가 두 앵커를 뭉개지 않는다", async () => {
    // L1 + "1Foo" 와 L11 + "Foo". 구분자가 없으면 둘 다 "11foo"가 되고,
    // 병합이 앵커 단위인 지금은 한쪽이 다른 쪽을 조용히 덮어쓴다 — 그 위반은
    // fix 없이 나가는데 fixCoverage는 항목 수만 세므로 fixWarn도 안 뜬다.
    const cwd = repo();
    const runId = await run(cwd, [
      { ...VIOLATION, line: 1, ruleId: "1Foo" },
      { ...VIOLATION, line: 11, ruleId: "Foo" },
    ]);
    await submitFix({ runId, file: "src/A.java", fixes: [{ line: 1, ruleId: "1Foo", toBe: "가" }] }, cwd);
    await submitFix({ runId, file: "src/A.java", fixes: [{ line: 11, ruleId: "Foo", toBe: "나" }] }, cwd);
    const fixes = loadFixes(runId, "src/A.java", cwd).fixes;
    expect(fixes).toHaveLength(2);
    expect(fixes.map((f) => f.toBe)).toEqual(["가", "나"]);
    expect(fixCoverage(runId, ["src/A.java"], cwd)).toEqual([
      { file: "src/A.java", violations: 2, fixed: 2, dropped: 0 },
    ]);
  });

  it("part 하나를 낸 fixer에게 다른 part의 위반을 채우라고 하지 않는다", async () => {
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    const first = plan[0]!.map((i) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: "x" }));
    const out = await submitFix({ runId, file: "src/Big.java", part: 0, fixes: first }, d);
    // 못 본 코드에 fix를 써 넣으라는 지시가 바로 이 pass가 없애려는 실패다.
    expect(out).not.toContain("NO entry");
    expect(out).toContain("COMPLETE");
  });

  it("선언된 part가 제출 범위를 정한다 — 앞 part의 헛짚은 앵커가 뒤 part의 재요청을 삼키지 않는다", async () => {
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    const entry = (i: number) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: "x" });
    const strayIndex = plan[1]![0]!;
    // part 0의 fixer가 자기 몫을 다 채우면서, 본 적도 없는 part 1의 앵커를
    // 하나 지어낸다. 앵커 추론만으로는 이 한 줄이 part 1을 "이미 제출됨"으로
    // 만들어 다음 fixer의 재요청을 삼켰다.
    const first = await submitFix(
      { runId, file: "src/Big.java", part: 0, fixes: [...plan[0]!.map(entry), entry(strayIndex)] },
      d
    );
    expect(first).toContain("COMPLETE");
    // 지어낸 앵커는 저장되지 않는다. 남으면 part 1의 진짜 위반이 이미 고쳐진
    // 것처럼 보이고, finalize가 그 코드를 리포트에 그대로 싣는다.
    expect(loadFixes(runId, "src/Big.java", d).fixes.map((f) => f.ruleId)).not.toContain(
      `Rule${strayIndex}`
    );

    // part 1의 fixer가 자기 항목 하나를 빠뜨린 채 제출한다 — 돌려보내야 한다.
    const skipped = plan[1]![1]!;
    const out = await submitFix(
      {
        runId,
        file: "src/Big.java",
        part: 1,
        fixes: plan[1]!.filter((i) => i !== skipped).map(entry),
      },
      d
    );
    expect(out).toContain("NO entry");
    expect(out).toContain(`L${1 + skipped * 20} `);
    expect(out).not.toContain("COMPLETE");
  });

  it("선언된 part는 자기 몫만 본다 — 다른 part의 미기입을 자기에게 떠넘기지 않는다", async () => {
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    const entry = (i: number) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: "x" });
    const out = await submitFix(
      { runId, file: "src/Big.java", part: 0, fixes: plan[0]!.map(entry) },
      d
    );
    expect(out).not.toContain("NO entry");
    expect(out).toContain("COMPLETE");
  });

  it("범위 밖 part를 선언하면 거절하고 아무것도 기록하지 않는다", async () => {
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    const out = await submitFix(
      {
        runId,
        file: "src/Big.java",
        part: plan.length,
        fixes: [{ line: 1, ruleId: "Rule0", toBe: "x" }],
      },
      d
    );
    expect(out).toContain("does not exist");
    expect(loadFixes(runId, "src/Big.java", d).fixes).toHaveLength(0);
  });

  it("분할된 파일은 part 선언 없이는 제출을 거절한다", async () => {
    // 앵커 추론은 프롬프트가 part를 실어 보낼 때만 우회된다. 프롬프트는 게이트가
    // 아니다 — part 0이 선언을 빠뜨리면 헛앵커가 그대로 병합되고 mirror case가
    // 조용히 되살아난다. 그래서 분할된 파일에서는 코어가 거절한다.
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    const entry = (i: number) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: "x" });
    const out = await submitFix({ runId, file: "src/Big.java", fixes: plan[0]!.map(entry) }, d);
    expect(out).toContain("part");
    expect(out).toContain("4 part(s)");
    expect(loadFixes(runId, "src/Big.java", d).fixes).toHaveLength(0);
  });

  it("part가 하나뿐인 파일은 part 선언 없이도 지금 그대로 받는다", async () => {
    const { d, runId } = await bigFixRun(3);
    expect(fixPartPlan(runId, "src/Big.java", d)).toHaveLength(1);
    const out = await submitFix(
      {
        runId,
        file: "src/Big.java",
        fixes: [0, 1, 2].map((i) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: "x" })),
      },
      d
    );
    expect(out).toContain("COMPLETE");
    expect(loadFixes(runId, "src/Big.java", d).fixes).toHaveLength(3);
  });

  it("마지막이 아닌 part를 제출하면 다음 part를 지목한다", async () => {
    // 이게 없으면 오케스트레이터가 보는 어떤 툴 결과도 다음 part를 말하지 않는다.
    // fixContext의 "N parts" 안내는 수정관에게만 가고, 그 수정관은 한 번 제출하고
    // 멈추라는 지시를 받는다 — 그래서 part 0만 고쳐지고 나머지는 규칙 텍스트만
    // 달고 리포트로 나갔다.
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    const entry = (i: number) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: "x" });
    const out = await submitFix(
      { runId, file: "src/Big.java", part: 0, fixes: plan[0]!.map(entry) },
      d
    );
    expect(out).toContain("NEW f-fixer");
    expect(out).toContain("f_review_fix_context");
    expect(out).toContain("part=1");
    // 두 호출 모두 part를 실어야 한다 — 제출에서 빠지면 위 거절에 걸린다.
    expect(out).toContain("f_review_fix_submit with part=1");

    // 마지막 part 뒤에는 지목할 것이 없다.
    for (let part = 1; part < plan.length; part++) {
      const each = await submitFix(
        { runId, file: "src/Big.java", part, fixes: plan[part]!.map(entry) },
        d
      );
      if (part === plan.length - 1) expect(each).not.toContain("NEW f-fixer");
      else expect(each).toContain(`part=${part + 1}`);
    }
  });

  it("빈틈 있는 첫 part를 지목한다 — 다음 번호를 기계적으로 세지 않는다", async () => {
    // declared + 1은 사슬을 처음부터 다시 돌린다. 늦게 돌아온 part 0의
    // 재제출이 part 1을 지목하면, part 1은 다시 떠서 자기 몫이 이미 다
    // 들어있는 것을 보고 part 2를 지목하고… 5개짜리 파일이 할 일 없는
    // f-fixer를 네 번 더 띄운다.
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    expect(plan.length).toBeGreaterThan(2);
    const entry = (i: number) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: "x" });
    const submit = (part: number) =>
      submitFix({ runId, file: "src/Big.java", part, fixes: plan[part]!.map(entry) }, d);

    // 순서를 건너뛰어 part 1을 먼저 끝낸다.
    await submit(1);
    const afterZero = await submit(0);
    // part 1은 이미 끝났으므로 지목 대상이 아니다.
    expect(afterZero).toContain("part=2");
    expect(afterZero).not.toContain("part=1");

    for (let part = 2; part < plan.length; part++) await submit(part);

    // 모든 part가 끝난 뒤 part 0이 한 번 더 제출한다(돌려보내진 fixer의
    // 마지막 기회). 지목할 것은 아무것도 없다.
    const late = await submit(0);
    expect(late).toContain("COMPLETE");
    expect(late).not.toContain("NEW f-fixer");
  });

  it("unfixedFixParts는 빈틈이 남은 part만 돌려준다", async () => {
    // finalize의 회수 안내가 part=0부터 다시 세면, 이미 끝난 part를 다시
    // 띄우고 진짜 빠진 part에는 도달하지 못한다.
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    const entry = (i: number) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: "x" });
    expect(unfixedFixParts(runId, "src/Big.java", d)).toEqual({
      parts: plan.map((_, part) => part),
      total: plan.length,
    });
    await submitFix({ runId, file: "src/Big.java", part: 0, fixes: plan[0]!.map(entry) }, d);
    await submitFix({ runId, file: "src/Big.java", part: 2, fixes: plan[2]!.map(entry) }, d);
    const gaps = unfixedFixParts(runId, "src/Big.java", d);
    expect(gaps.parts).not.toContain(0);
    expect(gaps.parts).not.toContain(2);
    expect(gaps.parts).toContain(1);
  });

  it("버려진 항목 수를 기록해 fixCoverage까지 들고 간다", async () => {
    // 이 숫자가 수정관의 화면에만 찍히면, 정직한 항목이 잘못 버려져도 아무도
    // 모른다 — 수정관은 "다시 보내지 말라"는 말을 듣고 그대로 멈춘다.
    const { d, runId } = await bigFixRun(60);
    const plan = fixPartPlan(runId, "src/Big.java", d);
    const entry = (i: number) => ({ line: 1 + i * 20, ruleId: `Rule${i}`, toBe: "x" });
    await submitFix(
      {
        runId,
        file: "src/Big.java",
        part: 0,
        fixes: [...plan[0]!.map(entry), entry(plan[1]![0]!)],
      },
      d
    );
    expect(loadFixes(runId, "src/Big.java", d).dropped).toBe(1);
    expect(fixCoverage(runId, ["src/Big.java"], d)[0]!.dropped).toBe(1);
  });

  it("계획 지시문이 파일별 part 수를 알려준다", async () => {
    // 오케스트레이터는 fixContext를 부르지 않는다. 여기서 말해주지 않으면
    // 파일이 몇 조각인지 알 길이 없다.
    const { d, runId } = await bigFixRun(60);
    const meta = { ...loadRun(runId, d)!, fcqFix: true };
    const out = renderPlanInstructions(meta, d);
    expect(out).toContain("4 part(s)");
    expect(out).toContain("part=0");
    // "모든 fix 서브에이전트가 돌아오면 finalize"는 part 0의 fixer가 돌아온
    // 순간 글자 그대로 참이 된다 — 사슬이 돌기도 전에 finalize가 불린다.
    expect(out).not.toContain("every fix subagent has returned, call");
    expect(out).toContain("every part of it included");
    // 복구도 파일당 하나로 못박히면 분할 파일은 part 0만 다시 돈다.
    expect(out).toContain("one subagent per part");
  });

  it("분할이 없으면 finalize/복구 문구가 예전 그대로다", async () => {
    const { d, runId } = await bigFixRun(3);
    const meta = { ...loadRun(runId, d)!, fcqFix: true };
    const out = renderPlanInstructions(meta, d);
    expect(out).toContain("every fix subagent has returned, call f_review_finalize");
    expect(out).not.toContain("every part of it included");
    expect(out).not.toContain("part(s):");
  });

  it("분할된 fix 컨텍스트가 제출할 part 번호를 알려준다", async () => {
    const { d, runId } = await bigFixRun(60);
    expect(fixContext(runId, "src/Big.java", d, 1)).toContain("part=1");
    // 쪼개지지 않은 파일은 part를 아예 꺼내지 않는다.
    const small = await bigFixRun(3);
    expect(fixContext(small.runId, "src/Big.java", small.d)).not.toContain("part=");
  });

});
