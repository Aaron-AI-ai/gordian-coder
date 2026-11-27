/**
 * The plan document of the f-unit-test-code workflow.
 *
 * A submitted plan is written to `.fico/f-unittest/runs/<id>/plan.md`: the plan text,
 * the machine-readable `inputs` as a JSON block, the status and a revision history,
 * plus a short guide for the user. On approval the workflow re-reads the JSON block, so
 * the user can edit the plan in the file and the run proceeds from what the file says.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { localFileStamp, localTimestamp } from "./time";

export const PLAN_DOC_ROOT = ".fico/f-unittest/runs";
const INPUTS_HEADING = "## 실행 입력 (inputs)";

export type PlanDocStatus = "승인 대기" | "승인됨" | "완료" | "미완료";

export interface PlanDocState {
  /** Project-relative path of plan.md, set at the first plan submission. */
  planDoc?: string;
  planRevision: number;
  planHistory: string[];
}

export const newPlanDocState = (): PlanDocState => ({ planRevision: 0, planHistory: [] });

export interface PlanDocContent {
  command: string;
  plan: string;
  inputs: unknown;
  status: PlanDocStatus;
  /** One history line for this write (e.g. "rev 2 제출"). */
  event: string;
  /** Extra lines under the status (e.g. the report path when done). */
  extra?: string[];
}

/** Writes (or rewrites) plan.md and returns its project-relative path. */
export function writePlanDoc(cwd: string, st: PlanDocState, c: PlanDocContent): string {
  st.planDoc ??= `${PLAN_DOC_ROOT}/${localFileStamp()}/plan.md`;
  st.planHistory.push(`- ${localTimestamp()} ${c.event}`);
  const abs = path.join(cwd, st.planDoc);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = [
    `# ${c.command} 계획`,
    "",
    `- 상태: ${c.status} (rev ${st.planRevision})`,
    `- 문서: ${st.planDoc}`,
    ...(c.extra ?? []).map((x) => `- ${x}`),
    "",
    "## 사용 방법",
    "- **승인**: 대화창에 \"승인\"이라고 답하세요. 승인하면 아래 '실행 입력'대로 진행합니다.",
    "- **수정 요청**: 바꿀 내용을 대화창에 적어 주세요. 고친 계획이 이 문서에 다시 저장되고, 다시 승인을 요청합니다.",
    "- **직접 수정**: 아래 '실행 입력' JSON을 이 파일에서 고친 뒤 대화창에 \"승인\"이라고 답하세요. 승인할 때 이 JSON을 다시 읽고 검증해 그대로 진행합니다. 검증에 실패하면 이유를 알려 드립니다. '계획' 설명 글만 고치는 것은 실행에 반영되지 않습니다.",
    "",
    "## 계획",
    c.plan.trim(),
    "",
    INPUTS_HEADING,
    "```json",
    JSON.stringify(c.inputs, null, 2),
    "```",
    "",
    "## 이력",
    ...st.planHistory,
    "",
  ].join("\n");
  fs.writeFileSync(abs, body, "utf-8");
  return st.planDoc;
}

/** The `inputs` JSON block of plan.md, or why it cannot be read. */
export function readPlanDocInputs(cwd: string, st: PlanDocState): { inputs: unknown } | { error: string } {
  if (!st.planDoc) return { error: "no plan document was written" };
  const abs = path.join(cwd, st.planDoc);
  if (!fs.existsSync(abs)) return { error: `${st.planDoc} is missing` };
  const text = fs.readFileSync(abs, "utf-8");
  const at = text.lastIndexOf(INPUTS_HEADING); // the plan text above may quote the heading itself
  const block = at < 0 ? null : /```json\s*\n([\s\S]*?)\n```/.exec(text.slice(at));
  if (!block) return { error: `${st.planDoc} has no "${INPUTS_HEADING}" JSON block` };
  try {
    return { inputs: JSON.parse(block[1]!) };
  } catch (e) {
    return { error: `the JSON in ${st.planDoc} is invalid: ${(e as Error).message}` };
  }
}

/** What the model tells the user right after the plan is recorded. */
export function planDocGuide(doc: string): string {
  return [
    `The plan is saved to ${doc}. In your reply to the user (in Korean) give this path and how to answer:`,
    `approve by replying "승인"; ask for changes in the chat; or edit the "실행 입력 (inputs)" JSON in that file and then reply "승인" (the run will follow the file).`,
  ].join(" ");
}
