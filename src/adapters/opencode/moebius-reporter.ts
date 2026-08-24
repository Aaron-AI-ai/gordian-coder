/**
 * Optional live-progress bridge to a moebius server.
 *
 * Active only when moebius spawned this `opencode run` for a loop step — it sets
 * MOEBIUS_RUN_ID / MOEBIUS_STEP_ID / MOEBIUS_SERVER_URL in the environment. Every
 * f-review stage (plan, per-file reviewer, judge, finalize) is reported as a node
 * of the run's live DAG via POST /api/runs/:id/external. Fire-and-forget: reporting
 * must never slow down or break the review flow.
 */

const REVIEWER_GROUP = "reviewer subagent (per file)";
const JUDGE_GROUP = "judge subagent";

/** Bound per-session correlation state in long-running OpenCode processes. */
export const MAX_MOEBIUS_SESSIONS = 256;

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
  const runID = process.env.MOEBIUS_RUN_ID;
  const server = process.env.MOEBIUS_SERVER_URL;
  const parent = process.env.MOEBIUS_STEP_ID;
  if (!runID || !server) return;
  fetch(`${server}/api/runs/${runID}/external`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: parent ?? null, ...ev }),
  }).catch(() => {});
}

export const moebiusActive = (): boolean =>
  Boolean(process.env.MOEBIUS_RUN_ID && process.env.MOEBIUS_SERVER_URL);

// Per-session stashes: parallel reviewer/judge subagents share this plugin process,
// so args captured in the before-hook are keyed by sessionID for use in the after-hook.
const reviewFileBySession = new Map<string, string>();
const judgeFileBySession = new Map<string, string>();

function remember(map: Map<string, string>, sessionID: string, file: string): void {
  map.delete(sessionID);
  map.set(sessionID, file);
  if (map.size > MAX_MOEBIUS_SESSIONS) {
    map.delete(map.keys().next().value!);
  }
}

function recentFile(map: Map<string, string>, sessionID: string): string | undefined {
  const file = map.get(sessionID);
  if (file === undefined) return undefined;
  map.delete(sessionID);
  map.set(sessionID, file);
  return file;
}

/** Release all Moebius correlation state for an OpenCode session. */
export function cleanupMoebiusSession(sessionID: string): void {
  reviewFileBySession.delete(sessionID);
  judgeFileBySession.delete(sessionID);
}

/** Diagnostics for bounded-cache tests and operational health checks. */
export function moebiusSessionCacheSizes(): { reviewer: number; judge: number } {
  return { reviewer: reviewFileBySession.size, judge: judgeFileBySession.size };
}

/** Whether a session currently has reviewer or judge correlation state. */
export function moebiusSessionCacheHas(
  sessionID: string
): { reviewer: boolean; judge: boolean } {
  return {
    reviewer: reviewFileBySession.has(sessionID),
    judge: judgeFileBySession.has(sessionID),
  };
}

export function moebiusBeforeTool(tool: string, sessionID: string, args: Record<string, unknown>): void {
  if (!moebiusActive()) return;
  switch (tool) {
    case "f_review_plan":
      post({ id: "plan", name: "Plan & fan-out", status: "running" });
      break;
    case "f_review_context":
      // Correlate only AFTER core accepts the context. Raw args can name a
      // non-target file and would poison the terminal submit attribution.
      break;
    case "f_review_judge_context":
      break;
    case "f_review_judge":
      // Correlation was established from the validated judge-context result.
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
  const text = resultText(result);
  switch (tool) {
    case "f_review_plan":
      post({
        id: "plan",
        name: "Plan & fan-out",
        status: /Run created:/.test(text) ? "succeeded" : "failed",
        ...(/Run created:/.test(text)
          ? { output: { text: text.slice(0, 2000) } }
          : { error: text.slice(0, 2000) }),
      });
      break;
    case "f_review_context": {
      // A successful run-mode context names the canonical normalized target in
      // its response. Invalid/duplicate contexts do not match and cannot alter
      // correlation state.
      const match = /^Run \S+: reviewing (.+?) \(/.exec(text);
      if (!match) break;
      const file = match[1];
      remember(reviewFileBySession, sessionID, file);
      post({
        id: `review:${file}`,
        name: `Review ${file}`,
        status: "running",
        dependsOn: ["plan"],
        group: REVIEWER_GROUP,
      });
      break;
    }
    case "f_review_judge_context": {
      const match = /^You are judging the review of (.+?) \(run /.exec(text);
      if (!match) break;
      const file = match[1];
      remember(judgeFileBySession, sessionID, file);
      post({
        id: `judge:${file}`,
        name: `Judge ${file}`,
        status: "running",
        dependsOn: [`review:${file}`],
        group: JUDGE_GROUP,
      });
      break;
    }
    case "f_review_submit": {
      // Only the final submit contains "review saved". Intermediate segment /
      // deep-pass submits may also start with a check mark but keep this same
      // reviewer session alive, so do not report or evict those yet.
      //   "✅ <file> reviewed (N issue(s)); review saved."
      //   "⚠️ <file> partially reviewed (...); partial review saved."
      //   "⚠️ <file> force-advanced (...); incomplete review saved ..."
      const file = recentFile(reviewFileBySession, sessionID);
      if (!file) break;
      const terminal = text.includes("review saved");
      if (terminal && text.startsWith("✅")) {
        post({
          id: `review:${file}`,
          name: `Review ${file}`,
          status: "succeeded",
          group: REVIEWER_GROUP,
          output: { text: text.split("\n")[0] },
        });
        reviewFileBySession.delete(sessionID);
      } else if (terminal && text.startsWith("⚠️")) {
        post({
          id: `review:${file}`,
          name: `Review ${file}`,
          status: "failed",
          group: REVIEWER_GROUP,
          error: text.split("\n")[0],
        });
        reviewFileBySession.delete(sessionID);
      }
      break;
    }
    case "f_review_judge": {
      const file = recentFile(judgeFileBySession, sessionID);
      if (!file) break;
      if (/Judge PASS/.test(text)) {
        post({ id: `judge:${file}`, name: `Judge ${file}`, status: "succeeded", group: JUDGE_GROUP, output: { text: text.split("\n")[0] } });
        judgeFileBySession.delete(sessionID);
      } else if (
        /Judge REWORK|Judge INCOMPLETE|Judge still below threshold|already hit the judge rework cap/.test(text)
      ) {
        // rework verdict — the reviewer will be re-spawned, flipping review:<file> back to running
        post({ id: `judge:${file}`, name: `Judge ${file}`, status: "failed", group: JUDGE_GROUP, error: text.split("\n")[0] });
        judgeFileBySession.delete(sessionID);
      }
      break;
    }
    case "f_review_finalize":
      post({
        id: "finalize",
        name: "Finalize & aggregate",
        status: text.startsWith("✅ Run complete") ? "succeeded" : "failed",
        ...(text.startsWith("✅ Run complete")
          ? { output: { text: text.slice(0, 4000) } }
          : { error: text.slice(0, 4000) }),
      });
      break;
  }
}

/** Report a reviewer terminal reached outside a tool after-hook (idle watchdog). */
export function moebiusReviewerTerminal(sessionID: string, text: string): void {
  const file = recentFile(reviewFileBySession, sessionID);
  if (!file) return;
  post({
    id: `review:${file}`,
    name: `Review ${file}`,
    status: "failed",
    group: REVIEWER_GROUP,
    error: text.split("\n")[0],
  });
  reviewFileBySession.delete(sessionID);
}
