import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { REQUIRED_CATEGORIES } from "../../../core/review";
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

async function adapterHooks(directory = process.cwd()): Promise<Hooks> {
  return OpenCodeAdapter({
    directory,
    client: {},
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
});
