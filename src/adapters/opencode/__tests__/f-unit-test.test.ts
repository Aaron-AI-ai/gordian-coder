import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createFUnitTestModule } from "../f-unit-test";
import { createModules } from "../modules";
import { COMMAND_NAME, MAX_WAIT_CALLS, STAGE_TOOL, endSession, getSession, noteUserMessage } from "../../../core/f-unit-test/workflow";
import { COMMAND_NAME as PB_COMMAND, endSession as pbEnd, getSession as pbGet } from "../../../core/pb-online/workflow";

const z = tool.schema;
type Config = Parameters<NonNullable<Hooks["config"]>>[0];

const SID = "ses-fut";
const MODULE = "mod-online";
const TARGET = `${MODULE}/src/main/java/a/b/Svc.java`;
const TEST_FILE = `${MODULE}/src/test/java/a/b/SvcTest.java`;
const plan = {
  mode: "files",
  module: MODULE,
  targets: [TARGET],
  files: [TEST_FILE],
  cases: [{ target: TARGET, method: "m", normal: ["a", "b"], boundary: ["c"], exception: ["d"], mocks: [] }],
};

let dir: string;
const mod = (client?: unknown) => createFUnitTestModule({ directory: dir, client } as unknown as PluginInput);
const start = (m: ReturnType<typeof mod>, sid = SID) =>
  m.commandBefore!({ command: COMMAND_NAME, sessionID: sid, arguments: "--files Svc.java" }, { parts: [] });
const ctx = { sessionID: SID } as ToolContext;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fut-adapter-"));
  fs.mkdirSync(path.join(dir, MODULE, "src/main/java/a/b"), { recursive: true });
  fs.writeFileSync(path.join(dir, TARGET), "class Svc {}\n");
});
afterEach(() => {
  endSession(SID);
  pbEnd(SID);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("f-unit-test module", () => {
  test("registers the command and keeps a user-defined one", async () => {
    const cfg = {} as Config;
    await mod().config!(cfg);
    expect(cfg.command![COMMAND_NAME]!.template).toContain(STAGE_TOOL);
    const own = { command: { [COMMAND_NAME]: { template: "mine" } } } as Config;
    await mod().config!(own);
    expect(own.command![COMMAND_NAME]!.template).toBe("mine");
  });

  test("other commands start nothing", async () => {
    for (const command of ["f-review", "f-log", PB_COMMAND]) {
      await mod().commandBefore!({ command, sessionID: SID, arguments: "" }, { parts: [] });
    }
    expect(getSession(SID)).toBeUndefined();
  });

  test("the slash command starts its session only, and not pb-online", async () => {
    await start(mod());
    expect(getSession(SID)!.stage).toBe("plan");
    expect(getSession("another")).toBeUndefined();
    expect(pbGet(SID)).toBeUndefined();
  });

  test("gate throws inside the workflow only", async () => {
    const m = mod();
    expect(() => m.toolBefore!("write", "another", { filePath: "x" })).not.toThrow();
    await start(m);
    expect(() => m.toolBefore!("write", SID, { filePath: "x" })).toThrow(/plan/);
  });

  test("system transform adds the guide to workflow sessions only", async () => {
    const m = mod();
    const other = { system: [] as string[] };
    await m.systemTransform!({ sessionID: "another" } as never, other);
    expect(other.system).toEqual([]);
    await start(m);
    const mine = { system: [] as string[] };
    await m.systemTransform!({ sessionID: SID } as never, mine);
    expect(mine.system.join("\n")).toContain("plan");
  });

  test("a user message event unlocks approval", async () => {
    const m = mod();
    await start(m);
    const t = m.tools[STAGE_TOOL]!;
    expect(await t.execute({ stage: "plan", note: "p", inputs: plan }, ctx)).toContain("Plan recorded");
    await m.event!({
      event: { type: "message.updated", properties: { info: { role: "user", sessionID: SID, time: { created: Date.now() + 1 } } } },
    } as never);
    await t.execute({ stage: "plan", user_approved: true }, ctx);
    expect(getSession(SID)!.stage).toBe("execute");
  });

  test("a tool call while the plan waits aborts the session exactly once", async () => {
    const aborted: string[] = [];
    const client = { session: { abort: async ({ path }: { path: { id: string } }) => void aborted.push(path.id) } };
    const m = mod(client);
    await start(m);
    await m.tools[STAGE_TOOL]!.execute({ stage: "plan", note: "p", inputs: plan }, ctx);
    for (let i = 0; i < MAX_WAIT_CALLS; i++) {
      try {
        m.toolBefore!("read", SID, {});
      } catch {}
    }
    await Bun.sleep(0);
    expect(aborted).toEqual([SID]);
  });

  test("a write is tracked through toolAfter", async () => {
    const m = mod();
    await start(m);
    const t = m.tools[STAGE_TOOL]!;
    await t.execute({ stage: "plan", note: "p", inputs: plan }, ctx);
    noteUserMessage(SID, Date.now() + 1);
    await t.execute({ stage: "plan", user_approved: true }, ctx);
    const args = { filePath: path.join(dir, TEST_FILE) };
    m.toolBefore!("write", SID, args);
    m.toolAfter!("write", SID, {}, "", args);
    expect([...getSession(SID)!.touched]).toEqual([TEST_FILE]);
  });
});

describe("with both workflows registered", () => {
  test("a gate in one session never rejects the other's tools", async () => {
    const mods = createModules({ directory: dir } as unknown as PluginInput);
    const gate = (tool: string, sid: string) => () => mods.forEach((m) => m.toolBefore?.(tool, sid, { filePath: "x" }));
    for (const m of mods) await m.commandBefore?.({ command: COMMAND_NAME, sessionID: SID, arguments: "x" }, { parts: [] });
    for (const m of mods) await m.commandBefore?.({ command: PB_COMMAND, sessionID: "pb-ses", arguments: "X" }, { parts: [] });
    expect(getSession(SID)).toBeDefined();
    expect(pbGet(SID)).toBeUndefined();
    expect(getSession("pb-ses")).toBeUndefined();
    expect(gate("write", SID)).toThrow(/f-unit-test-code/);
    expect(gate("write", "pb-ses")).toThrow(/pb-online/);
    expect(gate("read", "unrelated")).not.toThrow();
    pbEnd("pb-ses");
  });

  test("another slash command in the same session ends the f-unit-test workflow", async () => {
    const m = mod();
    await start(m);
    await m.commandBefore!({ command: "f-review", sessionID: "another", arguments: "" }, { parts: [] });
    expect(getSession(SID)).toBeDefined();
    await m.commandBefore!({ command: "f-review", sessionID: SID, arguments: "" }, { parts: [] });
    expect(getSession(SID)).toBeUndefined();
    expect(() => m.toolBefore!("write", SID, { filePath: "x" })).not.toThrow();
  });

  test("the stage tool schema accepts a skip_reason-only case", () => {
    const schema = z.object(mod().tools[STAGE_TOOL]!.args);
    const parsed = schema.safeParse({
      stage: "plan",
      note: "p",
      inputs: { ...plan, cases: [...plan.cases, { target: TARGET, method: "toString", skip_reason: "generated" }] },
    });
    expect(parsed.success).toBe(true);
  });
});

