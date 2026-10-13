import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogModule } from "../log";
import { createModules } from "../modules";
import { beforeReviewToolCall } from "../repeat-guard";
import { setLogState, newLogSession } from "../../../core/log/state";

const input = { directory: mkdtempSync(join(tmpdir(), "f-log-mod-")), client: { session: { promptAsync: async () => {} } } } as unknown as Parameters<typeof createLogModule>[0];

describe("createLogModule", () => {
  const m = createLogModule(input);
  test("registers the thirteen f_log tools and nothing else", () => {
    expect(Object.keys(m.tools).sort()).toEqual([
      "f_log_blame", "f_log_callers", "f_log_context", "f_log_finalize", "f_log_find", "f_log_history",
      "f_log_judge", "f_log_judge_context", "f_log_plan", "f_log_read", "f_log_related", "f_log_search", "f_log_submit",
    ]);
  });
  test("config hook injects both agents and the command without overriding user definitions", async () => {
    const cfg: any = { agent: { "f-log-analyst": { prompt: "user's own" } } };
    await m.config!(cfg);
    expect(cfg.agent["f-log-analyst"].prompt).toBe("user's own");
    expect(cfg.agent["f-log-judge"].mode).toBe("subagent");
    expect(cfg.agent["f-log-judge"].steps).toBe(6);
    expect(cfg.command["f-log"].template).toContain("f_log_plan");
  });
  test("guard module is registered: an active log session is gated with f_log_submit advice", () => {
    setLogState("mod-s", { ...newLogSession(input.directory, "r", 1, 4, 20), toolBudgetExhausted: true });
    const d = beforeReviewToolCall("mod-s", "f_log_read");
    expect(d.allow).toBe(false);
    expect(d.message).toContain("f_log_submit");
    expect(beforeReviewToolCall("mod-s", "f_log_submit").allow).toBe(true);
  });
  test("module registry includes it after review", () => {
    const names = createModules(input).flatMap((x) => Object.keys(x.tools));
    expect(names).toContain("f_review_plan");
    expect(names).toContain("f_log_plan");
    expect(new Set(names).size).toBe(names.length); // no tool name collisions across modules
  });
});

describe("f-log command.execute.before", () => {
  const m = createLogModule(input);
  const TRACE = "java.lang.NullPointerException: row is null\n\tat a.Svc.run(Svc.java:2)";
  const parts = (text: string) => [{ type: "text", text }, { type: "file", url: "file:///x" }];

  test("plans the run in code and swaps the template for a start-at-step-2 prompt", async () => {
    const out = { parts: parts(`template with ${TRACE} pasted`) };
    await m.commandBefore!({ command: "f-log", sessionID: "s", arguments: `--no-judge ${TRACE}` }, out);
    const text = out.parts[0].text!;
    expect(text).toMatch(/runId: \S+/);
    expect(text).toContain("judge: off");
    expect(text).toContain("Do NOT call f_log_plan");
    expect(text).toContain("f-log-analyst");
    expect(text).not.toContain(TRACE); // the model never sees (or re-emits) the trace
    expect(out.parts[1]).toEqual({ type: "file", url: "file:///x" }); // attachments untouched
  });
  test("a plan failure becomes a relay-and-stop instruction", async () => {
    const out = { parts: parts("template") };
    await m.commandBefore!({ command: "f-log", sessionID: "s", arguments: "no trace here" }, out);
    expect(out.parts[0].text).toContain("⚠️");
    expect(out.parts[0].text).toContain("verbatim");
    expect(out.parts[0].text).not.toContain("f-log-analyst");
  });
  test("other commands pass through", async () => {
    const out = { parts: parts("other") };
    await m.commandBefore!({ command: "f-review", sessionID: "s", arguments: TRACE }, out);
    expect(out.parts[0].text).toBe("other");
  });
});
