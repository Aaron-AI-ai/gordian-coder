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
  reviewerAgentSteps,
  JUDGE_AGENT_STEPS,
  JUDGE_AGENT_PROMPT,
  FIXER_AGENT_PROMPT,
  REVIEW_COMMAND_NAME,
} from "../prompts";
import { MAX_RESUMES, DEFAULT_MAX_TOOL_CALLS } from "../../../../core/review";
import { clearState, getState } from "../../../../core/review/pipeline/state";

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
  it("tells the orchestrator that f-fixer exists and is not interchangeable", () => {
    // Two real runs spawned f-judge with the fix prompt because the command
    // template only ever named f-reviewer and f-judge. The subagent failed on
    // its first tool call and the fix pass silently never ran.
    const { mod } = moduleFor(gitRepo());
    const cfg: { agent: Record<string, unknown>; command: Record<string, { template: string }> } = {
      agent: {},
      command: {},
    };
    mod.config(cfg as never);
    const template = cfg.command["f-review"]!.template;
    expect(template).toContain("f-fixer");
    expect(template).toContain("f_review_fix_context");
    expect(template).toContain("the three are not");
    expect(template).toContain("FIX PASS");
  });

  it("gives every agent a permission map matching its own tools", () => {
    // `permission` is the boundary OpenCode enforces; `tools` is legacy
    // compatibility. f-fixer was registered with the JUDGE's permission map,
    // so three runs got "Available tools: f_review_judge,
    // f_review_judge_context" on their first call while `tools` said otherwise.
    const { mod } = moduleFor(gitRepo());
    const cfg: {
      agent: Record<string, { tools: Record<string, boolean>; permission: Record<string, string> }>;
    } = { agent: {} };
    mod.config(cfg as never);
    for (const [name, a] of Object.entries(cfg.agent)) {
      const allowedByTools = Object.entries(a.tools)
        .filter(([t, on]) => on && t.startsWith("f_review"))
        .map(([t]) => t)
        .sort();
      const allowedByPermission = Object.entries(a.permission)
        .filter(([t, act]) => act === "allow" && t.startsWith("f_review"))
        .map(([t]) => t)
        .sort();
      expect(allowedByPermission, `${name}: permission must match tools`).toEqual(allowedByTools);
    }
  });

  it("gives the fixer only tools that work without a review session", () => {
    // file_read and code_search route through runReviewTool, which needs an
    // active review. The fixer never opens one, so granting them handed it two
    // tools that can only ever answer "No active review".
    const { mod } = moduleFor(gitRepo());
    const cfg: { agent: Record<string, { tools: Record<string, boolean>; steps?: number }> } = { agent: {} };
    mod.config(cfg as never);
    const fixer = cfg.agent["f-fixer"]!;
    expect(Object.entries(fixer.tools).filter(([, on]) => on).map(([n]) => n).sort()).toEqual([
      "f_review_fix_context",
      "f_review_fix_submit",
    ]);
    // And a step cap, so a fixer that cannot progress stops instead of spinning.
    expect(fixer.steps).toBeGreaterThan(0);
  });

  it("exposes the full review toolset, orchestrator tools included", () => {
    const { mod } = moduleFor(gitRepo());
    expect(Object.keys(mod.tools).sort()).toEqual(
      [
        "code_search",
        "f_review_context",
        "f_review_finalize",
        "f_review_fix_context",
        "f_review_fix_submit",
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
    // steps must stay strictly above the tool-call budget so repeat-guard's
    // forced convergence fires before OpenCode's degenerate wrap-up injection.
    const expectedSteps = reviewerAgentSteps(DEFAULT_MAX_TOOL_CALLS);
    expect(expectedSteps).toBeGreaterThan(DEFAULT_MAX_TOOL_CALLS);
    expect(cfg.agent[REVIEWER_AGENT_NAME]).toHaveProperty("steps", expectedSteps);
    expect(cfg.agent[REVIEWER_AGENT_NAME]).toHaveProperty("maxSteps", expectedSteps);
    expect(cfg.agent[JUDGE_AGENT_NAME]).toHaveProperty("steps", JUDGE_AGENT_STEPS);
    expect(JUDGE_AGENT_STEPS).toBe(6);
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

describe("part 파라미터", () => {
  // 이 어댑터가 코어의 분할 경로를 노출하는 유일한 지점이라, 여기 스키마가
  // 방어의 전부다. 정수가 아닌 part(1.5)는 코어의 범위 검사를 그대로 통과해
  // plan[1.5]!.map 에서 TypeError를 던졌다 — 거절 메시지가 아니라 예외였다.
  const PART_TOOLS = [
    "f_review_judge_context",
    "f_review_judge",
    "f_review_fix_context",
    "f_review_fix_submit",
  ] as const;

  /** The arg schema, narrowed to the one method this test needs: ZodRawShape
   * types its values as the opaque core type, which has no safeParse. */
  const partArg = (schema: unknown): { safeParse(v: unknown): { success: boolean } } =>
    schema as { safeParse(v: unknown): { success: boolean } };

  it("네 개의 툴 모두 part를 받고, 정수/음수를 검증한다", () => {
    const { mod } = moduleFor(gitRepo());
    for (const name of PART_TOOLS) {
      const part = partArg(mod.tools[name].args.part);
      expect(part, `${name} must expose part`).toBeDefined();
      expect(part.safeParse(0).success, `${name}: 0 is valid`).toBe(true);
      expect(part.safeParse(3).success, `${name}: 3 is valid`).toBe(true);
      expect(part.safeParse(undefined).success, `${name}: part is optional`).toBe(true);
      expect(part.safeParse(1.5).success, `${name}: 1.5 must be refused`).toBe(false);
      expect(part.safeParse(-1).success, `${name}: -1 must be refused`).toBe(false);
    }
  });

  it("툴 설명이 part 흐름을 오케스트레이터에게 알린다", () => {
    const { mod } = moduleFor(gitRepo());
    for (const name of ["f_review_judge_context", "f_review_fix_context"] as const) {
      expect(mod.tools[name].description, name).toContain("part");
    }
    // 분할 단위는 언제나 "part"다. "batch"는 같은 프롬프트에서 동시 서브에이전트
    // 수(RUN_BATCH_SIZE)를 가리키는 낱말이라 겹쳐 쓰면 둘 다 뭉개진다.
    for (const name of PART_TOOLS) {
      expect(mod.tools[name].description, name).not.toContain("batch");
    }
  });

  it("오케스트레이터 커맨드 템플릿이 part를 batch와 구분해 설명한다", () => {
    // 이 템플릿은 "EXACTLY" 따르라는 하드 룰 목록이고, 그 안의 "파일당
    // 서브에이전트 하나"는 part 흐름과 정면으로 어긋난다. 여기서 바로잡지
    // 않으면 오케스트레이터는 part 1에서 멈춘다.
    const { mod } = moduleFor(gitRepo());
    const cfg: { agent: Record<string, unknown>; command: Record<string, { template: string }> } = {
      agent: {},
      command: {},
    };
    mod.config(cfg as never);
    const template = cfg.command["f-review"]!.template;
    expect(template).toContain("part");
    expect(template).toContain("one per PART");
    expect(template).toContain("never a batch");
  });

  it("판정관/수정관 프롬프트가 받은 part 번호를 제출에 실어 보내게 한다", () => {
    // part를 실어 보내지 않으면 제출 범위는 앵커로 추측되고, 하나 삐끗한
    // 앵커가 다음 part의 재요청을 삼킨다 — 서브에이전트 프롬프트가 그 필드를
    // 채우는 유일한 상시 지시다.
    expect(JUDGE_AGENT_PROMPT).toContain("part");
    expect(FIXER_AGENT_PROMPT).toContain("part");
  });

  it("커맨드 템플릿의 절대 규칙이 part 규칙과 어긋나지 않는다", () => {
    // "follow EXACTLY" 아래에서 "파일당 하나"와 "part당 하나"가 나란히 서 있으면
    // LLM은 둘 중 하나를 임의로 고른다. 두 규칙 모두 part를 함께 말해야 한다.
    const { mod } = moduleFor(gitRepo());
    const cfg: { agent: Record<string, unknown>; command: Record<string, { template: string }> } = {
      agent: {},
      command: {},
    };
    mod.config(cfg as never);
    // 줄바꿈 위치에 걸리지 않도록 공백을 눌러 비교한다.
    const flat = cfg.command["f-review"]!.template.replace(/\s+/g, " ");
    expect(flat).not.toContain("two subagents for the same file.");
    expect(flat).toContain("two subagents for the same file AND part");
    expect(flat).not.toContain("ONE f-fixer subagent per file with");
    expect(flat).toContain("ONE f-fixer subagent per file AND part");
    // 인자 설명 절에도 같은 절대 표현이 하나 더 있었다.
    expect(flat).not.toContain("one f-fixer subagent per file for it");
    // 판정관도 part로 쪼개진다 — fixer 쪽과 똑같은 모순이 여기 남아 있었다.
    expect(flat).not.toContain("ONE f-judge subagent for that file and obey");
    expect(flat).toContain("ONE f-judge subagent for that file AND part");
    expect(flat).not.toContain("an independent f-judge subagent scores each file's review");
    // finalize 복구 절도 "파일당 하나"로 못박고 있었다. 분할된 파일의 복구는
    // part마다 하나가 필요하고, finalize 자신이 그렇게 지시한다.
    expect(flat).toContain("one per PART for a file finalize lists with parts");
    // 리뷰어에는 part 개념이 없다 — 세그먼트는 한 세션 안의 일이다. 손대지 않는다.
    expect(flat).toContain("ONE f-reviewer subagent per file;");
    // "파일을 다 띄웠으면 finalize"는 part 0만 띄우고 마무리하라는 말로도 읽힌다.
    expect(flat).not.toContain("When every file has been dispatched, call");
    expect(flat).toContain("every part of it included");
  });

  it("f_review_judge_context가 part를 코어까지 넘긴다", async () => {
    const d = gitRepo();
    const { mod } = moduleFor(d);
    const planMsg = (await mod.tools.f_review_plan.execute(
      { files: ["a.ts"], judge: true } as never,
      ctx
    )) as string;
    const runId = /Run created: (\S+) /.exec(planMsg)![1];
    const { writeFileReview } = await import("../../../../core/review");
    await writeFileReview(
      runId,
      { file: "a.ts", assessed: [], findings: [], explorationCalls: 1, partial: false },
      "# a",
      d
    );
    // part를 코어로 넘기지 않으면 이 호출은 part 0을 서빙하고 만다.
    const out = (await mod.tools.f_review_judge_context.execute(
      { runId, file: "a.ts", part: 7 } as never,
      ctx
    )) as string;
    expect(out).toContain("does not exist");
  });

  it("f_review_fix_context가 part를 코어까지 넘긴다", async () => {
    const d = gitRepo();
    const { mod } = moduleFor(d);
    const planMsg = (await mod.tools.f_review_plan.execute(
      { files: ["a.ts"] } as never,
      ctx
    )) as string;
    const runId = /Run created: (\S+) /.exec(planMsg)![1];
    const { runDir, loadRun } = await import("../../../../core/review/pipeline/artifact");
    const { fcqShardPath } = await import("../../../../core/review/evidence/fcq");
    writeFileSync(
      join(runDir(runId, d), "run.json"),
      JSON.stringify({
        ...loadRun(runId, d),
        fcq: { status: "ok", command: "fcq", durationMs: 1, reportPath: "r" },
      })
    );
    mkdirSync(join(runDir(runId, d), "fcq", "files"), { recursive: true });
    writeFileSync(
      fcqShardPath(runDir(runId, d), "a.ts"),
      JSON.stringify([
        {
          analyzer: "checkstyle",
          ruleId: "R0",
          description: "d",
          category: "code-style",
          severity: "MINOR",
          line: 1,
          message: "m",
        },
      ])
    );
    const out = (await mod.tools.f_review_fix_context.execute(
      { runId, file: "a.ts", part: 4 } as never,
      ctx
    )) as string;
    expect(out).toContain("does not exist");
  });
});
