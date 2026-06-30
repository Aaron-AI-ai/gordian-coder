/**
 * The per-file review prompt template and its `{{var}}` substitution.
 *
 * Injected into the system prompt (via the OpenCode `system.transform` hook)
 * for the file currently under review. Optional sections collapse when their
 * variable is empty so the reviewer never sees a dangling heading.
 */

export const TEMPLATE = `You are a code reviewer. Review the change in <current_file_diff> against the checklist.

// The following is the list of other files changed in this update.
<other_changed_files>
{{change_files}}
</other_changed_files>

<current_file_path>{{current_file_path}}</current_file_path>

<current_file_diff>
{{diff}}
</current_file_diff>

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

### Review Plan (Optional)
{{plan_guidance}}

Now please review the code changes in <current_file_diff>.
When you need more context, use file_read (wider context), code_search (symbols/usages),
file_find (locate files), or file_read_diff (other changed files).
When done with THIS file, call k_review_submit.
</user_task>`;

export type TemplateVars = {
  change_files: string;
  current_file_path: string;
  diff: string;
  current_system_date_time: string;
  requirement_background?: string;
  system_rule: string;
  framework_rules: string;
  plan_guidance?: string;
};

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
