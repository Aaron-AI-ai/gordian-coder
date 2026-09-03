/**
 * The per-file review prompt template and its `{{var}}` substitution.
 *
 * Injected into the system prompt (via the OpenCode `system.transform` hook)
 * for the file currently under review. Optional sections collapse when their
 * variable is empty so the reviewer never sees a dangling heading.
 */

export const TEMPLATE = `You are a code reviewer. {{review_instruction}}

// The following is the list of other files changed in this update.
<other_changed_files>
{{change_files}}
</other_changed_files>

<current_file_path>{{current_file_path}}</current_file_path>

{{review_target}}

<review_evidence>
{{review_evidence}}
</review_evidence>

Current time in the real world: {{current_system_date_time}}

<user_task>
### Requirement Background (Optional)
{{requirement_background}}

### Review Checklist
{{system_rule}}

### Framework Rules (AUTHORITATIVE — override general best practices)
{{framework_rules}}

When a general convention conflicts with a Framework Rule above, the Framework
Rule wins; never suggest a change that violates it. Always assess the
"framework" category and report any framework-convention violation.

### Related Code and Change History
The <review_evidence> block is collected deterministically to help you review
dependencies, callers, tests, and regression risk even with limited reasoning.
Use it as leads, not proof. Inspect high-confidence related files when the
current change can affect them. Use related_code for a refreshed candidate
list and git_history(include_patch=true) when a prior change may explain intent
or reveal a regression.

### Review Plan (Optional)
{{plan_guidance}}

EVERY finding MUST carry TWO fields so the reader sees exactly what to change:
\`asIs\` (the problematic code as it is now) and \`toBe\` (the corrected code,
ready to paste over it). Write the code alone in each — no AS-IS:/TO-BE:
labels, the report adds those:

  "asIs": "<the problematic code as it is now>",
  "toBe": "<the corrected code>"

Keep both minimal — only the lines that change plus the context needed to
locate them. When a finding has no direct code replacement (e.g. a missing
test or config), \`asIs\` shows the current state (or \`(none)\`) and \`toBe\`
shows the code/config to add. \`toBe\` is the field a reader acts on: never
leave it empty to make room for a longer \`asIs\`.

Now please {{review_action}}.
When you need more context, use file_read (wider context), code_search (symbols/usages),
file_find (locate files), file_read_diff (other changed files), related_code
(ranked dependencies/callers/tests), or git_history (previous changes).
These are the ONLY tools you may explore with. NEVER use the host's built-in
file tools (Read / Grep / Glob / bash / …): they read the working tree instead
of the reviewed ref and bypass the exploration budget. When a tool result says
a file or symbol does not exist, or that output is withheld, accept it and move
on — do not re-fetch the same content again or through any other tool.
When done with THIS file, call f_review_submit.
</user_task>`;

export type TemplateVars = {
  change_files: string;
  current_file_path: string;
  // Mode-specific target framing, filled by targetVars(): the intro sentence,
  // the tagged content block (diff or whole file), and the closing action.
  review_instruction: string;
  review_target: string;
  review_action: string;
  current_system_date_time: string;
  requirement_background?: string;
  system_rule: string;
  framework_rules: string;
  review_evidence: string;
  plan_guidance?: string;
};

export type TargetKind = "diff" | "whole" | "segment";

/**
 * Build the three mode-specific template vars. Diff mode reviews the change
 * hunks; whole mode reviews the entire (line-numbered) file; segment mode
 * reviews one line-range slice of a large file (with its `range` noted).
 */
export function targetVars(
  kind: TargetKind,
  content: string,
  range?: { start: number; end: number }
): Pick<TemplateVars, "review_instruction" | "review_target" | "review_action"> {
  if (kind === "diff") {
    return {
      review_instruction: "Review the change in <current_file_diff> against the checklist.",
      review_target: `<current_file_diff>\n${content}\n</current_file_diff>`,
      review_action: "review the code changes in <current_file_diff>",
    };
  }
  if (kind === "segment" && range) {
    const span = `lines ${range.start}-${range.end}`;
    return {
      review_instruction:
        `Review ${span} of <current_file> — one segment of a large file — against the ` +
        `checklist. Content outside these lines is shown only as related declarations.`,
      review_target: `<current_file>\n${content}\n</current_file>`,
      review_action: `review the code in <current_file> (${span})`,
    };
  }
  return {
    review_instruction: "Review the full contents of <current_file> against the checklist.",
    review_target: `<current_file>\n${content}\n</current_file>`,
    review_action: "review the whole file in <current_file>",
  };
}

const OPTIONAL_SECTIONS: Array<{ heading: string; key: keyof TemplateVars }> = [
  { heading: "### Requirement Background (Optional)", key: "requirement_background" },
  { heading: "### Review Plan (Optional)", key: "plan_guidance" },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Substitute `{{key}}` tokens; drop optional sections whose value is empty. */
export function render(tpl: string, vars: Partial<TemplateVars>): string {
  let out = tpl;
  for (const s of OPTIONAL_SECTIONS) {
    const v = vars[s.key];
    if (!v || !v.trim()) {
      const re = new RegExp(`${escapeRegExp(s.heading)}\\n\\{\\{${s.key}\\}\\}\\n?`, "g");
      out = out.replace(re, "");
    }
  }
  return out.replace(/\{\{(\w+)\}\}/g, (_, k: string) => (vars as Record<string, string>)[k] ?? "");
}

export function buildReviewPrompt(vars: Partial<TemplateVars>): string {
  return render(TEMPLATE, vars);
}
