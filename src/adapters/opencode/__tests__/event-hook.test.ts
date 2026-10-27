/**
 * The plugin's `event` hook is the only path from OpenCode's `session.idle`
 * to the f-review and f-log watchdogs. These tests drive the hook the way the
 * host does and check that each module's resume prompt reaches the client.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import OpenCodeAdapter from "../index";
import { clearState } from "../../../core/review/pipeline/state";
import { newLogSession, setLogState } from "../../../core/log/state";

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function gitRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), "f-opencode-event-"));
  tmps.push(directory);
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: directory });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(directory, "a.ts"), "export const a = 1;\n");
  git(["add", "a.ts"]);
  git(["commit", "-qm", "init"]);
  return directory;
}

type Prompt = { id: string; text: string };

async function adapter(directory: string): Promise<{ hooks: Hooks; prompts: Prompt[] }> {
  const prompts: Prompt[] = [];
  const hooks = await OpenCodeAdapter({
    directory,
    client: {
      session: {
        abort: async () => ({ data: true }),
        promptAsync: async (req: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => {
          prompts.push({ id: req.path.id, text: req.body.parts.map((p) => p.text).join("") });
          return { data: true };
        },
      },
    },
  } as unknown as PluginInput);
  return { hooks, prompts };
}

const idle = (sessionID: string) =>
  ({ event: { type: "session.idle", properties: { sessionID } } }) as unknown as Parameters<NonNullable<Hooks["event"]>>[0];

describe("OpenCode event hook", () => {
  test("session.idle with an unfinished review re-drives that session with the resume prompt", async () => {
    const directory = gitRepo();
    const { hooks, prompts } = await adapter(directory);
    const sessionID = "evt-review";
    try {
      await hooks.tool!.f_review_context.execute({ files: ["a.ts"], language: "en" }, { sessionID } as never);

      await hooks.event!(idle(sessionID));

      expect(prompts).toHaveLength(1);
      expect(prompts[0].id).toBe(sessionID);
      expect(prompts[0].text).toContain("Review incomplete");
      expect(prompts[0].text).toContain("f_review_submit");
      expect(prompts[0].text).toContain("auto-resume 1/");
    } finally {
      clearState(sessionID);
    }
  });

  test("session.idle with an unfinished log analysis asks for f_log_submit", async () => {
    const directory = gitRepo();
    const { hooks, prompts } = await adapter(directory);
    const sessionID = "evt-log";
    setLogState(sessionID, newLogSession(directory, "run-1", 1, 20, 20));

    await hooks.event!(idle(sessionID));

    expect(prompts).toHaveLength(1);
    expect(prompts[0].id).toBe(sessionID);
    expect(prompts[0].text).toContain("f_log_submit");
    expect(prompts[0].text).toContain("run-1");
  });

  test("session.idle for a session with nothing in flight is a no-op", async () => {
    const { hooks, prompts } = await adapter(gitRepo());
    await hooks.event!(idle("evt-nothing"));
    expect(prompts).toHaveLength(0);
  });

  test("other events pass through without prompting", async () => {
    const directory = gitRepo();
    const { hooks, prompts } = await adapter(directory);
    const sessionID = "evt-other";
    setLogState(sessionID, newLogSession(directory, "run-2", 1, 20, 20));

    await hooks.event!({
      event: { type: "session.created", properties: { info: { id: sessionID } } },
    } as unknown as Parameters<NonNullable<Hooks["event"]>>[0]);

    expect(prompts).toHaveLength(0);
  });
});
