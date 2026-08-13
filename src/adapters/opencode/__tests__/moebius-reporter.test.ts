import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";
import OpenCodeAdapter from "../index";
import {
  MAX_MOEBIUS_SESSIONS,
  cleanupMoebiusSession,
  moebiusAfterTool,
  moebiusBeforeTool,
  moebiusSessionCacheHas,
  moebiusSessionCacheSizes,
} from "../moebius-reporter";

const tracked = new Set<string>();
const originalFetch = globalThis.fetch;
let previousRunID: string | undefined;
let previousServer: string | undefined;
let previousStepID: string | undefined;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  previousRunID = process.env.MOEBIUS_RUN_ID;
  previousServer = process.env.MOEBIUS_SERVER_URL;
  previousStepID = process.env.MOEBIUS_STEP_ID;
  process.env.MOEBIUS_RUN_ID = "run-test";
  process.env.MOEBIUS_SERVER_URL = "http://moebius.test";
  process.env.MOEBIUS_STEP_ID = "step-test";
  globalThis.fetch = (() =>
    Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof fetch;
});

afterEach(() => {
  for (const sessionID of tracked) cleanupMoebiusSession(sessionID);
  tracked.clear();
  restoreEnv("MOEBIUS_RUN_ID", previousRunID);
  restoreEnv("MOEBIUS_SERVER_URL", previousServer);
  restoreEnv("MOEBIUS_STEP_ID", previousStepID);
  globalThis.fetch = originalFetch;
});

function reviewer(sessionID: string): void {
  tracked.add(sessionID);
  moebiusBeforeTool("f_review_context", sessionID, {
    runId: "run-test",
    files: [`${sessionID}.ts`],
  });
  moebiusAfterTool("f_review_context", sessionID, {
    output: `Run run-test: reviewing ${sessionID}.ts (explicit files).`,
  });
}

function judge(sessionID: string): void {
  tracked.add(sessionID);
  moebiusBeforeTool("f_review_judge_context", sessionID, { file: `${sessionID}.ts` });
  moebiusAfterTool("f_review_judge_context", sessionID, {
    output: `You are judging the review of ${sessionID}.ts (run run-test, judge round 1).`,
  });
}

describe("Moebius session correlation caches", () => {
  test("cleans reviewer and judge entries on terminal tool results", () => {
    reviewer("moebius-review-terminal");
    expect(moebiusSessionCacheHas("moebius-review-terminal").reviewer).toBe(true);
    moebiusAfterTool("f_review_submit", "moebius-review-terminal", {
      output: "✅ file reviewed (0 issues); review saved.",
    });
    expect(moebiusSessionCacheHas("moebius-review-terminal").reviewer).toBe(false);

    judge("moebius-judge-pass");
    expect(moebiusSessionCacheHas("moebius-judge-pass").judge).toBe(true);
    moebiusAfterTool("f_review_judge", "moebius-judge-pass", {
      output: "✅ Judge PASS (100/100)",
    });
    expect(moebiusSessionCacheHas("moebius-judge-pass").judge).toBe(false);

    judge("moebius-judge-rework");
    moebiusAfterTool("f_review_judge", "moebius-judge-rework", {
      output: "🔁 Judge REWORK (70/100)",
    });
    expect(moebiusSessionCacheHas("moebius-judge-rework").judge).toBe(false);

    judge("moebius-judge-incomplete");
    moebiusAfterTool("f_review_judge", "moebius-judge-incomplete", {
      output: "⚠️ Judge INCOMPLETE for file.ts",
    });
    expect(moebiusSessionCacheHas("moebius-judge-incomplete").judge).toBe(false);
  });

  test("keeps rejected non-terminal submissions available for retry", () => {
    reviewer("moebius-review-retry");
    moebiusAfterTool("f_review_submit", "moebius-review-retry", {
      output: "Invalid submission: assess every category",
    });
    expect(moebiusSessionCacheHas("moebius-review-retry").reviewer).toBe(true);

    moebiusAfterTool("f_review_submit", "moebius-review-retry", {
      output: "✅ segment reviewed (0 issues). Next file: segment#501-1000.",
    });
    expect(moebiusSessionCacheHas("moebius-review-retry").reviewer).toBe(true);

    judge("moebius-judge-retry");
    moebiusAfterTool("f_review_judge", "moebius-judge-retry", {
      output: "Invalid judge submission",
    });
    expect(moebiusSessionCacheHas("moebius-judge-retry").judge).toBe(true);
  });

  test("does not retarget reviewer correlation on a repeated context call", () => {
    const sessionID = "moebius-context-replay";
    tracked.add(sessionID);
    moebiusBeforeTool("f_review_context", sessionID, {
      runId: "run-test",
      files: ["b.ts"],
    });
    moebiusAfterTool("f_review_context", sessionID, {
      output: "❌ b.ts is not a target of run run-test",
    });
    moebiusBeforeTool("f_review_context", sessionID, {
      runId: "run-test",
      files: ["a.ts"],
    });
    moebiusAfterTool("f_review_context", sessionID, {
      output: "Run run-test: reviewing a.ts (explicit files).",
    });

    moebiusAfterTool("f_review_submit", sessionID, {
      output: "✅ a.ts reviewed (0 issues); review saved.",
    });
    expect(moebiusSessionCacheHas(sessionID).reviewer).toBe(false);
  });

  test("bounds both session maps and evicts least-recently-used entries", () => {
    for (let i = 0; i <= MAX_MOEBIUS_SESSIONS; i++) {
      reviewer(`moebius-review-lru-${i}`);
      judge(`moebius-judge-lru-${i}`);
    }

    expect(moebiusSessionCacheSizes()).toEqual({
      reviewer: MAX_MOEBIUS_SESSIONS,
      judge: MAX_MOEBIUS_SESSIONS,
    });
    expect(moebiusSessionCacheHas("moebius-review-lru-0").reviewer).toBe(false);
    expect(moebiusSessionCacheHas("moebius-review-lru-1").reviewer).toBe(true);
    expect(moebiusSessionCacheHas("moebius-judge-lru-0").judge).toBe(false);
    expect(moebiusSessionCacheHas("moebius-judge-lru-1").judge).toBe(true);
  });

  test("wires the actual OpenCode session.deleted event to cleanup", async () => {
    const sessionID = "moebius-session-deleted";
    reviewer(sessionID);
    judge(sessionID);
    expect(moebiusSessionCacheHas(sessionID)).toEqual({ reviewer: true, judge: true });

    const hooks = await OpenCodeAdapter({
      directory: process.cwd(),
      client: {},
    } as unknown as PluginInput);
    await hooks.event!({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionID } },
      },
    } as never);

    expect(moebiusSessionCacheHas(sessionID)).toEqual({ reviewer: false, judge: false });
  });
});
