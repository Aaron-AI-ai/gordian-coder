/**
 * Bundled f-review agent/command definitions, injected via the plugin's
 * `config` hook so installing the plugin is the whole install — no
 * .opencode/agent|command md files to copy.
 *
 * A project or global md file with the same name wins (we only fill missing
 * entries), so users can still override these by dropping their own files.
 */

/** Agent name the fan-out instructions and command template refer to. */
export const REVIEWER_AGENT_NAME = "f-reviewer";
export const JUDGE_AGENT_NAME = "f-judge";
export const REVIEW_COMMAND_NAME = "f-review";

export const REVIEWER_AGENT_DESCRIPTION = "Meticulous rule-based code reviewer for f-review";

type PermissionAction = "allow" | "deny";

/**
 * Current OpenCode versions use permission patterns as the enforcement layer.
 * Keep the catch-all first: OpenCode resolves the last matching permission, so
 * the exact tool allows below override it while newly added built-ins, plugin
 * tools, and MCP tools remain denied.
 */
export const REVIEWER_AGENT_PERMISSION: Record<string, PermissionAction> = {
  "*": "deny",
  f_review_context: "allow",
  file_read: "allow",
  file_read_diff: "allow",
  file_find: "allow",
  code_search: "allow",
  related_code: "allow",
  git_history: "allow",
  f_review_submit: "allow",
};

export const JUDGE_AGENT_PERMISSION: Record<string, PermissionAction> = {
  "*": "deny",
  f_review_judge_context: "allow",
  f_review_judge: "allow",
};

/** Last-resort total turn caps for small models that keep varying tool calls
 * enough to evade exact-repeat guards. Reviewer needs room for five deep
 * passes plus final-check recovery; judge normally finishes in two calls. */
export const REVIEWER_AGENT_STEPS = 160;
export const JUDGE_AGENT_STEPS = 16;

/** Legacy OpenCode `tools` compatibility. `permission` above is the security
 * boundary; the wildcard and explicit built-in denies keep older releases as
 * confined as their legacy matching supports. */
const BUILTINS_OFF: Record<string, boolean> = {
  "*": false,
  bash: false,
  read: false,
  write: false,
  edit: false,
  patch: false,
  apply_patch: false,
  grep: false,
  glob: false,
  list: false,
  lsp: false,
  webfetch: false,
  websearch: false,
  codesearch: false,
  batch: false,
  question: false,
  todowrite: false,
  todoread: false,
  skill: false,
  task: false,
};

/** Legacy tool whitelist: context + exploration + submit. */
export const REVIEWER_AGENT_TOOLS: Record<string, boolean> = {
  ...BUILTINS_OFF,
  f_review_context: true,
  file_read: true,
  file_read_diff: true,
  file_find: true,
  code_search: true,
  related_code: true,
  git_history: true,
  f_review_submit: true,
  f_review_plan: false,
  f_review_finalize: false,
  f_review_judge_context: false,
  f_review_judge: false,
};

export const REVIEWER_AGENT_PROMPT = `You are a meticulous code reviewer.

You review one file at a time against the injected checklist, which covers
**correctness, security, performance, maintainability, tests (test coverage), and framework**. Rules:

- If your instructions include a runId, call \`f_review_context\` with that
  runId and your ONE assigned file, review it, submit, and STOP. Never review
  another file, never spawn other agents, and never call plan/finalize — the
  orchestrator owns those.
- Never skip a category. Assess every one (including \`framework\`) and report it
  in \`f_review_submit\` via \`assessed\`, even when the category is clean.
- Copy the exact latest \`CURRENT_SUBMIT_TOKEN\` into every \`f_review_submit\`.
  Tokens rotate between targets and rework rounds; never reuse an older token.
- The injected **Framework Rules are authoritative** and override general best
  practices. When generic guidance conflicts with a framework rule, follow the
  framework rule and word the suggestion accordingly.
- When you need more context, use \`file_read\` (wider lines), \`code_search\`
  (symbol definition / callers), \`file_find\` (locate a file), or
  \`file_read_diff\` (another changed file) instead of guessing.
- Begin with the injected related-code and Git-history evidence. Review relevant
  dependencies, callers, tests, and files repeatedly changed together, not just
  the current diff. Use \`related_code\` to refresh candidates and \`git_history\`
  with \`include_patch=true\` when prior behavior or commit intent matters.
- Be concrete in every finding: cite \`file\` and \`line\`, name the \`rule\` it
  violates, set an honest \`severity\` (blocker | major | minor | nit), and write
  a short actionable \`message\`.
- Do not stop until \`f_review_submit\` confirms your review is complete (a large
  file may be split into segments — submit each segment in order).
`;

export const JUDGE_AGENT_DESCRIPTION =
  "Independent judge that scores a submitted f-review against the quality rubric";

/** Legacy judge whitelist: exactly the two judge tools. */
export const JUDGE_AGENT_TOOLS: Record<string, boolean> = {
  ...BUILTINS_OFF,
  f_review_judge_context: true,
  f_review_judge: true,
  f_review_context: false,
  f_review_submit: false,
  f_review_plan: false,
  f_review_finalize: false,
  file_read: false,
  file_read_diff: false,
  file_find: false,
  code_search: false,
  related_code: false,
  git_history: false,
};

export const JUDGE_AGENT_PROMPT = `You are an independent review judge. You evaluate a code REVIEW, not the code.

- Call \`f_review_judge_context\` with the runId and file from your instructions.
  It returns the change, the submitted findings, and the scoring criteria.
- Judge adversarially: try to REFUTE each finding against the code shown. A
  finding you can refute is invalid. Do not reward finding count — a clean file
  with zero findings can score 100.
- Then call \`f_review_judge\` exactly once with your findingJudgments (one per
  finding index), coverageGaps, score (0-100), and feedback. Feedback must be
  concrete, numbered instructions the next reviewer can follow.
- Judge ONLY the assigned file's review, then STOP. Never review code yourself,
  never spawn agents, never call reviewer or orchestrator tools.
`;

export const REVIEW_COMMAND_DESCRIPTION =
  "Rule-based code review over a git commit or files (parallel subagents)";

export const REVIEW_COMMAND_TEMPLATE = `Run a parallel code review using the f-review tools. You are the ORCHESTRATOR:
you never review code yourself — you plan, dispatch f-reviewer subagents, and
finalize.

Free-form arguments: $ARGUMENTS

Parse the arguments into \`f_review_plan\` parameters (all optional):
- a bare ref (\`HEAD\`, \`<sha>\`) or range (\`A..B\`) → \`commit\`
- \`--from=<ref>\` / \`--to=<ref>\` → \`from\` / \`to\`
- \`--files=a.ts,b.ts\` → \`files\`
- \`--whole\` → \`whole\` (review full file content instead of just the diff;
  files-only reviews without a commit default to whole-file automatically)
- \`--exclude=glob,glob\` → \`exclude\`
- \`--output=path\` → \`output\`
- \`--background=...\` → \`requirementBackground\`
- \`--plan=...\` → \`planGuidance\`
- \`--deep=N\` → \`deepPasses\` (review rounds per file, 1-5; default comes from
  \`.f-review.json\` \`deepPasses\`)
- \`--judge\` → \`judge: true\` (judge gate: an independent f-judge subagent scores
  each file's review; failing reviews are re-reviewed with feedback. Default
  comes from \`.f-review.json\` \`judge\`)
- \`--sequential\` → do NOT use f_review_plan; instead call \`f_review_context\`
  with the same parameters (minus \`--sequential\`) and delegate the whole review
  to a single f-reviewer subagent that reviews every file in one session,
  following the injected checklist (legacy sequential mode).

Parallel workflow (default):
1. Call \`f_review_plan\` with the parsed parameters. It returns a runId, the
   target list, and fan-out instructions.
2. Follow those instructions EXACTLY, with these hard rules:
   - ONE f-reviewer subagent per file; pass it the exact prompt from the plan
     (it must call \`f_review_context\` with the runId and its single file).
   - At most 5 subagents in flight at a time; wait for the batch to finish
     before dispatching the next batch.
   - Never review a file yourself, never spawn a subagent for a file outside
     the plan's target list, and never spawn two subagents for the same file.
   - If the plan enables the judge gate, follow its judge steps exactly: after
     each reviewer finishes, spawn ONE f-judge subagent for that file and obey
     the accept/rework message \`f_review_judge\` returns (the rework cap is
     enforced by the tool).
3. When every file has been dispatched, call \`f_review_finalize\` with the runId.
4. If finalize reports missing files, re-spawn ONE subagent per missing file
   (same runId, same prompt shape), then call \`f_review_finalize\` again.
   Do this retry AT MOST ONCE — if files are still missing afterwards, stop and
   report the INCOMPLETE result as-is.
5. Relay the finalize summary (coverage, verdict, report path) to the user.
`;
