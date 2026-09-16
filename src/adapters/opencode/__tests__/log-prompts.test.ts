import { describe, expect, test } from "bun:test";
import {
  ANALYST_AGENT_NAME, ANALYST_AGENT_PERMISSION, ANALYST_AGENT_TOOLS, ANALYST_AGENT_PROMPT, analystAgentSteps,
  JUDGE_AGENT_NAME, LOG_JUDGE_AGENT_PERMISSION, LOG_JUDGE_AGENT_STEPS, LOG_COMMAND_NAME, LOG_COMMAND_TEMPLATE,
} from "../log/prompts";
import { LOG_EXPLORERS } from "../../../core/log/tools";
import { JUDGE_AGENT_STEPS, reviewerAgentSteps } from "../review/prompts";

describe("f-log agent definitions", () => {
  test("analyst allows exactly context + 7 explorers + submit, denies everything else", () => {
    expect(ANALYST_AGENT_NAME).toBe("f-log-analyst");
    expect(ANALYST_AGENT_PERMISSION["*"]).toBe("deny");
    for (const t of LOG_EXPLORERS) expect(ANALYST_AGENT_PERMISSION[t]).toBe("allow");
    expect(ANALYST_AGENT_PERMISSION.f_log_context).toBe("allow");
    expect(ANALYST_AGENT_PERMISSION.f_log_submit).toBe("allow");
    expect(ANALYST_AGENT_PERMISSION.f_log_judge).toBeUndefined();
    expect(ANALYST_AGENT_PERMISSION.file_read).toBeUndefined(); // review's tools are not the analyst's
    expect(ANALYST_AGENT_TOOLS["*"]).toBe(false);
    expect(ANALYST_AGENT_TOOLS.f_log_read).toBe(true);
  });
  test("judge allows only its two tools; steps reuse review's constants", () => {
    expect(JUDGE_AGENT_NAME).toBe("f-log-judge");
    expect(Object.entries(LOG_JUDGE_AGENT_PERMISSION).filter(([, v]) => v === "allow").map(([k]) => k).sort()).toEqual(["f_log_judge", "f_log_judge_context"]);
    expect(LOG_JUDGE_AGENT_STEPS).toBe(JUDGE_AGENT_STEPS);
    expect(analystAgentSteps(10)).toBe(reviewerAgentSteps(10));
  });
  test("command template parses --file/--output/--judge and forbids self-analysis", () => {
    expect(LOG_COMMAND_NAME).toBe("f-log");
    expect(LOG_COMMAND_TEMPLATE).toContain("$ARGUMENTS");
    for (const s of ["--file=", "--output=", "--judge", "f_log_plan", "f_log_finalize", "f-log-analyst", "f-log-judge", "NEVER"]) expect(LOG_COMMAND_TEMPLATE).toContain(s);
    expect(ANALYST_AGENT_PROMPT).toContain("f_log_context");
    expect(ANALYST_AGENT_PROMPT).toContain("f_log_submit");
  });
});
