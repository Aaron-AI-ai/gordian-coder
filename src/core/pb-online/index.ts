/**
 * PB fixed-text online code generation (port of fico-ai's
 * `workflows/fico-pb-online-code-gen.md` + `skills/pb-fixed-online-code` + `rules/`).
 *
 * The workflow becomes a slash-command template; the skill (with every rule,
 * doc and template inlined) is served by a guide tool the workflow calls at its
 * final step. Assets are bundled as text so the plugin needs no files on disk.
 */

import WORKFLOW from "./assets/workflow.md" with { type: "text" };
import SKILL from "./assets/SKILL.md" with { type: "text" };
import FICO_OVERVIEW from "./assets/rules/fico-overview.md" with { type: "text" };
import ONLINE_DEV_GUIDE from "./assets/rules/online-dev-guide.md" with { type: "text" };
import ONLINE_PROJECT_CONTEXT from "./assets/rules/online-project-context.md" with { type: "text" };
import PB_COMMENT_TEMPLATE from "./assets/rules/pb-comment-template.md" with { type: "text" };
import VO_RULE from "./assets/docs/pb-fixed-vo-rule.md" with { type: "text" };
import CONTROLLER_RULE from "./assets/docs/pb-fixed-controller-rule.md" with { type: "text" };
import SERVICE_RULE from "./assets/docs/pb-service-rule.md" with { type: "text" };
import VERIFICATION_RULE from "./assets/docs/pb-code-verification-rule.md" with { type: "text" };
import CONTROLLER_TPL from "./assets/templates/ControllerTemplate.java" with { type: "text" };
import QRY_SERVICE_TPL from "./assets/templates/QryServiceTemplate.java" with { type: "text" };
import UPD_SERVICE_TPL from "./assets/templates/UpdServiceTemplate.java" with { type: "text" };
import VO_IN_TPL from "./assets/templates/VoInTemplate.java" with { type: "text" };
import VO_OUT_TPL from "./assets/templates/VoOutTemplate.java" with { type: "text" };
import VO_IN_NESTED_TPL from "./assets/templates/VoInNestedTemplate.java" with { type: "text" };
import VO_OUT_NESTED_TPL from "./assets/templates/VoOutNestedTemplate.java" with { type: "text" };

export const PB_ONLINE_COMMAND_NAME = "pb-online-code";
export const PB_ONLINE_GUIDE_TOOL = "pb_online_code_guide";

export const PB_ONLINE_COMMAND_DESCRIPTION =
  "FICO PB 고정길이 온라인 코드(Controller/Service/In·Out VO) 스켈레톤 생성";

export const PB_ONLINE_GUIDE_DESCRIPTION =
  "Load the pb-fixed-online-code skill: generation steps plus every FICO rule, VO/Controller/Service rule, verification rule and Java template needed to scaffold a PB fixed-text online service. Call this at the code-generation step of the /pb-online-code workflow, after the plan and target file were confirmed by the user.";

export const PB_ONLINE_COMMAND_TEMPLATE = `${WORKFLOW}
User request: $ARGUMENTS`;

const FILES: Array<[path: string, content: string, lang: string]> = [
  ["rules/fico-overview.md", FICO_OVERVIEW, "markdown"],
  ["rules/online-dev-guide.md", ONLINE_DEV_GUIDE, "markdown"],
  ["rules/online-project-context.md", ONLINE_PROJECT_CONTEXT, "markdown"],
  ["rules/pb-comment-template.md", PB_COMMENT_TEMPLATE, "markdown"],
  ["docs/pb-fixed-vo-rule.md", VO_RULE, "markdown"],
  ["docs/pb-fixed-controller-rule.md", CONTROLLER_RULE, "markdown"],
  ["docs/pb-service-rule.md", SERVICE_RULE, "markdown"],
  ["docs/pb-code-verification-rule.md", VERIFICATION_RULE, "markdown"],
  ["templates/ControllerTemplate.java", CONTROLLER_TPL, "java"],
  ["templates/QryServiceTemplate.java", QRY_SERVICE_TPL, "java"],
  ["templates/UpdServiceTemplate.java", UPD_SERVICE_TPL, "java"],
  ["templates/VoInTemplate.java", VO_IN_TPL, "java"],
  ["templates/VoOutTemplate.java", VO_OUT_TPL, "java"],
  ["templates/VoInNestedTemplate.java", VO_IN_NESTED_TPL, "java"],
  ["templates/VoOutNestedTemplate.java", VO_OUT_NESTED_TPL, "java"],
];

/** The skill text followed by each referenced file, fenced so markdown inside stays intact. */
export const PB_ONLINE_GUIDE = [
  SKILL,
  ...FILES.map(([path, content, lang]) => `---\n\n## File: ${path}\n\n~~~~${lang}\n${content.trimEnd()}\n~~~~\n`),
].join("\n");
