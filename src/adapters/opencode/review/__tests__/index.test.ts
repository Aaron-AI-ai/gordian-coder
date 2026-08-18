/**
 * Wiring tests for the OpenCode review module.
 *
 * The review LOOP is covered by core/review/__tests__; what is untested
 * everywhere else is this adapter's plumbing — tool registration, the
 * session guard on every exploration tool, the system-prompt hook, the
 * idle watchdog's use of the OpenCode client, and the agent/command
 * config injection. Those are what this file pins.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { createReviewModule } from "../index";
import {
  REVIEWER_AGENT_NAME,
  REVIEWER_AGENT_PERMISSION,
  REVIEWER_AGENT_TOOLS,
  JUDGE_AGENT_NAME,
  JUDGE_AGENT_PERMISSION,
  JUDGE_AGENT_TOOLS,
  REVIEWER_AGENT_STEPS,
  JUDGE_AGENT_STEPS,
  REVIEW_COMMAND_NAME,
} from "../prompts";
import { MAX_RESUMES } from "../../../../core/review";
import { clearState, getState } from "../../../../core/review/state";

const SESSION = "oc";
const tmps: string[] = [];

afterEach(() => {
  clearState(SESSION);
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function gitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "f-oc-"));
  tmps.push(d);
  const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
  sh(["git", "init", "-q"]);
  sh(["git", "config", "user.email", "t@t"]);
  sh(["git", "config", "user.name", "t"]);
  writeFileSync(join(d, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(d, "b.ts"), "export const b = 2;\n");
  sh(["git", "add", "-A"]);
  sh(["git", "commit", "-qm", "init"]);
  return d;
}

/** Minimal PluginInput + a spy on the one client call the watchdog makes. */
function moduleFor(cwd: string) {
  const prompts: string[] = [];
  const input = {
    directory: cwd,
    client: {
      session: {
        promptAsync: async (req: { body: { parts: { text: string }[] } }) => {
          prompts.push(req.body.parts.map((p) => p.text).join(""));
        },
      },
    },
  } as unknown as PluginInput;
  return { mod: createReviewModule(input), prompts };
}

const ctx = { sessionID: SESSION } as never;

describe("tool registration", () => {
  it("exposes the full review toolset, orchestrator tools included", () => {
    const { mod } = moduleFor(gitRepo());
    expect(Object.keys(mod.tools).sort()).toEqual(
      [
        "code_search",
        "f_review_context",
        "f_review_finalize",
        "f_review_judge",
        "f_review_judge_context",
        "f_review_plan",
        "f_review_submit",
        "file_find",
        "file_read",
        "file_read_diff",
        "git_history",
        "related_code",
      ].sort()
    );
  });
});

describe("session guard", () => {
  const EXPLORATION = [
    "file_read",
    "file_read_diff",
    "file_find",
    "code_search",
    "related_code",
    "git_history",
  ] as const;

  it("refuses every exploration tool without an active review", async () => {
    const { mod } = moduleFor(gitRepo());
    const args: Record<string, unknown> = {
      file_path: "a.ts",
      path_array: ["a.ts"],
      query_name: "a",
      search_text: "a",
    };
    for (const name of EXPLORATION) {
      const out = await mod.tools[name].execute(args as never, ctx);
      expect(out).toContain("No active review");
    }
  });

  it("counts exploration calls against the current file once a review starts", async () => {
    const d = gitRepo();
    const { mod } = moduleFor(d);
    await mod.tools.f_review_context.execute({ files: ["a.ts"] } as never, ctx);

    const out = await mod.tools.file_read.execute({ file_path: "a.ts" } as never, ctx);
    expect(out).toContain("export const a = 1;");
    expect(getState(SESSION)!.callLog["a.ts"].file_read).toBe(1);
  });

  it("serves an UNTRACKED reference rule via file_read (rules are working-tree inputs)", async () => {
    const d = gitRepo();
    // second commit so `commit: "HEAD"` reviews at a real ref (git-show scoped reads)
    writeFileSync(join(d, "a.ts"), "export const a = 2;\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: d });
    Bun.spawnSync(["git", "commit", "-qm", "change"], { cwd: d });
    // rule file exists in the working tree but is never committed — the
    // ref-scoped git read would miss it and no-op the reference feature
    mkdirSync(join(d, "review", "rules"), { recursive: true });
    writeFileSync(
      join(d, "review", "rules", "guide.md"),
      "---\nmode: reference\n---\n# Order guide\nLayers must not skip.\n"
    );
    const { mod } = moduleFor(d);
    await mod.tools.f_review_context.execute({ commit: "HEAD" } as never, ctx);

    const out = await mod.tools.file_read.execute(
      { file_path: "review/rules/guide.md" } as never,
      ctx
    );
    expect(out).toContain("Layers must not skip.");
  });

  it("applies file_read ranges and caps to working-tree reference rules", async () => {
    const d = gitRepo();
    mkdirSync(join(d, "review", "rules"), { recursive: true });
    writeFileSync(
      join(d, "review", "rules", "large.md"),
      `---\nmode: reference\n---\n${Array.from({ length: 600 }, (_, i) => `rule ${i + 1}`).join("\n")}`
    );
    const { mod } = moduleFor(d);
    await mod.tools.f_review_context.execute({ files: ["a.ts"] } as never, ctx);

    const ranged = await mod.tools.file_read.execute(
      { file_path: "review/rules/large.md", start_line: 20, end_line: 22 } as never,
      ctx
    );
    expect(ranged).toContain("LINE_RANGE: 20-22");
    expect(ranged).toContain("20|rule 20");
    expect(ranged).not.toContain("23|rule 23");

    const capped = await mod.tools.file_read.execute(
      { file_path: "review/rules/large.md" } as never,
      ctx
    );
    expect(capped).toContain("IS_TRUNCATED: true");
    expect(capped).toContain("LINE_RANGE: 1-500");
    expect(capped).not.toContain("501|rule 501");
  });
});

describe("segment targets vs the filesystem", () => {
  /** Repo whose reviewed file is large enough to be split into segments. */
  function bigRepo(): string {
    const d = mkdtempSync(join(tmpdir(), "f-oc-seg-"));
    tmps.push(d);
    const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
    sh(["git", "init", "-q"]);
    sh(["git", "config", "user.email", "t@t"]);
    sh(["git", "config", "user.name", "t"]);
    writeFileSync(join(d, "dep.ts"), "export const helper = () => 1;\n");
    writeFileSync(
      join(d, "big.ts"),
      `import { helper } from "./dep";\n` +
        Array.from({ length: 1100 }, (_, i) => `export const v${i} = helper();`).join("\n") +
        "\n"
    );
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "init"]);
    return d;
  }

  it("resolves related_code / git_history against the real path, not the segment id", async () => {
    const { mod } = moduleFor(bigRepo());
    await mod.tools.f_review_context.execute({ files: ["big.ts"] } as never, ctx);

    const st = getState(SESSION)!;
    expect(st.targets.length).toBeGreaterThan(1); // actually segmented
    expect(st.targets[0]).toContain("#"); // current target IS a segment id

    // Both tools default to the current target; passing the raw `big.ts#1-500`
    // to git makes every lookup miss (no such path), silently emptying evidence.
    const related = await mod.tools.related_code.execute({} as never, ctx);
    expect(related).toContain("dep.ts"); // the import was actually resolved
    expect(related).not.toContain("#");

    const history = await mod.tools.git_history.execute({} as never, ctx);
    expect(history).not.toContain("No git history found");
    expect(history).not.toContain("#");
  });
});

describe("system-prompt injection", () => {
  it("pushes nothing when no review is active", async () => {
    const { mod } = moduleFor(gitRepo());
    const output = { system: [] as string[] };
    await mod.systemTransform({ sessionID: SESSION } as never, output as never);
    expect(output.system).toHaveLength(0);
  });

  it("pushes the per-file prompt and the language instruction while active", async () => {
    const d = gitRepo();
    const { mod } = moduleFor(d);
    await mod.tools.f_review_context.execute(
      { files: ["a.ts"], language: "en" } as never,
      ctx
    );

    const output = { system: [] as string[] };
    await mod.systemTransform({ sessionID: SESSION } as never, output as never);
    expect(output.system).toHaveLength(2);
    expect(output.system[0]).toContain("<current_file_path>a.ts</current_file_path>");
    expect(output.system[0]).toContain("TOOL_CALL_BUDGET: 1/10 used");
    expect(output.system[0]).toContain("f_review_submit");
    expect(output.system[1]).toContain("English");
  });
});

describe("idle watchdog", () => {
  it("ignores events other than session.idle", async () => {
    const { mod, prompts } = moduleFor(gitRepo());
    await mod.event({
      event: { type: "session.updated", properties: { sessionID: SESSION } },
    } as never);
    expect(prompts).toHaveLength(0);
  });

  it("re-drives an unfinished review through the OpenCode client", async () => {
    const d = gitRepo();
    const { mod, prompts } = moduleFor(d);
    await mod.tools.f_review_context.execute({ files: ["a.ts", "b.ts"] } as never, ctx);

    await mod.event({
      event: { type: "session.idle", properties: { sessionID: SESSION } },
    } as never);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Review incomplete: 0/2 file(s) submitted");
    expect(prompts[0]).toContain(`auto-resume 1/${MAX_RESUMES}`);
    expect(getState(SESSION)!.resumes).toBe(1);
  });

  it("stops prompting and lets core finalize a partial report past the resume cap", async () => {
    const d = gitRepo();
    const { mod, prompts } = moduleFor(d);
    await mod.tools.f_review_context.execute({ files: ["a.ts", "b.ts"] } as never, ctx);
    getState(SESSION)!.resumes = MAX_RESUMES;

    await mod.event({
      event: { type: "session.idle", properties: { sessionID: SESSION } },
    } as never);

    expect(prompts).toHaveLength(0); // nothing left to re-drive
    expect(getState(SESSION)).toBeUndefined(); // session finalized and cleared
  });

  it("never auto-resumes after the session-wide tool budget is exhausted", async () => {
    const d = gitRepo();
    const { mod, prompts } = moduleFor(d);
    await mod.tools.f_review_context.execute({ files: ["a.ts", "b.ts"] } as never, ctx);
    const st = getState(SESSION)!;
    st.toolBudgetExhausted = true;
    st.toolCalls = st.maxToolCalls;

    await mod.event({
      event: { type: "session.idle", properties: { sessionID: SESSION } },
    } as never);

    expect(prompts).toHaveLength(0);
    expect(getState(SESSION)).toBeUndefined();
  });
});

describe("agent/command config injection", () => {
  it("registers the reviewer agent and the review command", async () => {
    const { mod } = moduleFor(gitRepo());
    const cfg: Record<string, Record<string, unknown>> = {};
    await mod.config(cfg as never);

    expect(cfg.agent[REVIEWER_AGENT_NAME]).toMatchObject({ mode: "subagent" });
    expect(cfg.agent[JUDGE_AGENT_NAME]).toMatchObject({ mode: "subagent" });
    expect(cfg.agent[REVIEWER_AGENT_NAME]).toHaveProperty(
      "permission",
      REVIEWER_AGENT_PERMISSION
    );
    expect(cfg.agent[JUDGE_AGENT_NAME]).toHaveProperty("permission", JUDGE_AGENT_PERMISSION);
    expect(cfg.agent[REVIEWER_AGENT_NAME]).toHaveProperty("steps", REVIEWER_AGENT_STEPS);
    expect(cfg.agent[JUDGE_AGENT_NAME]).toHaveProperty("steps", JUDGE_AGENT_STEPS);
    expect(REVIEWER_AGENT_STEPS).toBe(10);
    expect(JUDGE_AGENT_STEPS).toBe(3);
    expect(cfg.command[REVIEW_COMMAND_NAME]).toHaveProperty("template");
  });

  it("never overwrites a project/global definition of the same name", async () => {
    const { mod } = moduleFor(gitRepo());
    const mine = { mode: "subagent", prompt: "my own reviewer" };
    const cfg = { agent: { [REVIEWER_AGENT_NAME]: mine } } as Record<string, Record<string, unknown>>;
    await mod.config(cfg as never);

    expect(cfg.agent[REVIEWER_AGENT_NAME]).toBe(mine);
    expect(cfg.command[REVIEW_COMMAND_NAME]).toBeDefined(); // the missing one still fills in
  });

  // Kept explicitly in the legacy tools map in addition to the permission
  // wildcard, for compatibility with older OpenCode releases.
  const OPENCODE_BUILTINS = [
    "bash",
    "read",
    "write",
    "edit",
    "patch",
    "apply_patch",
    "grep",
    "glob",
    "list",
    "lsp",
    "webfetch",
    "websearch",
    "codesearch",
    "batch",
    "question",
    "todowrite",
    "todoread",
    "skill",
    "task",
  ];

  it("denies the reviewer agent the orchestrator-only tools and every built-in", () => {
    // A subagent that could call plan/finalize/task would widen its own scope.
    expect(REVIEWER_AGENT_TOOLS.f_review_plan).toBe(false);
    expect(REVIEWER_AGENT_TOOLS.f_review_finalize).toBe(false);
    expect(REVIEWER_AGENT_TOOLS.f_review_submit).toBe(true);
    expect(REVIEWER_AGENT_TOOLS.f_review_judge).toBe(false); // reviewers never self-judge
    // A reviewer reads via the ref-scoped f-review tools; it must not edit
    // files, run commands, or read the working tree directly.
    for (const t of OPENCODE_BUILTINS) expect(REVIEWER_AGENT_TOOLS[t]).toBe(false);
  });

  it("default-denies current and future tools, then allows only reviewer tools", () => {
    expect(Object.keys(REVIEWER_AGENT_PERMISSION)[0]).toBe("*");
    expect(REVIEWER_AGENT_PERMISSION["*"]).toBe("deny");
    expect(
      Object.entries(REVIEWER_AGENT_PERMISSION)
        .filter(([, action]) => action === "allow")
        .map(([name]) => name)
        .sort()
    ).toEqual(
      [
        "code_search",
        "f_review_context",
        "f_review_submit",
        "file_find",
        "file_read",
        "file_read_diff",
        "git_history",
        "related_code",
      ].sort()
    );
    // These are intentionally unlisted and therefore hit the catch-all. The
    // same is true for arbitrary plugin and MCP tool names.
    for (const name of ["lsp", "websearch", "codesearch", "batch", "acme_mcp_lookup"]) {
      expect(REVIEWER_AGENT_PERMISSION[name]).toBeUndefined();
    }
  });

  it("confines the judge agent to exactly the two judge tools", () => {
    expect(JUDGE_AGENT_TOOLS.f_review_judge_context).toBe(true);
    expect(JUDGE_AGENT_TOOLS.f_review_judge).toBe(true);
    for (const [name, allowed] of Object.entries(JUDGE_AGENT_TOOLS)) {
      if (name !== "f_review_judge_context" && name !== "f_review_judge") {
        expect(allowed).toBe(false);
      }
    }
    // Explicit denies must exist for the built-ins — unlisted means enabled.
    for (const t of OPENCODE_BUILTINS) expect(JUDGE_AGENT_TOOLS[t]).toBe(false);
  });

  it("default-denies every unknown judge tool", () => {
    expect(Object.keys(JUDGE_AGENT_PERMISSION)[0]).toBe("*");
    expect(JUDGE_AGENT_PERMISSION).toEqual({
      "*": "deny",
      f_review_judge_context: "allow",
      f_review_judge: "allow",
    });
  });
});

describe("judge tool wiring", () => {
  it("routes f_review_judge_context and f_review_judge through core with the plugin cwd", async () => {
    const d = gitRepo();
    const { mod } = moduleFor(d);

    // Plan a judge-gated run, then fake a submitted review for a.ts.
    const planMsg = (await mod.tools.f_review_plan.execute(
      { files: ["a.ts"], judge: true } as never,
      ctx
    )) as string;
    expect(planMsg).toContain("JUDGE GATE");
    const runId = /Run created: (\S+) /.exec(planMsg)![1];
    const { writeFileReview } = await import("../../../../core/review");
    await writeFileReview(
      runId,
      {
        file: "a.ts",
        assessed: [],
        findings: [],
        explorationCalls: 1,
        partial: false,
      },
      "# a",
      d
    );

    const judgeCtx = (await mod.tools.f_review_judge_context.execute(
      { runId, file: "a.ts" } as never,
      ctx
    )) as string;
    expect(judgeCtx).toContain("judge round 1");

    const verdict = (await mod.tools.f_review_judge.execute(
      {
        runId,
        file: "a.ts",
        findingJudgments: [],
        coverageGaps: [],
        score: 100,
        feedback: "",
      } as never,
      ctx
    )) as string;
    expect(verdict).toContain("✅ Judge PASS");
  });
});
