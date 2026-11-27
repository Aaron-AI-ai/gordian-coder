import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PLAN_DOC_ROOT, newPlanDocState, readPlanDocInputs, writePlanDoc } from "../plan-doc";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "plan-doc-"));
const content = (inputs: unknown = { module: "m", files: ["A.java"] }) => ({ command: "/f-unit-test-code", plan: "the plan", inputs, status: "승인 대기" as const, event: "rev 1 제출" });

describe("plan-doc", () => {
  test("writes plan.md under .fico/f-unittest/runs with plan, inputs JSON, guide and history", () => {
    const cwd = tmp();
    const st = newPlanDocState();
    st.planRevision = 1;
    const doc = writePlanDoc(cwd, st, content());
    expect(doc.startsWith(`${PLAN_DOC_ROOT}/`)).toBe(true);
    expect(doc.endsWith("/plan.md")).toBe(true);
    const md = fs.readFileSync(path.join(cwd, doc), "utf-8");
    expect(md).toContain("- 상태: 승인 대기 (rev 1)");
    expect(md).toContain("## 사용 방법");
    expect(md).toContain("the plan");
    expect(md).toContain('"module": "m"');
    expect(md).toContain("rev 1 제출");
  });

  test("a rewrite keeps the same file and appends to the history", () => {
    const cwd = tmp();
    const st = newPlanDocState();
    const first = writePlanDoc(cwd, st, content());
    const second = writePlanDoc(cwd, st, { ...content(), status: "승인됨", event: "승인" });
    expect(second).toBe(first);
    const md = fs.readFileSync(path.join(cwd, first), "utf-8");
    expect(md).toContain("- 상태: 승인됨");
    expect(md).toContain("rev 1 제출");
    expect(md).toContain("승인");
  });

  test("reads back the inputs block, including a user's edit", () => {
    const cwd = tmp();
    const st = newPlanDocState();
    const doc = writePlanDoc(cwd, st, content());
    expect(readPlanDocInputs(cwd, st)).toEqual({ inputs: { module: "m", files: ["A.java"] } });
    const abs = path.join(cwd, doc);
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf-8").replace('"A.java"', '"B.java"'));
    expect(readPlanDocInputs(cwd, st)).toEqual({ inputs: { module: "m", files: ["B.java"] } });
  });

  test("a plan text that quotes the inputs heading does not confuse the reader", () => {
    const cwd = tmp();
    const st = newPlanDocState();
    writePlanDoc(cwd, st, { ...content(), plan: "## 실행 입력 (inputs)\n```json\n{\"fake\": true}\n```" });
    expect(readPlanDocInputs(cwd, st)).toEqual({ inputs: { module: "m", files: ["A.java"] } });
  });

  test("broken JSON or a missing block is reported, not thrown", () => {
    const cwd = tmp();
    const st = newPlanDocState();
    const doc = writePlanDoc(cwd, st, content());
    const abs = path.join(cwd, doc);
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf-8").replace('"module": "m",', '"module": m,'));
    expect((readPlanDocInputs(cwd, st) as { error: string }).error).toContain("invalid");
    fs.writeFileSync(abs, "# nothing\n");
    expect((readPlanDocInputs(cwd, st) as { error: string }).error).toContain("JSON block");
  });
});
