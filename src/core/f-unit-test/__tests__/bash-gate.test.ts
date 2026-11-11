import { describe, expect, test } from "bun:test";
import { BASH_RULE, bashAllowed, coverageCommandLine, guideScriptPath, scriptPaths, type BashContext, type BashStage } from "../bash-gate";

const MODULE = "on-stk-ord-online";
const FQCN = "kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001ServiceTest";
const FQCN2 = FQCN.replace("SONAQ001", "SONAQ002");
const OUT = ".fico/report/f-unit-test/report-20261111-120000";
const ARGS = `--module ${MODULE} --tests ${FQCN} --out ${OUT}`;
const CWD = "/work/proj";
const HOME = "/home/u";
const ctx = (tests: string[] = [FQCN], cwd = CWD, home = HOME): BashContext => ({ cwd, home, coverage: { module: MODULE, tests, out: OUT } });
const PROJECT_SCRIPT = ".opencode/skills/f-unit-test-code/scripts/run-coverage.sh";
const GLOBAL_SCRIPT = `${HOME}/.config/opencode/skills/f-unit-test-code/scripts/run-coverage.sh`;

describe("bash gate", () => {
  const MUST_REFUSE: [string, string][] = [
    ["plan", "git diff; rm x"],
    ["plan", "git diff && rm x"],
    ["plan", "git diff || rm x"],
    ["plan", "git diff | tee x"],
    ["plan", "git diff > x"],
    ["plan", "git diff >> x"],
    ["plan", "git log `rm x`"],
    ["plan", "git log $(rm x)"],
    ["plan", "git diff\nrm x"],
    ["plan", "git diff\rrm x"],
    ["plan", "git diff --output=evil.txt"],
    ["plan", "git diff --output evil.txt"],
    ["plan", "git show HEAD:a > src/main/java/X.java"],
    ["execute", "rm -rf src # gradle"],
    ["execute", "echo hi > src/main/java/X.java; ./gradlew"],
    ["execute", "cat > $HOME/x <<E\ngradle\nE"],
    ["execute", `./gradlew -I ${MODULE}/src/test/resources/evil.gradle test`],
    ["execute", "./gradlew --init-script evil.gradle test"],
    ["execute", "./gradlew -p ../other test"],
    ["execute", "./gradlew --project-dir ../other test"],
    ["execute", "git diff; rm x"],
    ["verify", "rm -rf x # run-coverage.sh"],
    ["verify", `echo '{"compile":"ok","coverage":"ok"}' > .fico/x/status.json; : run-coverage.sh`],
    ["verify", "sh run-coverage.sh; rm x"],
    ["verify", "sh run-coverage.sh > /tmp/q"],
    ["verify", "./gradlew test"],
    // round 2: quoting and escaping
    ["plan", 'git diff "--output=x"'],
    ["plan", "git diff '--output'=x"],
    ["plan", "git diff \\--output=x"],
    ["plan", "git diff --outp=x"],
    ["plan", "git diff --outpu x"],
    ["plan", "git log --ext"],
    ["plan", "git log --exec=x"],
    ["plan", "git diff --output-indicator-new=+"],
    ["plan", "git -c core.pager=sh log"],
    ["plan", "git log --ext-diff -p"],
    ["plan", "git log --textconv"],
    ["plan", "git log --git-dir=../x"],
    ["plan", "git log -C ../x"],
    ["plan", "git checkout -- ."],
    ["execute", './gradlew "-I" mod/src/test/resources/evil.gradle test'],
    ["execute", "./gradlew '--init-script' x test"],
    ["execute", './gradlew -"I"x test'],
    ["execute", "./gradlew \\-p ../other test"],
    ["execute", "./gradlew --init-script=x test"],
    ["execute", "./gradlew -Ix test"],
    ["execute", "./gradlew -Dgradle.user.home=/x test"],
    ["execute", "./gradlew -Dorg.gradle.java.home=/tmp/j test"],
    ["execute", "./gradlew -Pfoo=bar test"],
    ["execute", "./gradlew wrapper"],
    ["execute", "./gradlew init"],
    ["execute", "./gradlew tasks --console=plain"],
    ["execute", "./gradlew test --tests '*STest*'"],
    ["execute", "./gradlew --offline"],
    ["execute", "/abs/gradlew test"],
    ["execute", "X=1 ./gradlew test"],
    ["verify", "sh /tmp/x/run-coverage.sh --module m --tests a.B --out .fico/r"],
    ["verify", "bash evilrun-coverage.sh"],
    ["verify", "bash -xrun-coverage.sh"],
    ["verify", "bash run-coverage.sh.evil"],
    ["verify", "X=1 sh run-coverage.sh"],
    // round 3: shell expansion inside tokens, pinned script path
    ["plan", "git diff --o*"],
    ["plan", "git diff *"],
    ["plan", "git diff --outp*"],
    ["plan", "git diff ~root"],
    ["plan", "git log HEAD@{1}"],
    ["plan", "git log HEAD?"],
    ["plan", "git log [ab]"],
    ["plan", "git log !x"],
    ["plan", "git log #x"],
    ["plan", "git log (x)"],
    ["plan", "git log =ls"],
    ["execute", "./gradlew test --tests *"],
    ["execute", "./gradlew test --tests {a,b}"],
    ["execute", "gradle test --tests com.x.*Test"],
    ["verify", `sh /tmp/evil/skills/f-unit-test-code/scripts/run-coverage.sh ${ARGS}`],
    ["verify", `sh mod/src/test/resources/f-unit-test-code/scripts/run-coverage.sh ${ARGS}`],
    ["verify", `sh /tmp/*/f-unit-test-code/scripts/run-coverage.sh ${ARGS}`],
    ["verify", `sh {/tmp/a,/tmp/b}/f-unit-test-code/scripts/run-coverage.sh ${ARGS}`],
    ["verify", `sh #/f-unit-test-code/scripts/run-coverage.sh ${ARGS}`],
    ["verify", `sh f-unit-test-code/scripts/run-coverage.sh ${ARGS}`],
    ["verify", `sh skills/f-unit-test-code/scripts/run-coverage.sh ${ARGS}`],
    ["verify", `sh x/.opencode/skills/f-unit-test-code/scripts/run-coverage.sh ${ARGS}`],
  ];
  const MUST_ALLOW: [string, string][] = [
    ["plan", "git diff HEAD~1 -- src"],
    ["plan", "git log -3 --oneline"],
    ["execute", `./gradlew :${MODULE}:testClasses`],
    ["execute", "gradlew.bat test --parallel"],
    ["execute", "git status"],
    ["execute", "./gradlew :m:cleanTest :m:test --tests com.x.FooTest --offline"],
    ["execute", "gradle test --tests com.x.FooTest -q --no-daemon --console=plain"],
  ];

  test.each(MUST_REFUSE)("%s refuses %j", (stage, command) => {
    expect(bashAllowed(stage as BashStage, command, ctx())).toBe(false);
  });

  test.each(MUST_ALLOW)("%s allows %j", (stage, command) => {
    expect(bashAllowed(stage as BashStage, command, ctx())).toBe(true);
  });

  test("report allows no bash", () => {
    expect(bashAllowed("report", "git status", ctx())).toBe(false);
  });

  test("verify allows only the host-known script paths with sh or bash", () => {
    for (const script of [PROJECT_SCRIPT, `./${PROJECT_SCRIPT}`, `${CWD}/${PROJECT_SCRIPT}`, GLOBAL_SCRIPT]) {
      expect(bashAllowed("verify", `sh ${script} ${ARGS}`, ctx())).toBe(true);
      expect(bashAllowed("verify", `bash ${script} ${ARGS}`, ctx())).toBe(true);
    }
    expect(bashAllowed("verify", `zsh ${PROJECT_SCRIPT} ${ARGS}`, ctx())).toBe(false);
  });

  test("verify on Windows accepts the drive path with forward slashes", () => {
    const c = ctx([FQCN], "C:\\work\\proj", "C:\\Users\\u");
    expect(scriptPaths(c.cwd, c.home)).toContain("C:/Users/u/.config/opencode/skills/f-unit-test-code/scripts/run-coverage.sh");
    expect(bashAllowed("verify", `sh C:/work/proj/${PROJECT_SCRIPT} ${ARGS}`, c)).toBe(true);
    expect(bashAllowed("verify", `sh /c/Users/u/.config/opencode/skills/f-unit-test-code/scripts/run-coverage.sh ${ARGS}`, c)).toBe(true);
  });

  test("verify refuses the right script with extra, missing or different arguments", () => {
    const good = `sh ${PROJECT_SCRIPT} ${ARGS}`;
    const refused = [
      `${good} --project ..`,
      good.replace(OUT, ".fico/report/f-unit-test/other"),
      good.replace(`--module ${MODULE}`, "--module other-online"),
      good.replace(FQCN, `${FQCN},${FQCN}`),
      good.replace(FQCN, "a.B"),
      good.replace(` --out ${OUT}`, ""),
      good.replace("sh .opencode/skills/", "sh .opencode/skills/../skills/"),
    ];
    for (const command of refused) expect(bashAllowed("verify", command, ctx())).toBe(false);
  });

  test("verify compares --tests as a set", () => {
    const c = ctx([FQCN, FQCN2]);
    expect(bashAllowed("verify", `sh ${PROJECT_SCRIPT} --module ${MODULE} --tests ${FQCN2},${FQCN} --out ${OUT}`, c)).toBe(true);
    expect(bashAllowed("verify", `sh ${PROJECT_SCRIPT} --module ${MODULE} --tests ${FQCN} --out ${OUT}`, c)).toBe(false);
  });

  test("the guide command is the one the gate accepts, global unless the project has the skill", () => {
    expect(guideScriptPath(CWD, HOME)).toBe(GLOBAL_SCRIPT);
    const line = coverageCommandLine(ctx());
    expect(line).toBe(`sh ${GLOBAL_SCRIPT} ${ARGS}`);
    expect(bashAllowed("verify", line, ctx())).toBe(true);
  });

  test("the refusal rule names the forbidden characters", () => {
    expect(BASH_RULE).toContain("* ? [ ] { }");
  });
});
