/**
 * Optional live-progress bridge to a moebius server.
 *
 * Active only when moebius spawned this `opencode run` for a loop step — it sets
 * MOEBIUS_RUN_ID / MOEBIUS_STEP_ID / MOEBIUS_SERVER_URL in the environment. Every
 * f-review stage (plan, per-file reviewer, judge, finalize) is reported as a node
 * of the run's live DAG via POST /api/runs/:id/external. Fire-and-forget: reporting
 * must never slow down or break the review flow.
 */

const RUN_ID = process.env.MOEBIUS_RUN_ID;
const SERVER = process.env.MOEBIUS_SERVER_URL;
const PARENT = process.env.MOEBIUS_STEP_ID;

const REVIEWER_GROUP = "reviewer subagent (per file)";
const JUDGE_GROUP = "judge subagent";

type Status = "running" | "succeeded" | "failed";

interface ExternalEvent {
  id: string;
  name: string;
  status: Status;
  dependsOn?: string[];
  group?: string;
  output?: unknown;
  error?: string;
}

function post(ev: ExternalEvent): void {
  if (!RUN_ID || !SERVER) return;
  fetch(`${SERVER}/api/runs/${RUN_ID}/external`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: PARENT ?? null, ...ev }),
  }).catch(() => {});
}

export const moebiusActive = (): boolean => Boolean(RUN_ID && SERVER);

// Per-session stashes: parallel reviewer/judge subagents share this plugin process,
// so args captured in the before-hook are keyed by sessionID for use in the after-hook.
const reviewFileBySession = new Map<string, string>();
const judgeFileBySession = new Map<string, string>();

export function moebiusBeforeTool(tool: string, sessionID: string, args: Record<string, unknown>): void {
  if (!moebiusActive()) return;
  switch (tool) {
    case "f_review_plan":
      post({ id: "plan", name: "Plan & fan-out", status: "running" });
      break;
    case "f_review_context":
      // run mode: each reviewer subagent joins with exactly one file
      if (typeof args.runId === "string" && Array.isArray(args.files) && args.files.length === 1) {
        const file = String(args.files[0]);
        reviewFileBySession.set(sessionID, file);
        post({
          id: `review:${file}`,
          name: `Review ${file}`,
          status: "running",
          dependsOn: ["plan"],
          group: REVIEWER_GROUP,
        });
      }
      break;
    case "f_review_judge_context":
      if (typeof args.file === "string") {
        post({
          id: `judge:${args.file}`,
          name: `Judge ${args.file}`,
          status: "running",
          dependsOn: [`review:${args.file}`],
          group: JUDGE_GROUP,
        });
      }
      break;
    case "f_review_judge":
      if (typeof args.file === "string") judgeFileBySession.set(sessionID, args.file);
      break;
    case "f_review_finalize":
      post({ id: "finalize", name: "Finalize & aggregate", status: "running", dependsOn: ["*"] });
      break;
  }
}

/** OpenCode's after-hook output is { title, output, metadata }; our tools return strings. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const out = (result as { output?: unknown }).output;
    if (typeof out === "string") return out;
  }
  return "";
}

export function moebiusAfterTool(tool: string, sessionID: string, result: unknown): void {
  if (!moebiusActive()) return;
  const text = resultText(result);
  switch (tool) {
    case "f_review_plan":
      post({ id: "plan", name: "Plan & fan-out", status: "succeeded", output: { text: text.slice(0, 2000) } });
      break;
    case "f_review_submit": {
      // Only the final submit returns a completion head:
      //   "✅ <file> reviewed (N issue(s)); review saved."
      //   "⚠️ <file> partially reviewed (...)" / "⚠️ <file> force-accepted (...)"
      const file = reviewFileBySession.get(sessionID);
      if (!file) break;
      if (text.startsWith("✅")) {
        post({
          id: `review:${file}`,
          name: `Review ${file}`,
          status: "succeeded",
          group: REVIEWER_GROUP,
          output: { text: text.split("\n")[0] },
        });
      } else if (text.startsWith("⚠️")) {
        post({
          id: `review:${file}`,
          name: `Review ${file}`,
          status: "failed",
          group: REVIEWER_GROUP,
          error: text.split("\n")[0],
        });
      }
      break;
    }
    case "f_review_judge": {
      const file = judgeFileBySession.get(sessionID);
      if (!file) break;
      if (/Judge PASS/.test(text)) {
        post({ id: `judge:${file}`, name: `Judge ${file}`, status: "succeeded", group: JUDGE_GROUP, output: { text: text.split("\n")[0] } });
      } else if (text && !text.startsWith("❌") && !text.startsWith("Invalid")) {
        // rework verdict — the reviewer will be re-spawned, flipping review:<file> back to running
        post({ id: `judge:${file}`, name: `Judge ${file}`, status: "failed", group: JUDGE_GROUP, error: text.split("\n")[0] });
      }
      break;
    }
    case "f_review_finalize":
      post({ id: "finalize", name: "Finalize & aggregate", status: "succeeded", output: { text: text.slice(0, 4000) } });
      break;
  }
}
