import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { REQUIRED_CATEGORIES } from "../../../core/review";
import { getState } from "../../../core/review/pipeline/state";
import { GRACE_CALLS } from "../repeat-guard";
import OpenCodeAdapter from "../index";

const tmps: string[] = [];

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function gitRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), "f-opencode-hooks-"));
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

async function adapterHooks(
  directory = process.cwd(),
  aborted: string[] = []
): Promise<Hooks> {
  return OpenCodeAdapter({
    directory,
    client: {
      session: {
        abort: async (req: { path: { id: string } }) => {
          aborted.push(req.path.id);
          return { data: true };
        },
      },
    },
  } as unknown as PluginInput);
}

async function executeHooks(
  hooks: Hooks,
  sessionID: string,
  tool: string,
  args: Record<string, unknown>,
  output: string,
  call: number
): Promise<string> {
  await hooks["tool.execute.before"]!(
    { sessionID, tool, callID: `call-${call}` },
    { args }
  );
  const result = { title: tool, output, metadata: {} };
  await hooks["tool.execute.after"]!(
    { sessionID, tool, callID: `call-${call}` },
    result
  );
  return result.output;
}

describe("OpenCode repeat-hook integration", () => {
  test("preserves the third identical submit result after it has executed", async () => {
    const hooks = await adapterHooks(gitRepo());
    const sessionID = "adapter-submit-deep-3";
    const context = { sessionID } as never;
    await hooks.tool!.f_review_context.execute(
      { files: ["a.ts"], deepPasses: 3, language: "en" },
      context
    );
    // Satisfy the evidence check so the third deep pass is a real terminal
    // state transition rather than another quality-gate bounce.
    await hooks.tool!.file_read.execute({ file_path: "a.ts" }, context);
    const args = { assessed: [...REQUIRED_CATEGORIES], findings: [] };

    const submit = async (call: number): Promise<string> => {
      await hooks["tool.execute.before"]!(
        { sessionID, tool: "f_review_submit", callID: `submit-${call}` },
        { args }
      );
      const actual = await hooks.tool!.f_review_submit.execute(args, context);
      const result = { title: "f_review_submit", output: actual, metadata: {} };
      await hooks["tool.execute.after"]!(
        { sessionID, tool: "f_review_submit", callID: `submit-${call}` },
        result
      );
      return result.output;
    };

    expect(await submit(1)).toContain("Deep review round 2/3");
    expect(await submit(2)).toContain("Deep review round 3/3");
    const third = await submit(3);

    expect(third).toContain("✅ Review complete");
    expect(third).not.toContain("Loop detected");
  });

  test("still suppresses the third identical read-only result", async () => {
    const hooks = await adapterHooks();
    const sessionID = "adapter-read-loop";
    const args = { filePath: "src/a.ts" };

    await executeHooks(hooks, sessionID, "read", args, "contents", 1);
    await executeHooks(hooks, sessionID, "read", args, "contents", 2);
    const third = await executeHooks(hooks, sessionID, "read", args, "contents", 3);

    expect(third).toContain("Loop detected");
    expect(third).toContain("output withheld");
  });

  test("uses maxToolCalls to open a submit-only grace window, aborting only past it", async () => {
    const directory = gitRepo();
    writeFileSync(
      join(directory, ".f-review.json"),
      JSON.stringify({ deepPasses: 1, maxIter: 7, maxToolCalls: 10 })
    );
    const aborted: string[] = [];
    const hooks = await adapterHooks(directory, aborted);
    const sessionID = "adapter-total-budget";
    const context = { sessionID } as never;
    await hooks.tool!.f_review_context.execute({ files: ["a.ts"] }, context);

    // f_review_context is call 1. Seven exploration calls consume calls 2..8.
    for (let i = 0; i < 7; i++) {
      await hooks["tool.execute.before"]!(
        { sessionID, tool: "code_search", callID: `search-${i}` },
        { args: { search_text: `symbol-${i}` } }
      );
    }
    expect(getState(sessionID)!.toolCalls).toBe(8);

    // Call 9 is rejected before execution because two calls are reserved for submit/recovery.
    await expect(
      hooks["tool.execute.before"]!(
        { sessionID, tool: "file_find", callID: "search-8" },
        { args: { query_name: "another-symbol" } }
      )
    ).rejects.toThrow("reserved for f_review_submit");
    expect(aborted).toHaveLength(0);

    // Call 10 is not submit: exhaust the budget but do NOT abort — the session
    // enters a submit-only grace window so it can still produce a review.
    await expect(
      hooks["tool.execute.before"]!(
        { sessionID, tool: "file_read", callID: "search-9" },
        { args: { file_path: "a.ts" } }
      )
    ).rejects.toThrow("maxToolCalls=10");
    expect(aborted).toHaveLength(0);
    expect(getState(sessionID)!.toolBudgetExhausted).toBe(true);

    // f_review_submit remains callable throughout the grace window.
    await hooks["tool.execute.before"]!(
      { sessionID, tool: "f_review_submit", callID: "submit-grace" },
      { args: { submitToken: "t" } }
    );
    expect(aborted).toHaveLength(0);

    // GRACE_CALLS non-submit calls are refused with a "submit now" notice…
    for (let i = 0; i < GRACE_CALLS; i++) {
      await expect(
        hooks["tool.execute.before"]!(
          { sessionID, tool: "code_search", callID: `grace-${i}` },
          { args: { search_text: `late-${i}` } }
        )
      ).rejects.toThrow("Only f_review_submit");
      expect(aborted).toHaveLength(0);
    }

    // …and only past the window is the session hard-aborted.
    await expect(
      hooks["tool.execute.before"]!(
        { sessionID, tool: "code_search", callID: "grace-over" },
        { args: { search_text: "too-late" } }
      )
    ).rejects.toThrow("grace window is spent");
    expect(aborted).toEqual([sessionID]);
  });

  test("allows the 10th call when it is submit and keeps submit reachable afterwards", async () => {
    const directory = gitRepo();
    writeFileSync(join(directory, ".f-review.json"), JSON.stringify({ maxToolCalls: 10 }));
    const aborted: string[] = [];
    const hooks = await adapterHooks(directory, aborted);
    const sessionID = "adapter-submit-at-limit";
    const context = { sessionID } as never;
    await hooks.tool!.f_review_context.execute({ files: ["a.ts"] }, context);
    const st = getState(sessionID)!;
    st.toolCalls = 9;

    const args = { submitToken: "wrong", assessed: [...REQUIRED_CATEGORIES], findings: [] };
    await hooks["tool.execute.before"]!(
      { sessionID, tool: "f_review_submit", callID: "submit-10" },
      { args }
    );
    const actual = await hooks.tool!.f_review_submit.execute(args, context);
    const result = { title: "f_review_submit", output: actual, metadata: {} };
    await hooks["tool.execute.after"]!(
      { sessionID, tool: "f_review_submit", callID: "submit-10" },
      result
    );

    expect(result.output).toContain("tool-call budget exhausted");
    // No abort: submit must stay reachable so a corrected resubmit can still
    // land; the idle watchdog finalizes a partial report if it never does.
    expect(aborted).toHaveLength(0);
    expect(getState(sessionID)!.toolBudgetExhausted).toBe(true);
    await hooks["tool.execute.before"]!(
      { sessionID, tool: "f_review_submit", callID: "submit-retry" },
      { args }
    );
    expect(aborted).toHaveLength(0);
  });

  test("preserves a successful terminal submit at the exact configured limit", async () => {
    const directory = gitRepo();
    writeFileSync(join(directory, ".f-review.json"), JSON.stringify({ maxToolCalls: 10 }));
    const aborted: string[] = [];
    const hooks = await adapterHooks(directory, aborted);
    const sessionID = "adapter-terminal-at-limit";
    const context = { sessionID } as never;
    await hooks.tool!.f_review_context.execute({ files: ["a.ts"] }, context);
    const st = getState(sessionID)!;
    st.toolCalls = 9;
    st.callLog["a.ts"] = { file_read: 1 }; // satisfy the final evidence check

    const args = {
      submitToken: st.submitToken,
      assessed: [...REQUIRED_CATEGORIES],
      findings: [],
    };
    await hooks["tool.execute.before"]!(
      { sessionID, tool: "f_review_submit", callID: "terminal-submit-10" },
      { args }
    );
    const actual = await hooks.tool!.f_review_submit.execute(args, context);
    const result = { title: "f_review_submit", output: actual, metadata: {} };
    await hooks["tool.execute.after"]!(
      { sessionID, tool: "f_review_submit", callID: "terminal-submit-10" },
      result
    );

    expect(result.output).toContain("✅ Review complete");
    expect(result.output).not.toContain("budget exhausted");
    expect(aborted).toHaveLength(0);
    expect(getState(sessionID)).toBeUndefined();
  });

  test("blocks the fourth A-B-A-B lookup before it can execute", async () => {
    const directory = gitRepo();
    const hooks = await adapterHooks(directory);
    const sessionID = "adapter-alternating-loop";
    const context = { sessionID } as never;
    await hooks.tool!.f_review_context.execute({ files: ["a.ts"] }, context);

    const calls = [
      ["code_search", { search_text: "RequiredArgsConstructor" }],
      ["file_find", { query_name: "RequiredArgsConstructor" }],
      ["code_search", { search_text: "RequiredArgsConstructor" }],
    ] as const;
    for (const [tool, args] of calls) {
      await hooks["tool.execute.before"]!(
        { sessionID, tool, callID: `${tool}-${getState(sessionID)!.toolCalls}` },
        { args }
      );
    }

    await expect(
      hooks["tool.execute.before"]!(
        { sessionID, tool: "file_find", callID: "alternating-fourth" },
        { args: { query_name: "RequiredArgsConstructor" } }
      )
    ).rejects.toThrow("alternating lookup loop");
    expect(getState(sessionID)!.explorationSealed).toBe(true);
  });
});
