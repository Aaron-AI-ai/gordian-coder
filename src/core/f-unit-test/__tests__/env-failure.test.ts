import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAssetsDir } from "../../../adapters/opencode/fico-setup";
import { UNIT_TEST_SKILL_NAME } from "../../pb-online/names";
import { ENV_FAILURE_PATTERN, JAVAC_ERROR_PATTERN, MAIN_JAVAC_ERROR_PATTERN, environmentFailureLine, isEnvironmentFailure } from "../env-failure";

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
    "Server returned HTTP response code: 429 for URL: https://nexus/x.pom",
    "Server returned HTTP response code: 502 for URL: https://nexus/x.pom",
    "> Could not find kr.co.koscom.pb:ver-common:1.0.0.",
    "> Could not download ver-common-1.0.0.jar (kr.co.koscom.pb:ver-common:1.0.0)",
  ])("%s is an environment failure", (line) => {
    expect(isEnvironmentFailure(`FAILURE: Build failed\n${line}\nBUILD FAILED`)).toBe(true);
  });

  test.each([
    "SONAQ001ServiceTest.java:12: error: cannot find symbol\n  symbol: class AccountBSM",
    "error: package kr.co.x does not exist",
    "Execution failed for task ':m:compileTestJava'.\n> Compilation failed; see the compiler error output for details.",
    "[run-coverage] gradle mode: offline",
    "[run-coverage] gradle mode: offline failed on dependency resolution -> retried online",
    "[run-coverage] gradle mode: offline failed with main-source errors -> retried online",
    "Could not find method testImplementation() for arguments",
    "",
  ])("%j is not an environment failure", (log) => {
    expect(isEnvironmentFailure(log)).toBe(false);
  });

  test("a javac error is never an environment failure, even when a source line matches", () => {
    const javac = [
      "/p/m/src/test/java/x/AT.java:5: error: cannot find symbol",
      "import java.net.UnknownHostException;",
      "                ^",
      "/p/m/src/test/java/x/AT.java:9: error: unreported exception; String s = \"Connection refused, status code 500, offline mode\";",
      "2 errors",
    ].join("\n");
    expect(isEnvironmentFailure(javac)).toBe(false);
    expect(isEnvironmentFailure(`C:\\p\\m\\src\\test\\java\\x\\AT.java:5: error: x\n${NEXUS_429}`)).toBe(false);
    expect(isEnvironmentFailure(`FAILURE\n${NEXUS_429}`)).toBe(true);
  });

  test("main-source javac errors are told apart from test-source ones (both path styles)", () => {
    const main = new RegExp(MAIN_JAVAC_ERROR_PATTERN);
    const javac = new RegExp(JAVAC_ERROR_PATTERN);
    expect(main.test("/p/m/src/main/java/x/A.java:3: error: cannot find symbol")).toBe(true);
    expect(main.test("C:\\p\\m\\src\\main\\java\\x\\A.java:3: error: cannot find symbol")).toBe(true);
    expect(main.test("/p/m/src/test/java/x/AT.java:3: error: cannot find symbol")).toBe(false);
    expect(javac.test("/p/m/src/test/java/x/AT.java:3: error: cannot find symbol")).toBe(true);
    expect(javac.test("warning: [deprecation] x in A.java has been deprecated")).toBe(false);
  });

  test("the first matching line is returned trimmed", () => {
    const log = `FAILURE\n   > Could not resolve a:b:1.\n${NEXUS_429}`;
    expect(environmentFailureLine(log)).toBe("> Could not resolve a:b:1.");
    expect(environmentFailureLine("error: cannot find symbol")).toBeNull();
  });

  test.each(["run-coverage.sh", "run-coverage.ps1"])("%s retries online on exactly the plugin's pattern", (name) => {
    const src = fs.readFileSync(path.join(resolveAssetsDir(), "fico-ai/skills", UNIT_TEST_SKILL_NAME, "scripts", name), "utf8");
    for (const p of [ENV_FAILURE_PATTERN, JAVAC_ERROR_PATTERN, MAIN_JAVAC_ERROR_PATTERN]) expect(src).toContain(`'${p}'`);
    expect(src).toContain("--offline");
  });
});
