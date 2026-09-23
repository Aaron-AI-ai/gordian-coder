/** Prompt text that rides inside tool responses (the adapter's agent prompts
 * are in adapters/opencode/log/prompts.ts; this is the per-round part). */
import { languageName } from "../review/pipeline/prompt";

export function languageLine(language: string): string {
  return `Write cause, mechanism, resolution and alternatives in ${languageName(language)}. Keep code identifiers, file paths and exception names as-is.`;
}

export function analystInstructions(submitToken: string, language: string, judge: boolean): string {
  return [
    "## 진행 방법",
    "1. 위 로그·관측·용의 코드를 읽고 가장 그럴듯한 원인 가설 하나를 세운다.",
    "2. f_log_read / f_log_search / f_log_callers / f_log_blame / f_log_related / f_log_history 로 가설을 확인한다. 예외가 던져진 곳이 아니라 **그 값을 만든 곳**까지 거슬러 간다. 툴 예산은 유한하다 — 같은 호출을 반복하지 마라.",
    "3. 관측 목록의 **모든 항목**에 대해 이 원인이 설명하는지(explained) 적는다. 설명 못 하는 관측은 explained=false 로 남긴다 — 지어내지 마라.",
    "4. 검토했지만 기각한 대안을 최소 하나 적는다.",
    "5. f_log_submit 을 호출한다. evidence 에는 실제로 읽은 파일만 적는다.",
    `CURRENT_SUBMIT_TOKEN=${submitToken}`,
    languageLine(language),
    judge ? "제출은 독립 심사를 받는다: 관측 대조 / 대안 배제 / 원인 제거(증상 완화가 아닌지)." : "",
  ].filter(Boolean).join("\n");
}
