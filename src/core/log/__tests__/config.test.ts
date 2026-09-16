import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLogConfig, LOG_DEFAULTS } from "../config";

function project(json?: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), "f-log-cfg-"));
  if (json !== undefined) {
    mkdirSync(join(cwd, ".fico/config"), { recursive: true });
    writeFileSync(join(cwd, ".fico/config/fico_ai.json"), JSON.stringify(json));
  }
  return cwd;
}

describe("loadLogConfig", () => {
  test("no config file → defaults, ko, empty KB", () => {
    const c = loadLogConfig(project());
    expect(c.output).toBe(LOG_DEFAULTS.output);
    expect(c.runsDir).toBe(".fico/f-log/runs/");
    expect(c.judgeThreshold).toBe(70);
    expect(c.judgeRounds).toBe(2);
    expect(c.contextMaxChars).toBe(40_000);
    expect(c.judge).toBe(true);
    expect(c.language).toBe("ko");
    expect(c.frameworkKb).toEqual({});
  });

  test("log section overrides, review section is inherited", () => {
    const c = loadLogConfig(
      project({
        review: { language: "en", frameworkKb: { "a.b.*": "kb/" }, maxToolCalls: 20, judgeThreshold: 80 },
        log: { output: "out/", judgeRounds: 1, contextMaxChars: 12000 },
      })
    );
    expect(c.output).toBe("out/");
    expect(c.judgeRounds).toBe(1);
    expect(c.contextMaxChars).toBe(12000);
    expect(c.judgeThreshold).toBe(80); // inherited from review when log omits it
    expect(c.language).toBe("en");
    expect(c.frameworkKb).toEqual({ "a.b.*": "kb/" });
    expect(c.maxToolCalls).toBe(20);
  });

  test("wrong-typed log values fall back per field", () => {
    const c = loadLogConfig(project({ log: { judgeRounds: "two", output: 5 } }));
    expect(c.judgeRounds).toBe(2);
    expect(c.output).toBe(LOG_DEFAULTS.output);
  });
});
