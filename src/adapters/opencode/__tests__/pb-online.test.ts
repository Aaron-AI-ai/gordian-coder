import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin";
import { createPbOnlineModule } from "../pb-online";
import { COMMAND_NAME, KB_TOOL, STAGES, STAGE_TOOL, endSession, getSession } from "../../../core/pb-online/workflow";

type Config = Parameters<NonNullable<Hooks["config"]>>[0];

const SID = "ses-adapter";
const mod = () => createPbOnlineModule({ directory: process.cwd() } as unknown as PluginInput);
const start = (m: ReturnType<typeof mod>) =>
  m.commandBefore!({ command: COMMAND_NAME, sessionID: SID, arguments: "AIAC0007" }, { parts: [] });

afterEach(() => endSession(SID));

describe("pb-online module", () => {
  test("registers the command around the skill, not a bundled copy of it", async () => {
    const cfg = {} as Config;
    await mod().config!(cfg);
    const cmd = cfg.command![COMMAND_NAME]!;
    expect(cmd.template).toContain("pb-fixed-online-code");
    expect(cmd.template).toContain(STAGE_TOOL);
    expect(cmd.template).toContain("$ARGUMENTS");
    expect(cmd.template).not.toContain("public class {ServiceId}Controller");
  });

  test("keeps a user-defined command of the same name", async () => {
    const cfg = { command: { [COMMAND_NAME]: { template: "mine" } } } as Config;
    await mod().config!(cfg);
    expect(cfg.command![COMMAND_NAME]!.template).toBe("mine");
  });

  test("other commands such as f-review and f-log start nothing", async () => {
    for (const command of ["f-review", "f-log"]) {
      await mod().commandBefore!({ command, sessionID: SID, arguments: "" }, { parts: [] });
    }
    expect(getSession(SID)).toBeUndefined();
  });

  test("the slash command starts the workflow for its session only", async () => {
    await start(mod());
    expect(getSession(SID)!.stage).toBe("plan");
    expect(getSession("another")).toBeUndefined();
  });

  test("gate throws inside the workflow and is silent outside it", async () => {
    const m = mod();
    expect(() => m.toolBefore!("write", "another", { filePath: "x" })).not.toThrow();
    await start(m);
    expect(() => m.toolBefore!("write", SID, { filePath: "x" })).toThrow(/plan/);
  });

  test("system transform adds the guide only to workflow sessions", async () => {
    const m = mod();
    const other = { system: [] as string[] };
    await m.systemTransform!({ sessionID: "another" } as never, other);
    expect(other.system).toEqual([]);

    await start(m);
    const mine = { system: [] as string[] };
    await m.systemTransform!({ sessionID: SID } as never, mine);
    expect(mine.system.join("\n")).toContain("plan");
  });

  test("a user message event unlocks plan approval through the stage tool", async () => {
    const m = mod();
    await start(m);
    const stageTool = m.tools[STAGE_TOOL]!;
    const ctx = { sessionID: SID } as ToolContext;
    m.toolAfter!("read_mcp_resource", SID, { server: "fico-mcp", uri: "fico://program-detail/G/AIAC0007" }, "Resource: x\n{}");
    const inputs = { program_id: "AIAC0007", group_name: "G", target_controller: "C.java", method_name: "m", package_path: "p", files: ["C.java"] };
    await stageTool.execute({ stage: "plan", note: "plan", inputs }, ctx);
    await m.event!({
      event: {
        type: "message.updated",
        properties: { info: { role: "user", sessionID: SID, time: { created: Date.now() + 1 } } },
      },
    } as never);
    await stageTool.execute({ stage: "plan", user_approved: true }, ctx);
    expect(getSession(SID)!.stage).toBe("execute");
  });
});

describe("pb-online loop stop", () => {
  test("keeps calling tools while the plan waits gets the session aborted once", async () => {
    const aborted: string[] = [];
    const client = { session: { abort: async ({ path }: { path: { id: string } }) => void aborted.push(path.id) } };
    const m = createPbOnlineModule({ directory: process.cwd(), client } as unknown as PluginInput);
    await m.commandBefore!({ command: COMMAND_NAME, sessionID: SID, arguments: "x" }, { parts: [] });
    m.toolAfter!("read_mcp_resource", SID, { server: "fico-mcp", uri: "fico://program-detail/G/P1" }, "Resource: x\n{}");
    const inputs = { program_id: "P1", group_name: "G", target_controller: "C.java", method_name: "m", package_path: "p", files: ["C.java"] };
    const ctx = { sessionID: SID } as ToolContext;
    await m.tools[STAGE_TOOL]!.execute({ stage: "plan", note: "plan", inputs }, ctx);
    // Two resubmissions and one write: the third refused call stops the turn.
    for (let i = 0; i < 2; i++) await m.tools[STAGE_TOOL]!.execute({ stage: "plan", note: "plan", inputs }, ctx);
    expect(() => m.toolBefore!("write", SID, { filePath: "x" })).toThrow(/END YOUR TURN/);
    await Bun.sleep(0);
    expect(aborted).toEqual([SID]);
  });
});

describe("pb-online KB search", () => {
  let dir: string;
  const ctx = { sessionID: SID } as ToolContext;
  const modIn = (directory: string) => createPbOnlineModule({ directory } as unknown as PluginInput);
  const startIn = (m: ReturnType<typeof modIn>) =>
    m.commandBefore!({ command: COMMAND_NAME, sessionID: SID, arguments: "AIAC0007" }, { parts: [] });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-kb-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("execute and verify guides name the KB tool, plan does not need it", () => {
    for (const stage of [STAGES.execute, STAGES.verify]) {
      expect(stage.tools).toContain(KB_TOOL);
      expect(stage.steps.join("\n")).toContain(KB_TOOL);
    }
    expect(STAGES.plan.tools).not.toContain(KB_TOOL);
  });

  test("searches the project's KB in a workflow session, with no review running", async () => {
    fs.mkdirSync(path.join(dir, ".fico/config"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".fico/config/fico_ai.json"),
      JSON.stringify({ frameworkKb: { "kr.co.fico.*": ".fico/kb/fico" } })
    );
    fs.mkdirSync(path.join(dir, ".fico/kb/fico"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".fico/kb/fico/PBRequest.md"), "---\ntitle: PBRequest\n---\nbody text\n");

    const m = modIn(dir);
    await startIn(m);
    const out = await m.tools[KB_TOOL]!.execute({ query: "PBRequest" }, ctx);
    expect(out).toContain("PBRequest.md");
    expect(out).toContain("body text");
  });

  test("says so when the project has no KB", async () => {
    const m = modIn(dir);
    await startIn(m);
    expect(await m.tools[KB_TOOL]!.execute({ query: "PBRequest" }, ctx)).toContain("No framework KB");
  });

  test("is inert outside the workflow", async () => {
    expect(await modIn(dir).tools[KB_TOOL]!.execute({ query: "x" }, ctx)).toContain("No /pb-online-code");
  });
});
