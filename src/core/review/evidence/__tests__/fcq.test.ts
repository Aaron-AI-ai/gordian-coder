import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fcqCommand,
  fcqFindings,
  fcqShardPath,
  mapFcqCategory,
  mergeFcqFindings,
  readFcqFile,
  readFcqSummary,
  FCQ_EVIDENCE_MAX_CHARS,
  renderFcqEvidence,
  renderFcqSection,
  runFcq,
  violationsForTarget,
  type FcqFileViolation,
} from "../fcq";
import { finalizeRun, planReview } from "../../pipeline/run";
import { writeFileReview } from "../../pipeline/run-store";
import { loadRun } from "../../pipeline/artifact";
import { readFileReviewResult } from "../../pipeline/artifact";
import { startReview } from "../../pipeline/start";
import { guardExploration, submitReview } from "../../pipeline/loop";
import { reviewPromptFor } from "../../pipeline/prompt";
import { judgeContext, submitJudge } from "../../pipeline/judge";
import { clearState, getState } from "../../pipeline/state";
import { REQUIRED_CATEGORIES } from "../../contract";

const tmps: string[] = [];
afterEach(() => {
  clearState("fq");
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "f-fcq-"));
  tmps.push(d);
  return d;
}

function gitRepo(): string {
  const d = dir();
  const sh = (c: string[]) => Bun.spawnSync(c, { cwd: d });
  sh(["git", "init", "-q"]);
  sh(["git", "config", "user.email", "t@t"]);
  sh(["git", "config", "user.name", "t"]);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src/A.java"), "class A {}\n");
  writeFileSync(join(d, "src/B.java"), "class B {}\n");
  sh(["git", "add", "-A"]);
  sh(["git", "commit", "-qm", "init"]);
  writeFileSync(join(d, "src/A.java"), "class A { int x; }\n");
  writeFileSync(join(d, "src/B.java"), "class B { int y; }\n");
  sh(["git", "add", "-A"]);
  sh(["git", "commit", "-qm", "change"]);
  return d;
}

const REPORT = {
  summary: { totalRules: 3, passed: 1, failed: 2, notRun: 0, totalViolations: 3, maxSeverity: "CRITICAL", passRate: 33.3 },
  metadata: {
    ranAt: new Date().toISOString(),
    analyzers: [{ name: "pmd", status: "SUCCESS", durationMillis: 400 }],
    build: { status: "SUCCESS", durationMillis: 1000 },
  },
  categories: [{ category: "sql", ruleCount: 1, passed: 0, failed: 1, notRun: 0, violationCount: 1, maxSeverity: "CRITICAL" }],
  rules: [
    {
      analyzer: "mybatis-sql", ruleId: "FCQ-SQL-INJ-001", description: "${} 사용", category: "sql",
      severity: "CRITICAL", status: "FAIL",
      violations: [{ file: "src/A.java", line: 1, severity: "CRITICAL", message: "inj", code: { startLine: 1, lines: ["class A"] } }],
    },
    {
      analyzer: "pmd", ruleId: "UnusedPrivateMethod", description: "unused", category: "code-cleanup",
      severity: "MINOR", status: "FAIL",
      violations: [
        { file: "src/A.java", line: 700, severity: "MINOR", message: "m1" },
        { file: "src/Other.java", line: 3, severity: "MINOR", message: "outside" },
      ],
    },
    { analyzer: "pmd", ruleId: "Clean", description: "", category: "bugs", severity: "MAJOR", status: "PASS", violations: [] },
  ],
};

/** Install a fake `fcq` that honours --report-output, like the real CLI. No
 * fcq.yaml is written: the point of --report-output is that the target needs
 * no `report:` section of its own. */
function fakeFcq(d: string, opts: { exit?: number; noReport?: boolean } = {}): void {
  const bin = join(d, "fcq-bin");
  const script = [
    "#!/bin/sh",
    `echo "$@" > ${JSON.stringify(join(d, "fcq-args"))}`,
    // Parse --report-output=DIR out of the args the way the real CLI would.
    'out=""',
    'for a in "$@"; do case "$a" in --report-output=*) out="${a#--report-output=}";; esac; done',
    ...(opts.noReport
      ? []
      : [`mkdir -p "$out" && cat > "$out/report.json" <<'EOF'\n${JSON.stringify(REPORT)}\nEOF`]),
    `exit ${opts.exit ?? 1}`,
  ].join("\n");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  writeFileSync(join(d, ".f-review.json"), JSON.stringify({ fcq: true, fcqOptions: { bin, module: "m", timeout: 30 } }));
}

describe("fcqCommand", () => {
  it("maps options to fcq CLI flags and scopes to the targets", () => {
    const cmd = fcqCommand("/p", ["a.java", "b.java"], { analyzers: ["pmd"], module: "m", maxSeverity: "MAJOR", noBuild: true, buildTimeout: 42 }, "/r/fcq/raw");
    expect(cmd).toEqual(["fcq", "analyze", "/p", "--paths=a.java,b.java", "--report-output=/r/fcq/raw", "--report-formats=json", "--analyzers=pmd", "--module=m", "--max-severity=MAJOR", "--no-build", "--build-timeout=42"]);
  });

  it("always directs the report into the run dir and skips the html/md views", () => {
    // Without these the report would land wherever the TARGET's fcq.yaml says
    // — shared between runs, and absent entirely when it has no report section.
    const cmd = fcqCommand("/p", ["a.java"], {}, "/r/fcq/raw");
    expect(cmd).toContain("--report-output=/r/fcq/raw");
    expect(cmd).toContain("--report-formats=json");
  });
});

describe("runFcq", () => {
  it("runs the CLI, shards violations per target, counts outside hits", async () => {
    const d = dir();
    fakeFcq(d);
    const root = join(d, "run");
    const status = await runFcq(d, ["src/A.java", "src/B.java"], root);
    expect(status.status).toBe("ok");
    expect(readFileSync(join(d, "fcq-args"), "utf8")).toContain("--paths=src/A.java,src/B.java");
    expect(readFileSync(join(d, "fcq-args"), "utf8")).toContain("--module=m");
    const a = readFcqFile(root, "src/A.java");
    expect(a.map((v) => v.ruleId)).toEqual(["FCQ-SQL-INJ-001", "UnusedPrivateMethod"]);
    expect(a[0].snippet).toEqual(["class A"]);
    expect(readFcqFile(root, "src/B.java")).toEqual([]);
    expect(existsSync(fcqShardPath(root, "src/Other.java"))).toBe(false);
    const s = readFcqSummary(root)!;
    expect(s.targetViolations).toBe(2);
    expect(s.outsideTargetViolations).toBe(1);
    expect(s.files).toEqual(["src/A.java"]);
  });

  it("needs no fcq.yaml in the target", async () => {
    // The target here has no `report:` section — no fcq.yaml at all — which
    // used to be a hard failure because the report path came from that file.
    const d = dir();
    fakeFcq(d);
    expect(existsSync(join(d, "fcq/config/fcq.yaml"))).toBe(false);
    const status = await runFcq(d, ["src/A.java"], join(d, "run"));
    expect(status.status).toBe("ok");
    expect(status.reportPath).toBe(join(d, "run/fcq/raw/report.json"));
  });

  it("fails (never throws) on usage error, missing report, or a missing binary", async () => {
    const d = dir();
    fakeFcq(d, { exit: 2 });
    expect((await runFcq(d, ["src/A.java"], join(d, "r1"))).reason).toContain("exit 2");
    fakeFcq(d, { noReport: true, exit: 0 });
    expect((await runFcq(d, ["src/A.java"], join(d, "r2"))).reason).toContain("wrote no");
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ fcqOptions: { bin: "/nonexistent/fcq" } }));
    expect((await runFcq(d, ["src/A.java"], join(d, "r4"))).status).toBe("failed");
  });
});

describe("evidence / findings rendering", () => {
  const rows: FcqFileViolation[] = [
    { analyzer: "pmd", ruleId: "R1", description: "d1", category: "code-style", severity: "MINOR", line: 10, message: "m1" },
    { analyzer: "sql", ruleId: "R2", description: "d2", category: "sql", severity: "CRITICAL", line: 600, message: "m2", snippet: ["x"] },
    { analyzer: "arch", ruleId: "R3", description: "d3", category: "architecture", severity: "MAJOR", message: "m3" },
  ];

  it("orders by severity and instructs not to re-report", () => {
    const text = renderFcqEvidence(rows);
    expect(text.indexOf("R2")).toBeLessThan(text.indexOf("R3"));
    expect(text.indexOf("R3")).toBeLessThan(text.indexOf("R1"));
    expect(text).toContain("do NOT re-report");
    expect(text).toContain("CRITICAL/MAJOR");
    expect(renderFcqEvidence([])).toBe("");
  });

  it("fixAll hands the fixes to the fix pass and points the reviewer elsewhere", () => {
    // Telling one agent to write fixes for every hit AND find what fcq cannot
    // see produced reviews of nothing but restated style rules. With fixAll the
    // fixes belong to f-fixer, and the reviewer is aimed at the rest.
    const ev = renderFcqEvidence(rows, true);
    expect(ev).toContain("separate fix pass");
    expect(ev).toContain("including MINOR");
    expect(ev).toContain("Do not write fixes for these");
    expect(ev).not.toContain("EVERY hit above");
  });

  it("keeps the instructions when the violation list overflows the cap", () => {
    // Enough rows to blow FCQ_EVIDENCE_MAX_CHARS: the list is trimmed, the
    // instructions (what makes the pass work at all) must still be there.
    const many: FcqFileViolation[] = Array.from({ length: 40 }, (_, i) => ({
      ...rows[0]!,
      ruleId: `R${i}`,
      description: "d".repeat(400),
      line: i + 1,
    }));
    const big = renderFcqEvidence(many, true);
    expect(big.length).toBeLessThanOrEqual(FCQ_EVIDENCE_MAX_CHARS);
    expect(big).toContain("separate fix pass");
    expect(big).toMatch(/… \d+ more violation/);

    // Without fixAll the reviewer still owns the CRITICAL/MAJOR follow-ups.
    const plain = renderFcqEvidence(many, false);
    expect(plain).toContain("SAME `line`");
    expect(plain).toContain("CRITICAL/MAJOR");
  });

  it("segment targets keep only in-window rows plus unanchored ones", () => {
    expect(violationsForTarget(rows, "f.java#500-1000").map((v) => v.ruleId)).toEqual(["R2", "R3"]);
    expect(violationsForTarget(rows, "f.java")).toHaveLength(3);
  });

  it("maps to findings with fcq: rule tags and category/severity mapping", () => {
    const f = fcqFindings("f.java", rows);
    expect(f[1]).toMatchObject({ category: "security", severity: "blocker", rule: "fcq:sql/R2", line: 600, message: "m2" });
    // Separate fields, separate budgets: the snippet can no longer crowd out
    // the fix the way it did when both shared one 4000-char `suggestion`.
    expect(f[1].asIs).toBe("x");
    expect(f[1].toBe).toBe("d2");
    expect(f[0].asIs).toBeUndefined(); // no snippet
    expect(f[0].toBe).toBe("d1"); // rule description stands in as the fix
    expect(f[2]).toMatchObject({ category: "framework", severity: "major" });
    expect(f[2].line).toBeUndefined();
    expect(mapFcqCategory("bugs")).toBe("correctness");
    expect(mapFcqCategory("framework-common")).toBe("framework");
    expect(mapFcqCategory("comments")).toBe("maintainability");
  });

  it("merges an LLM finding on the same line into the fcq row", () => {
    const fcq = fcqFindings("f.java", rows);
    const llm = [
      { category: "security" as const, severity: "major" as const, file: "f.java", line: 600, rule: "inj (fcq R2)", message: "user input reaches ${}", asIs: "${a}", toBe: "#{a}" },
      { category: "correctness" as const, severity: "blocker" as const, file: "f.java", line: 10, rule: "npe", message: "null deref — see r1" },
      { category: "tests" as const, severity: "minor" as const, file: "f.java", line: 999, rule: "t", message: "no test" },
      { category: "correctness" as const, severity: "major" as const, file: "f.java", line: 10, rule: "logic", message: "unrelated bug on the same line" },
    ];
    const out = mergeFcqFindings(llm, fcq);
    expect(out).toHaveLength(5); // 4 llm + 3 fcq − 2 merged
    expect(out[0]).toMatchObject({ rule: "t", line: 999 }); // unmerged LLM row passes through first
    expect(out[1]).toMatchObject({ rule: "logic", line: 10 }); // same line but no rule id → NOT merged
    const r2 = out.find((f) => f.rule === "fcq:sql/R2")!;
    expect(r2.severity).toBe("blocker"); // fcq CRITICAL→blocker outranks LLM major
    expect(r2.message).toBe("m2\n리뷰어: user input reaches ${}");
    expect(r2.toBe).toBe("#{a}"); // reviewer's real fix replaces the rule-description placeholder
    expect(r2.asIs).toBe("${a}");
    const r1 = out.find((f) => f.rule === "fcq:pmd/R1")!;
    expect(r1.severity).toBe("blocker"); // LLM blocker outranks fcq MINOR
    expect(r1.toBe).toBe("d1"); // LLM wrote no fix → fcq's placeholder stays
    expect(out.find((f) => f.rule === "fcq:arch/R3")!.message).toBe("m3"); // unanchored: untouched
  });

  it("renders a failed section and an ok section", () => {
    expect(renderFcqSection({ status: "failed", command: "fcq x", durationMs: 5, reason: "boom" }, null)).toContain("FAILED** — boom");
    expect(renderFcqSection(undefined, null)).toBe("");
  });
});

describe("run-mode integration", () => {
  it("plan runs fcq, reviewer + judge see the evidence, finalize merges findings", async () => {
    const d = gitRepo();
    fakeFcq(d);
    const plan = await planReview({ commit: "HEAD" }, d);
    expect(plan).toContain("Static analysis (fcq): done");
    const runId = /Run created: (\S+)/.exec(plan)![1];
    const meta = loadRun(runId, d)!;
    expect(meta.fcq?.status).toBe("ok");

    // reviewer joins A → prompt carries the fcq section
    const msg = await startReview({ runId, files: ["src/A.java"] }, d, "fq");
    expect(msg).toContain("reviewing src/A.java");
    const prompt = reviewPromptFor(getState("fq")!)!;
    expect(prompt).toContain("Static analysis (fcq, already run for you)");
    expect(prompt).toContain("FCQ-SQL-INJ-001");
    clearState("fq");

    // artifacts for both files (B clean from the LLM side)
    for (const file of ["src/A.java", "src/B.java"]) {
      await writeFileReview(runId, { file, assessed: [...REQUIRED_CATEGORIES], findings: [], explorationCalls: 1, partial: false }, "# r", d);
    }
    expect(judgeContext(runId, "src/A.java", d)).toContain("Static analysis already applied");

    const out = await finalizeRun(runId, d);
    expect(out).toContain("✅ Run complete");
    expect(out).toContain("2 issue(s) (incl. 2 from fcq)");
    const report = readFileSync(join(d, /Report: (\S+)/.exec(out)![1]), "utf8");
    expect(report).toContain("fcq:mybatis-sql/FCQ-SQL-INJ-001");
    expect(report).toContain("## Static Analysis (fcq)");
    expect(report).toContain("Violations in reviewed files: 2 (+1 outside");
  });

  it("bounces a submission that only restates the fcq list", async () => {
    // The failure this guards: handed 28 violations, a reviewer submitted six
    // restated checkstyle rows and nothing else. Those rows are already in the
    // report, so such a review added nothing.
    const d = gitRepo();
    fakeFcq(d);
    const plan = await planReview({ commit: "HEAD" }, d);
    const runId = /Run created: (\S+)/.exec(plan)![1];
    await startReview({ runId, files: ["src/A.java"] }, d, "echo");
    const st = getState("echo")!;
    guardExploration(st, "file_read", "x"); // clear the "no exploration" note
    const token = /CURRENT_SUBMIT_TOKEN[:\s]*([A-Za-z0-9_-]+)/.exec(reviewPromptFor(st)!)?.[1];
    const echo = await submitReview(
      {
        submitToken: token,
        assessed: [...REQUIRED_CATEGORIES],
        findings: [
          {
            category: "security" as const,
            severity: "major" as const,
            file: "src/A.java",
            line: 10,
            rule: "FCQ-SQL-INJ-001",
            message: "restating the fcq hit",
            toBe: "use #{}",
          },
        ],
      },
      "echo"
    );
    expect(echo).toContain("Every finding restates an fcq rule");
    expect(echo).toContain("related_code");
    clearState("echo");
  });

  it("accepts a submission that adds a finding of its own", async () => {
    const d = gitRepo();
    fakeFcq(d);
    const plan = await planReview({ commit: "HEAD" }, d);
    const runId = /Run created: (\S+)/.exec(plan)![1];
    await startReview({ runId, files: ["src/A.java"] }, d, "own");
    const st = getState("own")!;
    guardExploration(st, "file_read", "x");
    const token = /CURRENT_SUBMIT_TOKEN[:\s]*([A-Za-z0-9_-]+)/.exec(reviewPromptFor(st)!)?.[1];
    const ok = await submitReview(
      {
        submitToken: token,
        assessed: [...REQUIRED_CATEGORIES],
        findings: [
          {
            category: "correctness" as const,
            severity: "major" as const,
            file: "src/A.java",
            line: 42,
            rule: "null-handling",
            message: "empty result dereferenced",
            toBe: "if (r.isEmpty()) return null;",
          },
        ],
      },
      "own"
    );
    expect(ok).not.toContain("Every finding restates");
    clearState("own");
  });

  it("merging fcq findings does not unmatch recorded judgments (judge gate)", async () => {
    const d = gitRepo();
    fakeFcq(d);
    const plan = await planReview({ commit: "HEAD", judge: true }, d);
    const runId = /Run created: (\S+)/.exec(plan)![1];
    for (const file of ["src/A.java", "src/B.java"]) {
      await writeFileReview(runId, { file, assessed: [...REQUIRED_CATEGORIES], findings: [], explorationCalls: 1, partial: false }, "# r", d);
      const verdict = await submitJudge(
        { runId, file, findingJudgments: [], coverageGaps: [], score: 95, feedback: "" },
        d
      );
      expect(verdict).toContain("Judge PASS");
    }
    const out = await finalizeRun(runId, d);
    expect(out).not.toContain("unjudged");
    expect(out).toContain("✅ Run complete");
    // finalize must not have rewritten the review artifacts either
    expect(readFileReviewResult(runId, "src/A.java", d)!.findings).toHaveLength(0);
  });

  it("fcq failure keeps the review going but fails closed on failOn", async () => {
    const d = gitRepo();
    fakeFcq(d, { exit: 2 });
    const plan = await planReview({ commit: "HEAD", failOn: "major" }, d);
    expect(plan).toContain("Static analysis (fcq) FAILED");
    const runId = /Run created: (\S+)/.exec(plan)![1];
    const msg = await startReview({ runId, files: ["src/A.java"] }, d, "fq");
    expect(msg).toContain("reviewing src/A.java");
    expect(reviewPromptFor(getState("fq")!)!).not.toContain("Static analysis (fcq");
    for (const file of ["src/A.java", "src/B.java"]) {
      await writeFileReview(runId, { file, assessed: [...REQUIRED_CATEGORIES], findings: [], explorationCalls: 1, partial: false }, "# r", d);
    }
    const out = await finalizeRun(runId, d);
    expect(out).toContain("INCOMPLETE");
    expect(out).toContain("static analysis (fcq) did not complete");
    expect(out).toContain("Verdict: FAIL — review quality INCOMPLETE");
    expect(readFileSync(join(d, /Report: (\S+)/.exec(out)![1]), "utf8")).toContain("**FAILED** — exit 2");
  });

  it("without fcq enabled nothing changes", async () => {
    const d = gitRepo();
    const plan = await planReview({ commit: "HEAD" }, d);
    expect(plan).not.toContain("fcq");
    expect(loadRun(/Run created: (\S+)/.exec(plan)![1], d)!.fcq).toBeUndefined();
  });
});
