/**
 * k-codereview wiring for the OpenCode plugin.
 *
 * Exposes the review tools and one system-prompt injection hook:
 *   - k_review_context : collect targets + rubric + diff snapshot, seed state
 *   - file_read        : read a file's after-version (line range, numbered)
 *   - file_read_diff   : read the diff of other changed files
 *   - file_find        : find files by filename substring
 *   - code_search      : git grep the codebase (regex / pathspec)
 *   - k_review_submit  : declare done for a file → coverage gate → advance/finish
 *   - system.transform : inject the per-file review template each turn
 *
 * The loop is driven by tool RESULT strings (see spec §5): a failed submit
 * returns "keep going", a passed submit advances the file pointer, and the
 * final pass writes the report.
 */

import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  REQUIRED_CATEGORIES,
  SEVERITIES,
  SubmitSchema,
  coverage,
  verdict,
  collectTargets,
  loadConfig,
  buildDiffMap,
  resolveDiffRange,
  buildRubric,
  loadFrameworkGuide,
  buildReviewPrompt,
  resolveOutputPath,
  writeReport,
  writeManifest,
  loadBaseline,
  setState,
  getState,
  clearState,
  currentFile,
  otherFiles,
  isDone,
  afterRef,
  fileRead,
  fileReadDiff,
  fileFind,
  codeSearch,
  defaultLabel,
  MAX_ITER,
  type CommitSpec,
  type ReviewState,
  type Severity,
} from "../../../core/review";

const z = tool.schema;

const NO_ACTIVE = "No active review. Call k_review_context first.";

const LANG_NAMES: Record<string, string> = { ko: "Korean", en: "English", ja: "Japanese" };
function languageName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

function shortSha(cwd: string): string | undefined {
  const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd });
  return p.exitCode === 0 ? p.stdout.toString().trim() || undefined : undefined;
}

export function createReviewModule(input: PluginInput): {
  tools: Record<string, ReturnType<typeof tool>>;
  systemTransform: NonNullable<Hooks["experimental.chat.system.transform"]>;
} {
  const cwd = input.directory;

  const k_review_context = tool({
    description:
      "Start a code review. Collects target files from a git commit/range, explicit files, and/or a package path (minus excludes), loads the rubric, and seeds the review loop. All inputs optional; with none, reviews the latest commit.",
    args: {
      commit: z.string().optional().describe('Single ref ("HEAD","<sha>") or range ("A..B")'),
      from: z.string().optional().describe("Range start (used with `to`)"),
      to: z.string().optional().describe("Range end (defaults HEAD)"),
      files: z.array(z.string()).optional().describe("Explicit file paths"),
      package: z.string().optional().describe("Directory/package path to scan"),
      exclude: z.array(z.string()).optional().describe("Glob patterns to exclude"),
      output: z.string().optional().describe("Report output file or directory"),
      failOn: z
        .enum(SEVERITIES)
        .optional()
        .describe("CI gate: verdict is FAIL when any finding is at/above this severity"),
      requirementBackground: z.string().optional(),
      planGuidance: z.string().optional(),
      language: z.string().optional().describe('Findings/report language (default "ko")'),
    },
    async execute(args, ctx) {
      let commit: CommitSpec | undefined;
      if (args.from) commit = { from: args.from, to: args.to ?? "HEAD" };
      else if (args.commit) commit = args.commit;

      let targets: string[];
      try {
        targets = await collectTargets(
          { commit, files: args.files, package: args.package, exclude: args.exclude },
          cwd
        );
      } catch (err) {
        return `Could not collect review targets: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      if (targets.length === 0) return "No files to review (empty target set after excludes).";

      const range = resolveDiffRange(commit, !!(args.files?.length || args.package));
      const state: ReviewState = {
        active: true,
        cwd,
        targets,
        currentIndex: 0,
        categories: [...REQUIRED_CATEGORIES],
        diffRange: range,
        ref: afterRef(range),
        diffMap: buildDiffMap(range, targets, cwd),
        systemRule: buildRubric(cwd),
        frameworkRules: loadFrameworkGuide(cwd),
        requirementBackground: args.requirementBackground ?? "",
        planGuidance: args.planGuidance ?? "",
        findings: {},
        output: args.output,
        failOn:
          args.failOn ??
          (SEVERITIES.includes(loadConfig(cwd).failOn as Severity)
            ? (loadConfig(cwd).failOn as Severity)
            : undefined),
        baseline: loadBaseline(args.output, cwd),
        label: shortSha(cwd) ?? defaultLabel(),
        language: args.language ?? loadConfig(cwd).language ?? "ko",
        iterations: 0,
      };
      setState(ctx.sessionID, state);

      // Write the target manifest alongside where the report will go, so the
      // full (possibly large) list lives in a file and the model only sees a
      // preview inline.
      const mode = range
        ? `commit diff (${range})`
        : args.package
          ? `package scan (${args.package})`
          : "explicit files";
      const excludes = [...(loadConfig(cwd).exclude ?? []), ...(args.exclude ?? [])];
      const manifestPath = resolveOutputPath(args.output, state.label, cwd).replace(
        /\.md$/,
        "-targets.md"
      );
      await writeManifest(manifestPath, targets, { mode, range, excludes }, state.label, cwd);

      const PREVIEW = 30;
      const preview = targets.slice(0, PREVIEW).map((t) => `  - ${t}`);
      if (targets.length > PREVIEW) preview.push(`  … and ${targets.length - PREVIEW} more`);

      return [
        `Queued ${targets.length} file(s) for review — mode: ${mode}.`,
        ...preview,
        "",
        `Full target list written to: ${manifestPath}`,
        `The review checklist is now injected into your instructions.`,
        `Review the first file (${targets[0]}). Use file_read / code_search / file_find / file_read_diff`,
        `for more context; call k_review_submit when done with each file.`,
      ].join("\n");
    },
  });

  // Shared guard: count an exploration call, append a wrap-up nudge past the cap.
  function guard(st: ReviewState, out: string): string {
    st.iterations++;
    if (st.iterations > MAX_ITER) {
      return `${out}\n\n⚠️ Exploration limit reached — review with what you have and call k_review_submit now.`;
    }
    return out;
  }

  const file_read = tool({
    description:
      "Read the after-version of a file (optionally a line range). Output is line-numbered for precise comments; capped at 500 lines. Use hunk headers @@ -x,y +m,n @@ to target start=m-50, end=m+n+50.",
    args: {
      file_path: z.string().min(1).describe("Relative path of the file to read"),
      start_line: z.number().int().optional().describe("Start line (default 1; clamped to >=1)"),
      end_line: z.number().int().positive().optional().describe("End line (default EOF)"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE;
      return guard(st, fileRead(st.cwd, st.ref, args.file_path, args.start_line, args.end_line));
    },
  });

  const file_read_diff = tool({
    description:
      "Read the diff of other changed files in this review (from the pre-parsed snapshot). Paths not in the change set are skipped.",
    args: {
      path_array: z.array(z.string()).min(1).describe("File paths whose diff to read"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE;
      return guard(st, fileReadDiff(st.diffMap, args.path_array));
    },
  });

  const file_find = tool({
    description:
      "Find files by filename substring (not glob/regex; matches basename only). Use to locate files outside the change set.",
    args: {
      query_name: z.string().min(1).describe("Filename keyword (substring)"),
      case_sensitive: z.boolean().optional().describe("Case-sensitive match (default false)"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE;
      return guard(st, fileFind(st.cwd, st.ref, args.query_name, args.case_sensitive));
    },
  });

  const code_search = tool({
    description:
      "Search the codebase with git grep. Find symbols, call sites, patterns. Capped at 100 matches, grouped by file.",
    args: {
      search_text: z.string().min(1).describe("Search string or regex"),
      file_patterns: z
        .array(z.string())
        .optional()
        .describe("git pathspec, e.g. ['*.ts', ':(exclude)*.test.ts']"),
      case_sensitive: z.boolean().optional().describe("Case-sensitive (default false)"),
      use_perl_regexp: z
        .boolean()
        .optional()
        .describe("true = Perl regex (-P), false = literal (-F, default)"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE;
      return guard(
        st,
        codeSearch(
          st.cwd,
          st.ref,
          args.search_text,
          args.file_patterns,
          args.case_sensitive,
          args.use_perl_regexp
        )
      );
    },
  });

  const k_review_submit = tool({
    description:
      "Declare the current file reviewed. Provide `assessed` (every rubric category you evaluated) and `findings` (issues, may be empty). Coverage is gated: if a category is unassessed, you must continue.",
    args: {
      assessed: z.array(z.enum(REQUIRED_CATEGORIES)).describe("Categories actually evaluated"),
      findings: z
        .array(
          z.object({
            category: z.enum(REQUIRED_CATEGORIES),
            severity: z.enum(SEVERITIES),
            file: z.string(),
            line: z.number().int().positive().optional(),
            rule: z.string(),
            message: z.string(),
            suggestion: z
              .string()
              .optional()
              .describe("Concrete fix (code or steps), when you can offer one"),
          })
        )
        .describe("Issues found (may be empty)"),
    },
    async execute(args, ctx) {
      const st = getState(ctx.sessionID);
      if (!st?.active) return NO_ACTIVE;

      const parsed = SubmitSchema.safeParse(args);
      if (!parsed.success) return `Invalid submission: ${parsed.error.message}`;

      const missing = coverage(parsed.data.assessed, st.categories);
      if (missing.length) {
        return `❌ Incomplete — categories not assessed: ${missing.join(
          ", "
        )}. Keep analyzing this file, then resubmit.`;
      }

      const file = currentFile(st);
      if (!file) return "No current file under review.";
      st.findings[file] = parsed.data.findings;
      st.currentIndex++;
      st.iterations = 0; // reset the exploration budget for the next file

      if (!isDone(st)) {
        return `✅ ${file} reviewed (${parsed.data.findings.length} issue(s)). Next file: ${currentFile(
          st
        )}.`;
      }

      st.active = false;
      const path = resolveOutputPath(st.output, st.label, st.cwd);
      await writeReport(path, st.findings, st.label, st.cwd, st.language, st.failOn, st.baseline);
      clearState(ctx.sessionID);
      const all = Object.values(st.findings).flat();
      let gate = "";
      if (st.failOn) {
        const v = verdict(all, st.failOn);
        gate = v.pass
          ? ` Verdict: PASS (failOn: ${st.failOn}).`
          : ` Verdict: FAIL — ${v.failing} finding(s) at/above ${st.failOn}.`;
      }
      return `✅ Review complete — ${st.targets.length} file(s), ${all.length} issue(s).${gate} Report: ${path}`;
    },
  });

  const systemTransform: NonNullable<Hooks["experimental.chat.system.transform"]> = async (
    hookInput,
    output
  ) => {
    const st = getState(hookInput.sessionID);
    if (!st?.active) return;
    const file = currentFile(st);
    if (!file) return;
    output.system.push(
      buildReviewPrompt({
        change_files: otherFiles(st).join("\n"),
        current_file_path: file,
        diff: st.diffMap[file] ?? "",
        current_system_date_time: new Date().toISOString(),
        requirement_background: st.requirementBackground,
        system_rule: st.systemRule,
        framework_rules: st.frameworkRules,
        plan_guidance: st.planGuidance,
      })
    );
    output.system.push(
      `Write every finding's \`message\` and \`rule\` text in ${languageName(st.language)}. ` +
        `Keep enum values (category, severity) and code identifiers as-is.`
    );
  };

  return {
    tools: {
      k_review_context,
      file_read,
      file_read_diff,
      file_find,
      code_search,
      k_review_submit,
    },
    systemTransform,
  };
}
