import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAssetsDir } from "../../../adapters/opencode/fico-setup";
import { UNIT_TEST_SKILL_NAME } from "../../pb-online/names";
import { ENV_FAILURE_PATTERN, environmentFailureLine, isEnvironmentFailure } from "../env-failure";

const NEXUS_429 =
  "> Could not HEAD 'http://nexus/x/maven-metadata.xml'. Received status code 429 from server: Too many authentication attempts";

describe("environment failure", () => {
  test.each([
    NEXUS_429,
    "   > Could not resolve kr.co.koscom.pb:ver-checkstyle:0.0.1-SNAPSHOT.",
    "> No cached version of org.x:y:1.0 available for offline mode.",
    "> Could not GET 'https://repo/x.pom'.",
    "Unable to load Maven meta-data from http://nexus/x",
    "Received status code 503 from server: Service Unavailable",
    "Received status code 401 from server: Unauthorized",
    "Connection refused (Connection refused)",
    "java.net.UnknownHostException: nexus.local",
    "Read timed out",
    "connection timed out",
  ])("%s is an environment failure", (line) => {
    expect(isEnvironmentFailure(`FAILURE: Build failed\n${line}\nBUILD FAILED`)).toBe(true);
  });

  test.each([
    "SONAQ001ServiceTest.java:12: error: cannot find symbol\n  symbol: class AccountBSM",
    "error: package kr.co.x does not exist",
    "Execution failed for task ':m:compileTestJava'.\n> Compilation failed; see the compiler error output for details.",
    "[run-coverage] gradle mode: offline",
    "[run-coverage] gradle mode: offline failed on dependency resolution -> retried online",
    "",
  ])("%j is not an environment failure", (log) => {
    expect(isEnvironmentFailure(log)).toBe(false);
  });

  test("the first matching line is returned trimmed", () => {
    const log = `FAILURE\n   > Could not resolve a:b:1.\n${NEXUS_429}`;
    expect(environmentFailureLine(log)).toBe("> Could not resolve a:b:1.");
    expect(environmentFailureLine("error: cannot find symbol")).toBeNull();
  });

  test.each(["run-coverage.sh", "run-coverage.ps1"])("%s retries online on exactly the plugin's pattern", (name) => {
    const src = fs.readFileSync(path.join(resolveAssetsDir(), "fico-ai/skills", UNIT_TEST_SKILL_NAME, "scripts", name), "utf8");
    expect(src).toContain(`'${ENV_FAILURE_PATTERN}'`);
    expect(src).toContain("--offline");
  });
});
