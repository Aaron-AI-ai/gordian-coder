import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStackTrace } from "../parse";
import { classifyFrames, rankSuspects, findEntry, buildObservations, searchStackless, planLog, MAX_SUSPECTS, parseLogCommandArgs } from "../plan";
import { readRunJson, runDir } from "../run-store";
import type { LogPlan } from "../plan";

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "f-log-plan-"));
  const w = (rel: string, body: string) => {
    mkdirSync(join(cwd, rel, ".."), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  };
  const base = "src/main/java/kr/co/koscom/pb/on/stk/ord/online";
  w(`${base}/qry/controller/SONAQ001Controller.java`,
    `package kr.co.koscom.pb.on.stk.ord.online.qry.controller;\n@RestController\npublic class SONAQ001Controller {\n  @PostMapping(value = "/ON/SONAQ001")\n  public PBResponse<SONAQ001Out> sonaq001(@RequestBody PBRequest<SONAQ001In> param) { return null; }\n}\n`);
  w(`${base}/qry/service/SONAQ001Service.java`,
    `package kr.co.koscom.pb.on.stk.ord.online.qry.service;\n@Service\npublic class SONAQ001Service {\n  public Out query(In in) {\n    if (in == null) throw PBOnlineException.create("1001");\n    return null;\n  }\n  public static class Helper {}\n}\n`);
  w(`${base}/mapper/AccountOnlineMapper.java`, `package kr.co.koscom.pb.on.stk.ord.online.mapper;\npublic interface AccountOnlineMapper {}\n`);
  w(`.fico/config/fico_ai.json`, JSON.stringify({ review: { frameworkKb: { "kr.co.koscom.pb.framework.site.ext.*": ".fico/kb/site-ext/" } } }));
  w(`.fico/kb/site-ext/aspect/PBTransactionAspect.md`, "# PBTransactionAspect\nopens a transaction per *Service bean");
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
  git(["init", "-q"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return cwd;
}

const LOG = `[ERROR:t:u][h:2026-07-01 15:32:08.194][exec-1][ext.aspect.PBExceptionHandlerAspect:handleFixedLengthException:59] 고정길이 전문 CommonException: errorCode=1001
kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException
	at kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service.query(SONAQ001Service.java:5) [main/:?]
	at kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service$Helper.run(SONAQ001Service.java:8) [main/:?]
	at kr.co.koscom.pb.framework.site.ext.aspect.PBTransactionAspect.manageTransaction(PBTransactionAspect.java:71) ~[x.jar:?]
	at kr.co.koscom.pb.on.stk.ord.online.qry.controller.SONAQ001Controller.sonaq001(SONAQ001Controller.java:5) [main/:?]
	at java.base/java.util.Optional.map(Optional.java:260) ~[?:?]
`;

describe("plan", () => {
  const cwd = repo();
  const parsed = parseStackTrace(LOG);
  const kb = { "kr.co.koscom.pb.framework.site.ext.*": ".fico/kb/site-ext/" };

  test("classifyFrames: app by repo resolution, framework by KB prefix, external otherwise; inner class → outer file", () => {
    const { kinds, paths } = classifyFrames(cwd, parsed, kb);
    expect(kinds["kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service"]).toBe("app");
    expect(paths["kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service"]).toBe("src/main/java/kr/co/koscom/pb/on/stk/ord/online/qry/service/SONAQ001Service.java");
    expect(paths["kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service$Helper"]).toContain("SONAQ001Service.java");
    expect(kinds["kr.co.koscom.pb.framework.site.ext.aspect.PBTransactionAspect"]).toBe("framework");
    expect(kinds["java.util.Optional"]).toBe("external");
  });

  test("rankSuspects: root-cause block first, 1/k within, deduped, capped", () => {
    const { paths } = classifyFrames(cwd, parsed, kb);
    const s = rankSuspects(parsed, paths);
    expect(s[0].path).toContain("SONAQ001Service.java");
    expect(s[0].rank).toBe(1);
    expect(s[0].source).toBe("frame");
    expect(s[1].path).toContain("SONAQ001Controller.java");
    expect(new Set(s.map((x) => x.path)).size).toBe(s.length);
    expect(s.length).toBeLessThanOrEqual(MAX_SUSPECTS);
  });

  test("findEntry: outermost in-app frame, Controller preferred", () => {
    const { kinds } = classifyFrames(cwd, parsed, kb);
    expect(findEntry(parsed, kinds)?.cls).toContain("SONAQ001Controller");
  });

  test("buildObservations: exception line, handler code, stable strings", () => {
    const o = buildObservations(parsed);
    expect(o).toContain("예외 1/1: kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException");
    expect(o).toContain("핸들러 errorCode=1001");
    expect(buildObservations(parsed)).toEqual(o);
  });

  test("searchStackless: URI → controller/service, errorCode → throw site", () => {
    const s = searchStackless(cwd, { uri: "/ON/SONAQ001", errorCode: "1001" });
    expect(s.find((x) => x.source === "svcId" && x.path.endsWith("SONAQ001Controller.java"))).toBeTruthy();
    expect(s.find((x) => x.source === "svcId" && x.path.endsWith("SONAQ001Service.java"))).toBeTruthy();
    expect(s.find((x) => x.source === "errorCode" && x.path.endsWith("SONAQ001Service.java"))).toBeTruthy();
  });

  test("planLog: creates the run, returns orchestrator text, duplicate call reuses the run", () => {
    const out = planLog({ log: LOG }, cwd);
    const id = /runId[:=]\s*(\S+)/.exec(out)![1];
    expect(existsSync(join(runDir(id, cwd), "input.log"))).toBe(true);
    expect(existsSync(join(runDir(id, cwd), "run.json"))).toBe(true);
    const plan = readRunJson<LogPlan>(id, cwd, "plan.json")!;
    expect(plan.suspects[0].path).toContain("SONAQ001Service.java");
    expect(plan.kbDocs.map((d) => d.specifier)).toContain("kr.co.koscom.pb.framework.site.ext.aspect.PBTransactionAspect");
    expect(plan.ruleFiles).toContain("fico_exception_flow.md");
    expect(plan.ruleFiles).toContain("fico_error_code.md");
    expect(out).toContain("f-log-analyst");
    expect(planLog({ log: LOG }, cwd)).toContain(id); // idempotent within the window
  });

  test("planLog: no exception in input → refusal, no run created", () => {
    expect(planLog({ log: "just some text" }, cwd)).toContain("No exception found");
  });

  test("planLog: stack-less PB 9604 handler line is no longer refused (I-1)", () => {
    const out = planLog({ log: "[WARN :t:u][h:2026-07-01 10:00:00.000][exec-2][ext.aspect.PBGlobalExceptionAdvice:handleMessageNotReadable:175] PB 9604: URI=/ON/SONAQ001, error=bad length\n" }, cwd);
    expect(out).not.toContain("No exception found");
    expect(out).toContain("runId");
  });

  test("planLog: stack-less PB warn line still plans via URI/errorCode", () => {
    const out = planLog({ log: "[WARN :t:u][h:2026-07-01 10:00:00.000][exec-2][ext.aspect.PBGlobalExceptionAdvice:handleCommonException:201] PB CommonException: URI=/ON/SONAQ001, code=1001, msg=null\n" }, cwd);
    const id = /runId[:=]\s*(\S+)/.exec(out)![1];
    const plan = readRunJson<LogPlan>(id, cwd, "plan.json")!;
    expect(plan.suspects.some((s) => s.source !== "frame")).toBe(true);
    expect(plan.entry).toBeNull();
  });
});

describe("parseLogCommandArgs", () => {
  const TRACE = "[ERROR::][host:2026-09-23 14:35:55.692][w][a.B:c:1] 실패\njava.lang.NullPointerException: x\n\tat a.B.c(B.java:4)";
  test("a bare trace becomes log, verbatim (tabs and newlines kept)", () => {
    expect(parseLogCommandArgs(TRACE)).toEqual({ log: TRACE });
  });
  test("flags are pulled out wherever they sit; the rest stays verbatim", () => {
    expect(parseLogCommandArgs(`--output=out/r.md --no-judge\n${TRACE}\n--judge`)).toEqual({ log: TRACE, output: "out/r.md", judge: true });
    expect(parseLogCommandArgs(`--judge ${TRACE}`)).toEqual({ log: TRACE, judge: true });
  });
  test("--file alone leaves no log", () => {
    expect(parseLogCommandArgs("--file=logs/a.log --no-judge")).toEqual({ file: "logs/a.log", judge: false });
  });
  test("opencode run quotes an argv with spaces — unwrap it (flog-eval passes flags as one argv)", () => {
    expect(parseLogCommandArgs('"--file=logs/a.log --output=out/r.md"')).toEqual({ file: "logs/a.log", output: "out/r.md" });
    const quoted = `"${TRACE.replace(/"/g, '\\"')} because \\"row\\" is null"`;
    expect(parseLogCommandArgs(`--no-judge ${quoted}`)).toEqual({ log: `${TRACE} because "row" is null`, judge: false });
  });
  test("quotes inside an unquoted (TUI) trace are kept", () => {
    const t = `${TRACE} because "row" is null`;
    expect(parseLogCommandArgs(t).log).toBe(t);
  });
  test("flag-looking text glued to other text is left alone", () => {
    expect(parseLogCommandArgs("msg=--judge x").log).toBe("msg=--judge x");
  });
});
