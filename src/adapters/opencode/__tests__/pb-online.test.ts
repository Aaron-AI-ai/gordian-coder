import { describe, expect, test } from "bun:test";
import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin";
import { createPbOnlineModule } from "../pb-online";
import { PB_ONLINE_COMMAND_NAME, PB_ONLINE_GUIDE_TOOL } from "../../../core/pb-online";

type Config = Parameters<NonNullable<Hooks["config"]>>[0];

const TEMPLATES = [
  "ControllerTemplate.java",
  "QryServiceTemplate.java",
  "UpdServiceTemplate.java",
  "VoInTemplate.java",
  "VoOutTemplate.java",
  "VoInNestedTemplate.java",
  "VoOutNestedTemplate.java",
];

const mod = () => createPbOnlineModule({ directory: process.cwd() } as unknown as PluginInput);

describe("pb-online module", () => {
  test("registers the /pb-online-code command carrying the workflow and user arguments", async () => {
    const cfg = {} as Config;
    await mod().config!(cfg);
    const cmd = cfg.command![PB_ONLINE_COMMAND_NAME]!;
    expect(cmd.template).toContain("FICO PB Online Code Generation Workflow");
    expect(cmd.template).toContain(PB_ONLINE_GUIDE_TOOL);
    expect(cmd.template).toContain("$ARGUMENTS");
    // Cline-only tool syntax must not leak into the OpenCode prompt.
    expect(cmd.template).not.toContain("<ask_followup_question>");
    expect(cmd.template).not.toContain("<list_files>");
  });

  test("keeps a user-defined command of the same name", async () => {
    const cfg = { command: { [PB_ONLINE_COMMAND_NAME]: { template: "mine" } } } as Config;
    await mod().config!(cfg);
    expect(cfg.command![PB_ONLINE_COMMAND_NAME]!.template).toBe("mine");
  });

  test("guide tool returns the skill with every rule, doc and template inlined", async () => {
    const guide = await mod().tools[PB_ONLINE_GUIDE_TOOL]!.execute({}, {} as ToolContext);
    expect(guide).toContain("# pb-fixed-online-code");
    for (const path of [
      "rules/fico-overview.md",
      "rules/online-dev-guide.md",
      "rules/online-project-context.md",
      "rules/pb-comment-template.md",
      "docs/pb-fixed-vo-rule.md",
      "docs/pb-fixed-controller-rule.md",
      "docs/pb-service-rule.md",
      "docs/pb-code-verification-rule.md",
      ...TEMPLATES.map((t) => `templates/${t}`),
    ]) {
      expect(guide).toContain(`## File: ${path}`);
    }
    expect(guide).toContain("public class {ServiceId}Controller");
    expect(guide).toContain("@FixedVo");
  });
});
