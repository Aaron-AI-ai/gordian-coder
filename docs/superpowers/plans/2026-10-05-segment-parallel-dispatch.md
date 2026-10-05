# Segment Parallel Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a parallel f-review run dispatch each segment of a large whole-file target to its own f-reviewer subagent, and have finalize merge the per-segment artifacts back into one per-file report section without collisions.

**Architecture:** The dispatch unit moves from "file" to "unit" (a file path, or a segment id `path#start-end`). `f_review_plan` computes the unit list once and stores it in `run.json` (`units`), plus a configurable `batchSize`. Reviewers join by unit id; each writes its own artifact keyed by unit (`target` field) while `file` stays the real path. Finalize groups artifacts by `file`, concatenates in segment order, runs the existing `dedupeFindings`, then merges fcq as before. The judge is keyed by unit and shows only the segment's window.

**Tech Stack:** Bun, TypeScript (strict), Zod, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-01-segment-parallel-dispatch-design.md`

## Global Constraints

- TypeScript strict mode; Zod validation for every external document (`run.json`, review artifacts, config).
- `FileReviewResult.file` is ALWAYS the real path; `finding.file === result.file` invariant is unchanged.
- A legacy `run.json` without `units` behaves exactly as today (one subagent per file, in-session segmentation).
- A file-unit artifact (`target === file`) keeps the filename `reviewSlug(file)`.
- `dedupeFindings` runs BEFORE `mergeFcqFindings` in finalize.
- fcq, f-fixer, and `--sequential` paths are not modified.
- `batchSize` clamps to `[1, 20]`, default `5`.
- Commit messages: no `Co-Authored-By` lines (user preference).
- Every task: write the failing test first, run it, implement, run `bun test <file>`, then commit. Run `bun run typecheck` before each commit.
- All commands run from the worktree root `/Users/koscom/workspace/gordian-coder/.claude/worktrees/segment-parallel-dispatch`.

**Spec deviation (recorded here, applied to the spec in Task 3):** unit sorting by line count applies only to whole-file runs. In diff mode the cost is proportional to the diff, not the file, so sorting by file size would mislead; diff-mode runs keep today's target order.

## Review Focus

1. **A reviewer joins with the bare path of a split file** (`files=["a.java"]` when `units` has `a.java#…`): expected a guidance message listing the exact unit ids and no session state. → Task 4 test "bare path of a split file returns the unit list".
2. **Finding anchored outside its segment window** (via `inFileRelated` declarations): expected the judge still sees a source window for that line instead of judging against absence. → Task 6 test "a finding outside the segment window gets an evidence window".
3. **Two segments report the same fcq-backed issue in the overlap band**: expected one merged row paired with one fcq row, not two. → Task 5 test "overlap duplicate collapses before the fcq merge pairs it".
4. **Legacy `run.json` (no `units`) with a 1200-line whole-file target**: expected in-session segmentation exactly as before. → Task 4 keeps the renamed legacy test.
5. **A judgment file written for a unit id and a review artifact for the same unit**: expected `readRunJudgments` and `readRunResults` both accept them (filename check by unit). → Task 2 test "two units of one file write distinct artifacts" and Task 6 test "judge verdicts for two units of one file are isolated".

---

### Task 1: `batchSize` config + `RUN_BATCH_SIZE` from config

**Files:**
- Modify: `src/core/review/config.ts` (schema field + `resolveBatchSize`)
- Modify: `src/core/review/pipeline/run-store.ts:30-31` (`RUN_BATCH_SIZE` re-export)
- Test: `src/core/review/__tests__/config.test.ts`

**Interfaces:**
- Produces: `DEFAULT_BATCH_SIZE = 5`, `MAX_BATCH_SIZE = 20`, `resolveBatchSize(cwd: string): number` in `config.ts`; `RUN_BATCH_SIZE` in `run-store.ts` keeps its name and value (5).

- [ ] **Step 1: Write the failing test**

Append to `src/core/review/__tests__/config.test.ts` (and extend the import on line 16 to include `DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, resolveBatchSize`):

```ts
describe("resolveBatchSize", () => {
  it("defaults to DEFAULT_BATCH_SIZE without config", () => {
    expect(resolveBatchSize(tmp())).toBe(DEFAULT_BATCH_SIZE);
    expect(DEFAULT_BATCH_SIZE).toBe(5);
  });

  it("reads batchSize from .f-review.json, clamped to [1, MAX_BATCH_SIZE] and truncated", () => {
    const d = tmp();
    writeFileSync(join(d, ".f-review.json"), '{"batchSize": 8}');
    expect(resolveBatchSize(d)).toBe(8);
    writeFileSync(join(d, ".f-review.json"), '{"batchSize": 0}');
    expect(resolveBatchSize(d)).toBe(1);
    writeFileSync(join(d, ".f-review.json"), '{"batchSize": 99}');
    expect(resolveBatchSize(d)).toBe(MAX_BATCH_SIZE);
    writeFileSync(join(d, ".f-review.json"), '{"batchSize": 7.9}');
    expect(resolveBatchSize(d)).toBe(7);
    writeFileSync(join(d, ".f-review.json"), '{"batchSize": "many"}');
    expect(resolveBatchSize(d)).toBe(DEFAULT_BATCH_SIZE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/review/__tests__/config.test.ts`
Expected: FAIL — `resolveBatchSize` is not exported.

- [ ] **Step 3: Implement**

In `src/core/review/config.ts`, add to `ReviewConfigSchema` after `maxToolCalls`:

```ts
  batchSize: field(z.number()), // run mode: subagents in flight at once (clamped 1..MAX_BATCH_SIZE, default DEFAULT_BATCH_SIZE)
```

Append at the end of the file:

```ts
/** Spawn-batch guidance for the orchestrator: subagents in flight at once.
 * A larger batch shortens a run only when the provider's rate limit allows
 * it; the cap keeps a typo from fanning out a hundred sessions. */
export const DEFAULT_BATCH_SIZE = 5;
export const MAX_BATCH_SIZE = 20;

export function resolveBatchSize(cwd: string): number {
  const v = loadConfig(cwd).batchSize;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(v)));
}
```

In `src/core/review/pipeline/run-store.ts`, replace lines 30-31:

```ts
/** Spawn-batch guidance for the orchestrator: at most this many subagents at once. */
export const RUN_BATCH_SIZE = 5;
```

with:

```ts
/** Default spawn-batch size; a run pins its effective value in `RunMeta.batchSize`. */
export const RUN_BATCH_SIZE = DEFAULT_BATCH_SIZE;
```

and add `DEFAULT_BATCH_SIZE` to the import from `"../config"` — run-store.ts currently has no config import, so add:

```ts
import { DEFAULT_BATCH_SIZE } from "../config";
```

(`config.ts` imports only `./tools/read`; `run-store.ts` → `../evidence/rubric` → `../config` already exists, so the new edge `run-store → config` creates no cycle.)

- [ ] **Step 4: Run tests**

Run: `bun test src/core/review/__tests__/config.test.ts src/core/review/pipeline/__tests__/run.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/review/config.ts src/core/review/pipeline/run-store.ts src/core/review/__tests__/config.test.ts
git commit -m "Add batchSize config for the parallel-run spawn batch"
```

---

### Task 2: Unit-keyed artifacts (`RunMeta.units/batchSize`, `FileReviewResult.target`)

**Files:**
- Modify: `src/core/review/pipeline/artifact.ts` (schema fields, `runUnits`, `resultUnit`, `readFileReviewResult`)
- Modify: `src/core/review/pipeline/run-store.ts` (`writeFileReview`, `readRunResults`, `runCoverage`, `finalizeFingerprint`)
- Test: `src/core/review/pipeline/__tests__/run.test.ts` (in `describe("run store primitives")`)

**Interfaces:**
- Produces:
  - `RunMeta.units?: string[]`, `RunMeta.batchSize?: number`
  - `runUnits(meta: RunMeta): string[]` — `meta.units ?? meta.targets`
  - `FileReviewResult.target?: string` (input and persisted; NOT defaulted by the transform, so legacy artifact hashes are unchanged)
  - `resultUnit(r: { file: string; target?: string }): string` — `r.target ?? r.file`
  - `readFileReviewResult(runId, unit, cwd)` looks up by `reviewSlug(unit)` and checks `resultUnit(parsed) === unit`
  - `runCoverage(meta, results)` compares `runUnits(meta)` against `resultUnit(r)`

- [ ] **Step 1: Write the failing tests**

Add to `describe("run store primitives")` in `run.test.ts` (imports: add `runUnits, resultUnit` from `"../artifact"` and `readFileReviewResult` from `"../artifact"`):

```ts
  it("runUnits falls back to targets for a legacy run.json without units", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["a.ts", "b.ts"]), d);
    expect(runUnits(meta)).toEqual(["a.ts", "b.ts"]);
    const split = await createRun({ ...baseMeta(["a.ts"]), units: ["a.ts#1-500", "a.ts#441-900"], batchSize: 7 }, d);
    expect(loadRun(split.runId, d)?.units).toEqual(["a.ts#1-500", "a.ts#441-900"]);
    expect(loadRun(split.runId, d)?.batchSize).toBe(7);
    expect(runUnits(loadRun(split.runId, d)!)).toEqual(["a.ts#1-500", "a.ts#441-900"]);
  });

  it("two units of one file write distinct artifacts that never overwrite each other", async () => {
    const d = dir();
    const meta = await createRun(
      { ...baseMeta(["big.ts"]), whole: true, units: ["big.ts#1-500", "big.ts#441-900"] },
      d
    );
    await writeFileReview(meta.runId, result("big.ts", { target: "big.ts#1-500" }), "# s1", d);
    await writeFileReview(
      meta.runId,
      result("big.ts", { target: "big.ts#441-900", findings: [] }),
      "# s2",
      d
    );
    const results = readRunResults(meta.runId, d);
    expect(results.map(resultUnit).sort()).toEqual(["big.ts#1-500", "big.ts#441-900"]);
    expect(results.every((r) => r.file === "big.ts")).toBe(true);
    expect(readFileReviewResult(meta.runId, "big.ts#1-500", d)?.findings).toHaveLength(1);
    expect(readFileReviewResult(meta.runId, "big.ts#441-900", d)?.findings).toHaveLength(0);
    // The bare file is not a unit of this run: nothing is filed under it.
    expect(readFileReviewResult(meta.runId, "big.ts", d)).toBeNull();
    expect(runCoverage(meta, results)).toEqual({
      reviewed: ["big.ts#1-500", "big.ts#441-900"],
      missing: [],
    });
  });

  it("a file-unit artifact keeps the legacy filename and a legacy artifact reads back as its own unit", async () => {
    const d = dir();
    const meta = await createRun(baseMeta(["a.ts"]), d);
    await writeFileReview(meta.runId, result("a.ts"), "# a", d);
    const p = join(runDir(meta.runId, d), "reviews", `${reviewSlug("a.ts")}.json`);
    expect(existsSync(p)).toBe(true);
    // Simulate an artifact written before `target` existed.
    const legacy = JSON.parse(readFileSync(p, "utf8"));
    delete legacy.target;
    writeFileSync(p, JSON.stringify(legacy));
    const back = readFileReviewResult(meta.runId, "a.ts", d);
    expect(back?.target).toBeUndefined();
    expect(resultUnit(back!)).toBe("a.ts");
    expect(runCoverage(meta, readRunResults(meta.runId, d)).missing).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/review/pipeline/__tests__/run.test.ts -t "runUnits|two units|legacy filename"`
Expected: FAIL (`runUnits`/`resultUnit` not exported; second artifact overwrites the first).

- [ ] **Step 3: Implement artifact.ts**

In `FileReviewResultObjectSchema` add after `file`:

```ts
    // Dispatch unit this artifact answers for: the file itself, or one segment
    // `path#start-end` of it. Absent on artifacts written before segments were
    // dispatched separately — read those as the file unit. Not defaulted by the
    // transform on purpose: `reviewArtifactHash` covers the parsed object, and
    // injecting a field would unmatch every judgment recorded for a legacy artifact.
    target: z.string().min(1).max(600).optional(),
```

Add helpers after `reviewArtifactHash`:

```ts
/** The unit an artifact answers for — its segment id, or the file itself. */
export function resultUnit(result: { file: string; target?: string }): string {
  return result.target ?? result.file;
}

/** The dispatch units of a run. A run planned before units existed lists
 * none: every target is then its own unit, exactly as before. */
export function runUnits(meta: Pick<RunMeta, "targets" | "units">): string[] {
  return meta.units ?? meta.targets;
}
```

Replace `readFileReviewResult`:

```ts
/** Load one exact review artifact by unit, rejecting corrupt and wrong-unit state. */
export function readFileReviewResult(
  runId: string,
  unit: string,
  cwd: string
): PersistedFileReviewResult | null {
  const p = join(runDir(runId, cwd), "reviews", `${reviewSlug(unit)}.json`);
  if (!existsSync(p)) return null;
  try {
    const parsed = FileReviewResultSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success && resultUnit(parsed.data) === unit ? parsed.data : null;
  } catch {
    return null;
  }
}
```

In `RunMeta` add after `targets`:

```ts
  /** Dispatch units: every target, with a whole-file target over
   * SEGMENT_THRESHOLD lines expanded to its segment ids. Computed once at
   * plan time so every reviewer, judge, and finalize sees the same list.
   * Absent on runs planned before segments were dispatched separately. */
  units?: string[];
  /** Subagents in flight at once, pinned from config at plan time. */
  batchSize?: number;
```

In `RunMetaSchema` add:

```ts
  units: z.array(z.string()).optional(),
  batchSize: z.number().int().min(1).optional(),
```

- [ ] **Step 4: Implement run-store.ts**

Import `resultUnit, runUnits` from `./artifact` (extend the existing import line 25).

`writeFileReview`: replace the first statement and the judgment filter:

```ts
  const unit = resultUnit(result);
  const previous = readFileReviewResult(runId, unit, cwd);
  // A corrupt/deleted review artifact must not reset to revision 1 and match a
  // stale verdict. Valid judgment records retain the greatest revision that
  // has ever escaped this process, so advance beyond both sources.
  const judgedRevision = readRunJudgments(runId, cwd)
    .filter((judgment) => judgment.file === unit)
```

and the path line:

```ts
  const base = join(runDir(runId, cwd), "reviews", reviewSlug(resultUnit(normalized)));
```

`readRunResults`: the filename check becomes

```ts
      if (parsed.success && f === `${reviewSlug(resultUnit(parsed.data))}.json`) out.push(parsed.data);
```

`runCoverage`:

```ts
/** Expected-vs-written coverage for a run, in dispatch units. */
export function runCoverage(
  meta: RunMeta,
  results: FileReviewResult[]
): { reviewed: string[]; missing: string[] } {
  const written = new Set(results.map(resultUnit));
  const units = runUnits(meta);
  return {
    reviewed: units.filter((u) => written.has(u)),
    missing: units.filter((u) => !written.has(u)),
  };
}
```

`finalizeFingerprint` results entry:

```ts
      results: results
        .map((result) => ({ unit: resultUnit(result), hash: reviewArtifactHash(result) }))
        .sort((a, b) => a.unit.localeCompare(b.unit)),
```

- [ ] **Step 5: Run tests**

Run: `bun test src/core/review/pipeline/__tests__/run.test.ts src/core/review/pipeline/__tests__/judge.test.ts && bun run typecheck`
Expected: PASS (existing tests still create runs without `units`, so nothing else moves).

- [ ] **Step 6: Commit**

```bash
git add src/core/review/pipeline/artifact.ts src/core/review/pipeline/run-store.ts src/core/review/pipeline/__tests__/run.test.ts
git commit -m "Key run artifacts by dispatch unit; add RunMeta.units and batchSize"
```

---

### Task 3: Plan computes units, pins batchSize, lists units

**Files:**
- Modify: `src/core/review/pipeline/run.ts` (`planReview`, `renderPlanInstructions`)
- Modify: `docs/superpowers/specs/2026-10-01-segment-parallel-dispatch-design.md` §2 (sorting applies to whole-file runs only)
- Test: `src/core/review/pipeline/__tests__/run.test.ts` (in `describe("planReview")`)

**Interfaces:**
- Consumes: `resolveBatchSize` (Task 1); `runUnits` (Task 2); `planSegments`, `targetPath`, `targetRange` from `./segment`; `fileLineCount`, `afterRef` from `../tools/read`.
- Produces: `planUnits(targets: string[], whole: boolean, ref: string | null, cwd: string): string[]` (exported from `run.ts`); plan text lines `Units (spawn in this order; …)` and `Spawn at most ${meta.batchSize ?? RUN_BATCH_SIZE} subagents …`.

- [ ] **Step 1: Write the failing tests**

Add to `describe("planReview")` in `run.test.ts` (import `planUnits` from `"../run"` and `runUnits` from `"../artifact"`):

```ts
  it("expands a whole-file run into segment units, largest first, and pins batchSize", async () => {
    const d = gitRepo();
    const big = Array.from({ length: 1200 }, (_, i) => `// l${i}`).join("\n") + "\n";
    writeFileSync(join(d, "big.ts"), big);
    writeFileSync(join(d, ".f-review.json"), JSON.stringify({ batchSize: 8 }));
    const msg = await planReview({ files: ["a.ts", "big.ts"] }, d); // files-only ⇒ whole-file
    const runId = /Run created: (\S+)/.exec(msg)![1];
    const meta = loadRun(runId, d)!;
    expect(meta.targets).toEqual(["a.ts", "big.ts"]);
    expect(meta.batchSize).toBe(8);
    expect(meta.units).toEqual(["big.ts#1-500", "big.ts#441-940", "big.ts#881-1200", "a.ts"]);
    expect(msg).toContain("2 file(s) → 4 unit(s)");
    expect(msg).toContain("Units (spawn in this order");
    expect(msg).toContain("- big.ts#1-500 (segment 1/3 of big.ts, 1200 lines)");
    expect(msg).toContain("- big.ts#881-1200 (segment 3/3 of big.ts)");
    expect(msg).toContain("at most 8 subagents");
    expect(msg).toContain('files=["<unit id exactly as listed above');
    expect(msg).toContain("ONE subagent per missing unit");
  });

  it("keeps units equal to targets, in target order, for a diff-mode run", async () => {
    const d = gitRepo();
    const msg = await planReview({}, d);
    const runId = /Run created: (\S+)/.exec(msg)![1];
    const meta = loadRun(runId, d)!;
    expect(meta.units).toEqual(["a.ts", "b.ts"]);
    expect(runUnits(meta)).toEqual(meta.targets);
    expect(msg).not.toContain("unit(s)");
    expect(msg).toContain("2 file(s)");
  });

  it("planUnits sorts whole-file units by line count, ties by path then start", () => {
    const d = dir();
    writeFileSync(join(d, "s.ts"), "x\n".repeat(300));
    writeFileSync(join(d, "m.ts"), "x\n".repeat(700));
    writeFileSync(join(d, "big.ts"), "x\n".repeat(2500));
    expect(planUnits(["s.ts", "big.ts", "m.ts"], true, null, d)).toEqual([
      "m.ts",
      "big.ts#1-500",
      "big.ts#441-940",
      "big.ts#881-1380",
      "big.ts#1321-1820",
      "big.ts#1761-2260",
      "s.ts",
      "big.ts#2201-2500",
    ]);
    expect(planUnits(["s.ts", "big.ts", "m.ts"], false, null, d)).toEqual(["s.ts", "big.ts", "m.ts"]);
  });
```

Also update the existing test at line 236 (`creates a run and returns fan-out instructions`): keep `expect(msg).toContain(\`at most ${RUN_BATCH_SIZE} subagents\`)` — it still holds (no config ⇒ 5).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/review/pipeline/__tests__/run.test.ts -t "segment units|diff-mode run|planUnits"`
Expected: FAIL (`planUnits` not exported; `meta.units` undefined).

- [ ] **Step 3: Implement `planUnits` and plan-time pinning**

In `run.ts` add imports:

```ts
import { planSegments, targetPath, targetRange } from "./segment";
import { afterRef, fileLineCount } from "../tools/read";
import { loadConfigSource, resolveBatchSize, resolveDeepPasses } from "../config";
import { loadRun, resultUnit, runUnits, type RunMeta } from "./artifact";
```

(replace the existing `../config` and `./artifact` import lines accordingly.)

Add before `planReview`:

```ts
/**
 * The dispatch units of a run. Diff mode: the targets, in order — the work is
 * the diff, not the file. Whole-file mode: every target over SEGMENT_THRESHOLD
 * expanded to its segment ids, the whole list sorted by line count descending
 * so a batch holds units of similar cost; ties by (path, start) so the order is
 * deterministic. A file's short last segment may therefore sort after a small
 * whole file — intended.
 */
export function planUnits(targets: string[], whole: boolean, ref: string | null, cwd: string): string[] {
  if (!whole) return [...targets];
  const lines = new Map<string, number>();
  const units = targets.flatMap((path) => {
    const total = fileLineCount(cwd, ref, path) ?? 0;
    const segments = planSegments(cwd, ref, path);
    for (const unit of segments) {
      const range = targetRange(unit);
      lines.set(unit, range ? range.end - range.start + 1 : total);
    }
    return segments;
  });
  return units.sort(
    (a, b) =>
      lines.get(b)! - lines.get(a)! ||
      targetPath(a).localeCompare(targetPath(b)) ||
      (targetRange(a)?.start ?? 0) - (targetRange(b)?.start ?? 0)
  );
}
```

In `planReview`, after the `MAX_RUN_TARGETS` check and `const config = …`, extend the `planned` literal — add two properties after `whole`:

```ts
    units: planUnits(targets, args.whole ?? (commit === undefined && !!args.files?.length), afterRef(range), cwd),
    batchSize: resolveBatchSize(cwd),
```

(`whole` is computed inline twice; to avoid drift, hoist it: `const whole = args.whole ?? (commit === undefined && !!args.files?.length);` before `planned` and use `whole` in both places.)

`planFingerprint` is left unchanged (units/batchSize derive from targets + config).

- [ ] **Step 4: Implement the plan rendering**

In `renderPlanInstructions`, replace the first statement `const list = meta.targets.map(...)` with:

```ts
  // List every UNIT: the orchestrator dispatches from this text, so a truncated
  // list would silently drop work onto the single finalize retry. Order is the
  // spawn order (planUnits sorted it by cost).
  const units = runUnits(meta);
  const split = units.length !== meta.targets.length;
  const segmentsOf = new Map<string, string[]>();
  for (const unit of units) {
    const path = targetPath(unit);
    if (targetRange(unit)) (segmentsOf.get(path) ?? segmentsOf.set(path, []).get(path)!).push(unit);
  }
  const lineCountOf = (path: string): number =>
    Math.max(...(segmentsOf.get(path) ?? []).map((u) => targetRange(u)?.end ?? 0));
  const list = units.map((unit) => {
    const range = targetRange(unit);
    if (!range) return `  - ${unit}`;
    const path = targetPath(unit);
    const siblings = segmentsOf.get(path)!;
    const index = siblings.findIndex((u) => targetRange(u)!.start === range.start) + 1;
    const first = index === 1 ? `, ${lineCountOf(path)} lines` : "";
    return `  - ${unit} (segment ${index}/${siblings.length} of ${path}${first})`;
  });
```

Note `segmentsOf` lists siblings in `units` order, which is by size then start; `index` must be positional by `start`, so sort the siblings once:

```ts
  for (const siblings of segmentsOf.values()) {
    siblings.sort((a, b) => targetRange(a)!.start - targetRange(b)!.start);
  }
```

(place this loop right after the `for (const unit of units)` loop.)

Replace the reviewer spawn step (the first element of `steps`):

```ts
    [
      `For EACH unit above, spawn ONE subagent of type \`f-reviewer\` with this prompt:`,
      `   "Call f_review_context with runId=\"${meta.runId}\" and files=[\"<unit id exactly as listed above, including any #start-end suffix>\"], review that single unit, and call f_review_submit. Review nothing else."`,
    ].join("\n"),
    `Spawn at most ${meta.batchSize ?? RUN_BATCH_SIZE} subagents at a time; wait for a batch to finish before the next.`,
```

In `judgeSteps` and the non-judge branch, change `file=\"<file>\"` to `file=\"<unit id>\"`, `after EACH f-reviewer subagent finishes` stays, and both "missing files" sentences become:

```ts
        `If finalize reports missing units, re-spawn ONE subagent per missing unit ONCE (judging each again), then finalize again.${recoveryParts}`,
```

```ts
        `If finalize reports missing units, re-spawn ONE subagent per missing unit ONCE, then finalize again.${recoveryParts}`,
```

Also change line 309 `For EACH file above, spawn ONE subagent` → the `For EACH unit above` wording shown above. Search the test suites for `"For EACH file above"` (none today) and `RUN_BATCH_SIZE` assertions (run.test.ts:241 still passes: no config ⇒ 5).

Add the heading line and the unit count to the returned array — replace the `Run created:` line and the `...list` spread:

```ts
    `Run created: ${meta.runId} — ${meta.targets.length} file(s)${split ? ` → ${units.length} unit(s)` : ""}, mode: ${meta.range ? `commit diff (${meta.range})` : "explicit files"}${meta.whole ? " · whole-file" : ""}${(meta.deepPasses ?? 1) > 1 ? ` · ${meta.deepPasses} review rounds/target` : ""}${meta.failOn ? ` · gate: failOn=${meta.failOn}` : ""}${meta.judge ? ` · judge gate on` : ""}${meta.fcqFix ? ` · fix pass on` : ""}.`,
    settingsLine,
    ...(split
      ? [`Units (spawn in this order; a large file is split into segment units — ONE f-reviewer per unit):`]
      : []),
    ...list,
```

In the non-judge `missing` instruction inside `finalizeRun` (line ~585) and the judge recovery text, the wording changes in Task 5.

- [ ] **Step 5: Amend the spec §2**

In the spec, replace the sentence starting `- **unit 정렬: 라인 수 내림차순.**` so it begins:

```
- **unit 정렬 (whole-file 모드만): 라인 수 내림차순.** diff 모드는 비용이 diff 크기에
  비례하므로 정렬하지 않고 `targets` 순서를 그대로 쓴다. whole 모드에서는 …
```

(keep the rest of the bullet.)

- [ ] **Step 6: Run tests**

Run: `bun test src/core/review/pipeline/__tests__/run.test.ts src/core/review/pipeline/__tests__/judge.test.ts src/core/review/evidence/__tests__/fcq.test.ts src/adapters && bun run typecheck`
Expected: PASS. If a test asserts the old `For EACH file above` wording, update that assertion to `For EACH unit above`.

- [ ] **Step 7: Commit**

```bash
git add src/core/review/pipeline/run.ts src/core/review/pipeline/__tests__/run.test.ts docs/superpowers/specs/2026-10-01-segment-parallel-dispatch-design.md
git commit -m "Plan segment units at f_review_plan time and list them for dispatch"
```

---

### Task 4: Reviewer joins by unit; artifact carries `target`

**Files:**
- Modify: `src/core/review/pipeline/start.ts:92-136` (`startRunFileReview` validation + targets)
- Modify: `src/core/review/pipeline/loop.ts:394-422` (`writeRunReview`)
- Test: `src/core/review/pipeline/__tests__/run.test.ts` (in `describe("run-mode session …")`)

**Interfaces:**
- Consumes: `runUnits` (Task 2); `planSegments`, `targetPath`, `targetRange` from `./segment`.
- Produces: a joined session has `state.targets = [unit]`; the written artifact has `target = unit`, `file = targetPath(unit)`.

- [ ] **Step 1: Write the failing tests**

Add to `describe("run-mode session (startReview/submitReview with runId)")`:

```ts
  it("joins one segment unit of a split file and writes a unit-keyed artifact", async () => {
    const d = gitRepo();
    const big = Array.from({ length: 1200 }, (_, i) => `// l${i}`).join("\n") + "\n";
    writeFileSync(join(d, "big.ts"), big);
    const msg = await planReview({ files: ["big.ts"] }, d);
    const runId = /Run created: (\S+)/.exec(msg)![1];

    const joined = await startReview({ runId, files: ["big.ts#441-940"] }, d, "rs");
    expect(joined).toContain(`Run ${runId}: reviewing big.ts#441-940 (lines 441-940 of big.ts`);
    expect(getState("rs")?.targets).toEqual(["big.ts#441-940"]);

    guardExploration(getState("rs")!, "file_read", "");
    const done = await submitReview(fullSubmit("big.ts", { line: 450 }), "rs");
    expect(done).toContain("✅ big.ts#441-940 reviewed");
    const results = readRunResults(runId, d);
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("big.ts");
    expect(results[0].target).toBe("big.ts#441-940");
    expect(existsSync(join(runDir(runId, d), "reviews", `${reviewSlug("big.ts#441-940")}.json`))).toBe(true);
  });

  it("bare path of a split file returns the unit list instead of a session", async () => {
    const d = gitRepo();
    writeFileSync(join(d, "big.ts"), Array.from({ length: 1200 }, (_, i) => `// l${i}`).join("\n") + "\n");
    const msg = await planReview({ files: ["big.ts"] }, d);
    const runId = /Run created: (\S+)/.exec(msg)![1];

    const out = await startReview({ runId, files: ["big.ts"] }, d, "rs");
    expect(out).toContain("big.ts is reviewed in 3 units");
    expect(out).toContain("big.ts#1-500, big.ts#441-940, big.ts#881-1200");
    expect(out).toContain("exactly ONE of these ids");
    expect(getState("rs")).toBeUndefined();
    // A unit that is not in the plan is still refused.
    expect(await startReview({ runId, files: ["big.ts#1-999"] }, d, "rs")).toContain("not a unit of run");
  });
```

Rename the two existing tests so their purpose stays honest:
- line 482 `"splits a large whole-mode target into segments within ONE session"` → `"legacy run without units still splits a large whole-mode target within ONE session"`
- line 507 `"collapses one issue found by every overlapping segment into a single row"` → `"legacy run: collapses one issue found by every overlapping segment into a single row"`

(They build `createRun` metas without `units`, which is exactly the legacy shape.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/review/pipeline/__tests__/run.test.ts -t "segment unit|bare path"`
Expected: FAIL (`big.ts#441-940` is rejected as "not a target").

- [ ] **Step 3: Implement `startRunFileReview`**

Replace lines 92-136 of `start.ts` (from the `// Defense:` comment through the `dbg("run", …)` line) with:

```ts
  // Defense: a run subagent reviews exactly one UNIT, and only one that the
  // plan actually queued — it cannot widen the fan-out on its own.
  if (files?.length !== 1) {
    return `Run mode reviews exactly ONE file: call f_review_context with runId and files=["<one target>"].`;
  }
  const unit = files[0].replaceAll("\\", "/").replace(/^\.\//, "");
  const units = runUnits(meta);
  if (!units.includes(unit)) {
    // The bare path of a file the plan split: hand back the exact ids rather
    // than a refusal — a small model that dropped the `#start-end` suffix
    // recovers from this message, not from "not a target".
    const siblings = units.filter((u) => targetRange(u) && targetPath(u) === unit);
    if (siblings.length) {
      return (
        `❌ ${unit} is reviewed in ${siblings.length} units in run ${runId}. Call f_review_context with ` +
        `exactly ONE of these ids in \`files\`: ${siblings.join(", ")}`
      );
    }
    // A segment id of a known file that the plan never listed (wrong range)
    // is "not a unit"; an unknown file stays "not a target" as before.
    return meta.targets.includes(targetPath(unit))
      ? `❌ ${unit} is not a unit of run ${runId}. Units: ${units.join(", ")}`
      : `❌ ${unit} is not a target of run ${runId}. Targets: ${meta.targets.join(", ")}`;
  }
  const file = unit;
  const existingReview = readFileReviewResult(runId, file, cwd);
  if (existingReview) {
    const status = meta.judge ? reviewReworkStatus(runId, file, cwd) : "complete";
    if (status !== "rework") {
      if (status === "unjudged") {
        return (
          `ℹ️ ${file} already has a submitted review artifact in run ${runId}. ` +
          `Do NOT overwrite it; spawn f-judge for this file next. Finalizing now would mark it INCOMPLETE.`
        );
      }
      return (
        `ℹ️ ${file} already has a terminal review artifact in run ${runId}` +
        `${meta.judge ? ` (${status})` : ""}. Do NOT overwrite it; continue with the other files or call f_review_finalize.`
      );
    }
  }
  if (meta.judge && currentReviewTerminal(runId, file, cwd)) {
    return (
      `⚠️ ${file} has a terminal Judge INCOMPLETE result in run ${runId}. ` +
      `Do NOT re-review it; continue with the other files or call f_review_finalize.`
    );
  }
  // Judge-cap enforcement: past the run's rework cap the latest review
  // stands — an orchestrator that lost the cap message must not respawn
  // reviewer+judge pairs forever.
  if (meta.judge && reworkCount(runId, file, cwd) > reworkCap(meta)) {
    return (
      `⚠️ ${file} already hit the judge rework cap (${reworkCap(meta)}) in run ${runId} — ` +
      `its latest review stands. Do NOT re-review; continue with the other files or call f_review_finalize.`
    );
  }

  setReviewDebug(loadConfig(cwd).debug === true);
  const ref = afterRef(meta.range);
  // Plans that list units already split large files; this session reviews its
  // one unit. A legacy run.json (no `units`) keeps the in-session split so an
  // in-flight run survives a plugin upgrade unchanged.
  const reviewTargets =
    meta.units === undefined && meta.whole ? planSegments(cwd, ref, unit) : [unit];
  dbg("run", `join runId=${runId} unit=${unit} targets=${reviewTargets.length}`);
```

Keep the rest of the function; the `file` variable continues to feed `buildDiffMap(meta.range, [file], cwd)` and `readFcqFile(runDir(runId, cwd), file)` — change those two to the real path:

```ts
    diffMap: buildDiffMap(meta.range, [targetPath(unit)], cwd),
```

```ts
    fcqViolations: meta.fcq?.status === "ok" ? readFcqFile(runDir(runId, cwd), targetPath(unit)) : undefined,
```

and the judge feedback slot already uses `file` (= unit), which is the key judgments use (Task 6).

Replace the returned first line:

```ts
  const range = targetRange(unit);
  const where = range ? ` (lines ${range.start}-${range.end} of ${targetPath(unit)}` : ` (`;
  return [
    `Run ${runId}: reviewing ${unit}${where}${range ? "; " : ""}${meta.range ? `commit diff ${meta.range}` : "explicit files"}${meta.whole ? " · whole-file" : ""}).${seg}${rounds}`,
```

Add `runUnits` to the `./artifact` import and `targetPath, targetRange` to the `./segment` import in `start.ts`.

- [ ] **Step 4: Implement `writeRunReview`**

In `loop.ts`, replace line 399:

```ts
  const file = targetPath(st.targets[0]); // single file per run session (segments share it)
```

with:

```ts
  // One unit per run session: a file, or one segment of it. The artifact is
  // keyed by the unit (so sibling segments never overwrite each other) and
  // reports findings under the real path.
  const target = st.targets[0];
  const file = targetPath(target);
```

and add `target,` to the `result` literal after `file,`. In the two `head` strings replace `${file}` with `${target}`.

- [ ] **Step 5: Run tests**

Run: `bun test src/core/review/pipeline/__tests__/run.test.ts src/core/review/pipeline/__tests__/loop.test.ts src/core/review/pipeline/__tests__/judge.test.ts src/core/review/pipeline/__tests__/deep-pass.test.ts && bun run typecheck`
Expected: PASS. The existing assertion `expect(done).toContain("✅ a.ts reviewed")` still holds (target === file).

- [ ] **Step 6: Commit**

```bash
git add src/core/review/pipeline/start.ts src/core/review/pipeline/loop.ts src/core/review/pipeline/__tests__/run.test.ts
git commit -m "Join parallel runs by unit id and write unit-keyed review artifacts"
```

---

### Task 5: Finalize merges units per file

**Files:**
- Modify: `src/core/review/pipeline/run.ts` (`finalizeRun`)
- Test: `src/core/review/pipeline/__tests__/run.test.ts` (in `describe("finalizeRun")`)

**Interfaces:**
- Consumes: `resultUnit`, `runUnits` (Task 2); `targetPath`, `targetRange`; `dedupeFindings`, `mergeFcqFindings` (existing).
- Produces: response wording `N unit(s) across M file(s)` when split; `missing:` lists unit ids; `Re-spawn ONE f-reviewer subagent per missing unit`.

- [ ] **Step 1: Write the failing tests**

Add to `describe("finalizeRun")`:

```ts
  it("merges segment units of one file into one report section and dedupes the overlap", async () => {
    const d = gitRepo();
    const meta = await createRun(
      { ...baseMeta(["big.ts", "a.ts"]), whole: true, range: null, units: ["big.ts#1-500", "big.ts#441-940", "a.ts"] },
      d
    );
    const f = (line: number, rule: string, message = "issue") => ({
      category: "correctness" as const, severity: "major" as const, file: "big.ts", line, rule, message, suggestion: "fix",
    });
    await writeFileReview(meta.runId, result("big.ts", { target: "big.ts#1-500", findings: [f(10, "r-early"), f(450, "dup", "phrasing A")] }), "# s1", d);
    await writeFileReview(meta.runId, result("big.ts", { target: "big.ts#441-940", findings: [f(450, "dup", "phrasing B"), f(900, "r-late")] }), "# s2", d);
    await writeFileReview(meta.runId, result("a.ts", { findings: [] }), "# a", d);

    const msg = await finalizeRun(meta.runId, d);
    expect(msg).toContain("✅ Run complete — 3 unit(s) across 2 file(s), 3 issue(s)");
    const path = /Report: (.+)$/.exec(msg)![1];
    const md = readFileSync(join(d, path), "utf8");
    expect(md.match(/^## big\.ts$/gm)).toHaveLength(1); // one section, not one per segment
    expect(md).toContain("## a.ts");
    expect((md.match(/\| dup \|/g) ?? []).length).toBe(1); // overlap duplicate collapsed
    expect(md.indexOf("r-early")).toBeLessThan(md.indexOf("r-late")); // segment order kept
    expect(md).toContain("- big.ts (2 segments)");
  });

  it("names the missing and partial units, not their files", async () => {
    const d = gitRepo();
    const meta = await createRun(
      { ...baseMeta(["big.ts"]), whole: true, range: null, units: ["big.ts#1-500", "big.ts#441-940", "big.ts#881-1200"] },
      d
    );
    await writeFileReview(meta.runId, result("big.ts", { target: "big.ts#1-500" }), "# s1", d);
    await writeFileReview(meta.runId, result("big.ts", { target: "big.ts#881-1200", partial: true, coverageComplete: false }), "# s3", d);

    const msg = await finalizeRun(meta.runId, d);
    expect(msg).toContain("⚠️ INCOMPLETE — 2/3");
    expect(msg).toContain("missing: big.ts#441-940");
    expect(msg).not.toContain("missing: big.ts.");
    expect(msg).toContain("per missing unit");

    await writeFileReview(meta.runId, result("big.ts", { target: "big.ts#441-940" }), "# s2", d);
    const again = await finalizeRun(meta.runId, d);
    expect(again).toContain("1 partial review(s)");
    expect(again).toContain("Run terminated — INCOMPLETE: 3/3");
  });

  it("overlap duplicate collapses before the fcq merge pairs it with one fcq row", async () => {
    const d = gitRepo();
    const meta = await createRun(
      {
        ...baseMeta(["big.ts"]), whole: true, range: null, units: ["big.ts#1-500", "big.ts#441-940"],
        fcq: { status: "ok", command: "fcq", durationMs: 1, exitCode: 0 },
      },
      d
    );
    // One fcq violation on the overlap line, in the shard layout readFcqFile reads.
    // (No summary.json on purpose: finalize then reports the run quality-incomplete,
    // but the fcq rows still merge into the report, which is what this test checks.)
    const shard = fcqShardPath(runDir(meta.runId, d), "big.ts");
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(
      shard,
      JSON.stringify([
        { analyzer: "pmd", ruleId: "LineLength", description: "line too long", category: "code-style", severity: "MINOR", line: 450, message: "too long" },
      ])
    );
    const follow = (message: string) => ({
      category: "maintainability" as const, severity: "minor" as const, file: "big.ts", line: 450,
      rule: "LineLength follow-up", message, asIs: "x", toBe: "y",
    });
    await writeFileReview(meta.runId, result("big.ts", { target: "big.ts#1-500", findings: [follow("A")] }), "# s1", d);
    await writeFileReview(meta.runId, result("big.ts", { target: "big.ts#441-940", findings: [follow("B")] }), "# s2", d);

    const msg = await finalizeRun(meta.runId, d);
    const path = /Report: (.+)$/.exec(msg)![1];
    const md = readFileSync(join(d, path), "utf8");
    // Exactly one row for line 450: the two reviewer copies collapsed, then paired with the fcq row.
    expect((md.match(/\| 450 \|/g) ?? []).length).toBe(1);
    expect(md).toContain("fcq:pmd/LineLength"); // the fcq identity won the merged row
  });
```

Imports for this block: `fcqShardPath` from `"../../evidence/fcq"` and `dirname` from `"node:path"` (add to the existing `node:path` import on line 4 of `run.test.ts`). `mergeFcqFindings` pairs a reviewer finding with an fcq row when the lines match AND `${rule} ${message}` contains the fcq `ruleId` lower-cased — `"LineLength follow-up"` satisfies that.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/review/pipeline/__tests__/run.test.ts -t "merges segment units|missing and partial units|overlap duplicate"`
Expected: FAIL (`findings[r.file] = …` overwrites; response says `file(s)`).

- [ ] **Step 3: Implement the per-file merge**

In `finalizeRun`, replace lines 368-380 (from `const { reviewed, missing } = runCoverage(meta, results);` through the `for (const r of targetResults) findings[r.file] = dedupeFindings(r.findings);` loop) with:

```ts
  const { reviewed, missing } = runCoverage(meta, results);
  const units = runUnits(meta);
  const split = units.length !== meta.targets.length;

  const unitResults = results.filter((result) => units.includes(resultUnit(result)));
  const resultByUnit = new Map(unitResults.map((result) => [resultUnit(result), result]));
  // Segments of one file merge back under its real path, in segment order.
  // dedupeFindings returns a NEW array, which is also the copy this needs: the
  // fcq merge below appends to it, and the judge check hashes the parsed review
  // objects — mutating those would unmatch every recorded judgment and report
  // the run as unjudged. It also collapses the overlap-band repeats two
  // segments report with different wording, and it runs BEFORE the fcq merge
  // so one fcq row pairs with one reviewer finding, never with two copies.
  const byFile = new Map<string, typeof unitResults>();
  for (const result of unitResults) {
    (byFile.get(result.file) ?? byFile.set(result.file, []).get(result.file)!).push(result);
  }
  const findings: Record<string, Finding[]> = {};
  for (const [file, group] of byFile) {
    group.sort(
      (a, b) =>
        (targetRange(resultUnit(a))?.start ?? 0) - (targetRange(resultUnit(b))?.start ?? 0)
    );
    findings[file] = dedupeFindings(group.flatMap((result) => result.findings));
  }
```

Then update every later use of `targetResults` → `unitResults` and `resultByFile` → `resultByUnit`. The `partials`, `forced`, `coverageIncomplete` arrays map with `resultUnit` instead of `.file`:

```ts
  const partials = unitResults.filter((r) => r.partial).map(resultUnit);
  const forced = unitResults.filter((r) => r.forced).map(resultUnit);
  const coverageIncomplete = unitResults.filter((r) => !r.coverageComplete).map(resultUnit);
```

Inside the judge block, `byFile` (judgments map) is renamed `judgmentByUnit` to avoid shadowing the new `byFile`:

```ts
    const judgmentByUnit = new Map(judgments.map((judgment) => [judgment.file, judgment]));
    const currentAttempt = (unit: string) => {
      const review = resultByUnit.get(unit);
      if (!review) return undefined;
      const hash = reviewArtifactHash(review);
      return judgmentByUnit.get(unit)?.attempts.findLast(
        (attempt) =>
          attempt.reviewRevision === review.revision &&
          attempt.reviewArtifactHash === hash
      );
    };
    const currentTerminal = (unit: string) => {
      const review = resultByUnit.get(unit);
      if (!review) return undefined;
      const hash = reviewArtifactHash(review);
      const terminal = judgmentByUnit.get(unit)?.terminal;
      return terminal?.reviewRevision === review.revision &&
        terminal.reviewArtifactHash === hash
        ? terminal
        : undefined;
    };
```

(`reviewed` is already a unit list from Task 2, so the `.filter` loops over units unchanged.)

Review Context file list — replace the `renderReviewContext(meta.targets, {` call's first argument:

```ts
  const contextFiles = meta.targets.map((file) => {
    const n = units.filter((unit) => targetPath(unit) === file).length;
    return n > 1 ? `${file} (${n} segments)` : file;
  });
  const context = renderReviewContext(contextFiles, {
```

Response wording — replace the three `response =` branches' counts:

```ts
  const scope = split
    ? `${reviewed.length} unit(s) across ${meta.targets.length} file(s)`
    : `${reviewed.length} file(s)`;
  let response: string;
  if (missing.length) {
    response = (
      `⚠️ INCOMPLETE — ${reviewed.length}/${units.length} ${split ? "unit(s)" : "file(s)"} reviewed; missing: ${missing.join(", ")}.` +
      `${gate}${forcedWarn}${truncatedWarn} Partial report: ${path}\n` +
      `Re-spawn ONE f-reviewer subagent per missing ${split ? "unit" : "file"} (same runId), then call f_review_finalize again. Do this at most once.`
    );
  } else if (qualityIncomplete) {
    response = (
      `⚠️ Run terminated — INCOMPLETE: ${reviewed.length}/${units.length} review artifact(s) present; ` +
      `${qualityReasons.join("; ")}.${gate}${forcedWarn}${truncatedWarn}${fixWarn} Report: ${path}`
    );
  } else {
    const fcqNote = fcqSummary ? ` (incl. ${fcqSummary.targetViolations} from fcq)` : "";
    response = `✅ Run complete — ${scope}, ${all.length} issue(s)${fcqNote}.${gate}${forcedWarn}${truncatedWarn}${fixWarn} Report: ${path}`;
  }
```

The plan-instruction wording in Task 3 already says `per missing unit`; the test in this task expects the finalize message to say `per missing unit` for a split run and `per missing file` otherwise — the code above does that.

- [ ] **Step 4: Run tests**

Run: `bun test src/core/review/pipeline/__tests__/run.test.ts src/core/review/pipeline/__tests__/judge.test.ts src/core/review/pipeline/__tests__/fixer.test.ts src/core/review/evidence/__tests__/fcq.test.ts && bun run typecheck`
Expected: PASS. Existing expectations like `"✅ Run complete — 2 file(s), 1 issue(s)"` and `"⚠️ INCOMPLETE — 1/2"` are unchanged for unsplit runs.

- [ ] **Step 5: Commit**

```bash
git add src/core/review/pipeline/run.ts src/core/review/pipeline/__tests__/run.test.ts
git commit -m "Finalize merges per-unit artifacts into one section per file"
```

---

### Task 6: Judge keyed by unit, sees the segment window

**Files:**
- Modify: `src/core/review/pipeline/judge.ts:95-97, 359-361` (target check)
- Modify: `src/core/review/pipeline/judge-prompt.ts` (`changeExcerpt`, `buildJudgePrompt`, `coveragePrompt`, `coverageOutline`)
- Test: `src/core/review/pipeline/__tests__/judge.test.ts`

**Interfaces:**
- Consumes: `runUnits`, `resultUnit` (Task 2); `targetPath`, `targetRange` from `./segment`; `violationsForTarget` from `../evidence/fcq`.
- Produces: `changeExcerpt(meta, unit, cwd, findings)` renders the segment window as the base when `unit` is a segment id; judge prompts instruct `file="<unit>"`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe("segment units")` block to `judge.test.ts`:

```ts
describe("segment units", () => {
  /** 1200-line whole-file run planned into three segment units. Lines are kept
   * short (~32 bytes rendered) so a 500-line segment fits JUDGE_CHANGE_MAX_BYTES
   * whole — the tests below depend on the base being shown, not windowed. */
  async function segmentRun() {
    const d = gitRepo();
    writeFileSync(
      join(d, "big.ts"),
      Array.from({ length: 1200 }, (_, i) => `function f${i}(){} // line ${i + 1}`).join("\n") + "\n"
    );
    const meta = await createRun(
      baseMeta({ targets: ["big.ts"], whole: true, range: null, units: ["big.ts#1-500", "big.ts#441-940", "big.ts#881-1200"] }),
      d
    );
    const segmentReview = (unit: string, line: number): FileReviewResult => ({
      ...reviewResult("big.ts"),
      target: unit,
      findings: [{ ...reviewResult("big.ts").findings[0], line }],
    });
    return { d, meta, segmentReview };
  }

  it("judges one unit over its own window and addresses the verdict to the unit id", async () => {
    const { d, meta, segmentReview } = await segmentRun();
    await writeFileReview(meta.runId, segmentReview("big.ts#441-940", 600), "# s2", d);

    // The bare file is not a unit of a split run.
    expect(judgeContext(meta.runId, "big.ts", d)).toContain("not a unit");
    const out = judgeContext(meta.runId, "big.ts#441-940", d);
    expect(out).toContain("judging the review of big.ts lines 441-940");
    expect(out).toMatch(/\/\/ line 600\b/);
    // \b: "// line 100" must not match inside "// line 1000".
    expect(out).not.toMatch(/\/\/ line 100\b/);
    expect(out).not.toMatch(/\/\/ line 1000\b/);
    expect(out).toContain('file="big.ts#441-940"');
  });

  it("a finding outside the segment window gets an evidence window", async () => {
    const { d, meta, segmentReview } = await segmentRun();
    // inFileRelated can surface a declaration from outside the segment; the
    // judge must see that line rather than refute the finding against absence.
    await writeFileReview(meta.runId, segmentReview("big.ts#441-940", 1100), "# s2", d);
    const out = judgeContext(meta.runId, "big.ts#441-940", d);
    expect(out).toContain("// line 1100");
    expect(out).toContain("Excerpts around finding lines");
  });

  it("judge verdicts for two units of one file are isolated", async () => {
    const { d, meta, segmentReview } = await segmentRun();
    await writeFileReview(meta.runId, segmentReview("big.ts#1-500", 10), "# s1", d);
    await writeFileReview(meta.runId, segmentReview("big.ts#441-940", 600), "# s2", d);

    const pass = await submitJudge(judgePayload(meta.runId, 90, { file: "big.ts#1-500" }), d);
    expect(pass).toContain("Judge PASS for big.ts#1-500");
    const rework = await submitJudge(judgePayload(meta.runId, 10, { file: "big.ts#441-940" }), d);
    expect(rework).toContain("Judge REWORK for big.ts#441-940");
    expect(rework).toContain('files=["big.ts#441-940"]');

    expect(readRunJudgments(meta.runId, d).map((j) => j.file).sort()).toEqual(["big.ts#1-500", "big.ts#441-940"]);
    expect(judgeFeedbackFor(meta.runId, "big.ts#1-500", d)).toBe("");
    expect(judgeFeedbackFor(meta.runId, "big.ts#441-940", d)).toContain("rework required");

    // Re-joining the reworked unit carries the feedback; the passed one is refused.
    expect(await startReview({ runId: meta.runId, files: ["big.ts#1-500"] }, d, SESSION)).toContain("already has a terminal review artifact");
    const rejoin = await startReview({ runId: meta.runId, files: ["big.ts#441-940"] }, d, SESSION);
    expect(rejoin).toContain("reviewing big.ts#441-940");
    expect(getState(SESSION)?.requirementBackground).toContain("rework required");
  });

  it("a clean segment unit is judged over its own lines", async () => {
    const { d, meta } = await segmentRun();
    await writeFileReview(meta.runId, { ...reviewResult("big.ts"), target: "big.ts#881-1200", findings: [] }, "# s3", d);
    const out = judgeContext(meta.runId, "big.ts#881-1200", d);
    expect(out).toMatch(/\/\/ line 881\b/);
    expect(out).toMatch(/\/\/ line 1200\b/);
    expect(out).not.toMatch(/\/\/ line 100\b/);
    expect(out).toContain('file="big.ts#881-1200"');
  });

  it("a clean segment too wide for the base falls back to the coverage part addressed to the unit", async () => {
    // 500 lines × ~130 bytes ≈ 65 KB > JUDGE_CHANGE_MAX_BYTES: the segment base
    // cannot be shown whole, and a zero-finding review has no anchors, so the
    // coverage-only salvage runs — and must still name the unit, not the file.
    const d = gitRepo();
    writeFileSync(
      join(d, "wide.ts"),
      Array.from({ length: 1200 }, (_, i) => `export function g${i}() { return "${"x".repeat(100)}"; } // line ${i + 1}`).join("\n") + "\n"
    );
    const meta = await createRun(
      baseMeta({ targets: ["wide.ts"], whole: true, range: null, units: ["wide.ts#1-500", "wide.ts#441-940", "wide.ts#881-1200"] }),
      d
    );
    await writeFileReview(meta.runId, { ...reviewResult("wide.ts"), target: "wide.ts#441-940", findings: [] }, "# s2", d);
    const out = judgeContext(meta.runId, "wide.ts#441-940", d);
    expect(out).not.toContain("Judge context INCOMPLETE");
    expect(out).toContain("COVERAGE ONLY");
    expect(out).toContain('file="wide.ts#441-940"');
    expect(out).toContain("lines 441-940");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/review/pipeline/__tests__/judge.test.ts -t "segment units"`
Expected: FAIL (`big.ts#441-940` is "not a target"; prompt names `file="big.ts"`).

- [ ] **Step 3: Implement `judge.ts`**

Replace both occurrences of

```ts
  if (!meta.targets.includes(file)) {
    return `❌ ${file} is not a target of run ${runId}. Targets: ${meta.targets.join(", ")}`;
  }
```

with

```ts
  if (!runUnits(meta).includes(file)) {
    return `❌ ${file} is not a unit of run ${runId}. Units: ${runUnits(meta).join(", ")}`;
  }
```

and import `runUnits` from `./artifact`. Update the existing test `"rejects a file outside the run's targets"` expectation from `"not a target"` to `"not a unit"` (and the same string in `"rejects an unknown run and a non-target file"` under `submitJudge`). Everything else in `judge.ts` treats `file` as an opaque key already.

- [ ] **Step 4: Implement `judge-prompt.ts` — `changeExcerpt`**

Add imports:

```ts
import { fileDeclarations, targetPath, targetRange } from "./segment";
import { readFcqFile, renderFcqEvidence, violationsForTarget } from "../evidence/fcq";
import { loadRun, resultUnit, type RunMeta } from "./artifact";
```

Replace the signature and the whole-file branch of `changeExcerpt`. The second parameter becomes the UNIT; `visibleTo` becomes a visible `{start,end}` range so a segment base and a whole-file base share one window rule:

```ts
export function changeExcerpt(
  meta: RunMeta,
  unit: string,
  cwd: string,
  findings: Finding[]
): string | JudgeContextOverflow {
  const file = targetPath(unit);
  const range = targetRange(unit);
  const ref = afterRef(meta.range);
  const content = readFileAt(cwd, ref, file);
  const totalLines = content === null ? 0 : content.replace(/\n$/, "").split("\n").length;
  let base = "";
  // Lines the base shows; null when it shows none (diff base, or no base).
  let shown: { start: number; end: number } | null = null;
  let needsWindows = false;

  if (meta.range && !meta.whole) {
    const diff = buildDiffMap(meta.range, [file], cwd)[file] ?? "";
    if (diff) {
      needsWindows = byteLen(diff) > JUDGE_DIFF_MAX_BYTES;
      base = needsWindows
        ? `${sliceBytes(diff, JUDGE_DIFF_MAX_BYTES)}\n… (diff truncated)`
        : diff;
    }
  }

  if (!base) {
    if (content === null) {
      base = `Error: file not found: ${file}. The reviewed source is unavailable.`;
    } else {
      // A segment unit's base is its own window, numbered with real line
      // numbers; a file unit's base is the whole file. Either is shown whole or
      // not at all (see the comment below).
      const span = range ?? { start: 1, end: totalLines };
      const spanLines = span.end - span.start + 1;
      const rendered = renderFileContent(
        file,
        content,
        span.start,
        span.end,
        Math.min(spanLines, JUDGE_FILE_MAX_LINES),
        JUDGE_CHANGE_MAX_BYTES
      );
      // The reader caps characters; the budget is bytes. A multi-byte source
      // can pass its cap and still overrun, so measure the cut here too.
      const whole =
        spanLines <= JUDGE_FILE_MAX_LINES &&
        !rendered.includes("IS_TRUNCATED: true") &&
        byteLen(rendered) <= JUDGE_CHANGE_MAX_BYTES;
      // Whole or nothing. A partial base is a prefix the finding windows below
      // re-render line for line, and paying for it twice is what turned a file
      // that fits into a terminal INCOMPLETE. Without it the windows own the
      // whole change budget and the header says what is visible.
      base = whole ? rendered : "";
      shown = whole ? span : null;
      needsWindows = !whole;
    }
  }

  if (byteLen(base) > JUDGE_CHANGE_MAX_BYTES) {
    return contextOverflow(`the base change excerpt exceeds ${JUDGE_CHANGE_MAX_BYTES} bytes`);
  }
  // A segment base is complete for ITS window, but a finding anchored outside
  // it (a declaration inFileRelated surfaced from elsewhere in the file) still
  // needs its own window — otherwise the judge refutes it against absence.
  const outside = (line: number): boolean => !shown || line < shown.start || line > shown.end;
  const hiddenLines = findings
    .map((finding) => finding.line)
    .filter((line): line is number => line !== undefined && outside(line));
  if (!needsWindows && !hiddenLines.length) return base;
  if (content === null) {
    return contextOverflow("the capped change excerpt requires finding windows but source is unavailable");
  }
  if (needsWindows) {
    // Once any part of the change is hidden, a clean review has no anchors from
    // which to recover the omitted code, and an unanchored finding cannot be
    // checked against a targeted window. Letting either case continue would let
    // a judge see only the prefix and still award PASS/complete coverage.
    if (!findings.length) {
      return contextOverflow(
        "the change excerpt is truncated and the zero-finding review has no anchors for the omitted code"
      );
    }
    const unanchored = findings.filter((finding) => finding.line === undefined).length;
    if (unanchored) {
      return contextOverflow(
        `the change excerpt is truncated and ${unanchored} finding(s) have no line anchor`
      );
    }
  }
  if (!hiddenLines.length) return base;

  const windows = findingWindows(hiddenLines, totalLines).map(({ start, end }) =>
    renderFileContent(file, content, start, end, end - start + 1, JUDGE_CHANGE_MAX_BYTES)
  );
  const excerpt = [
    base,
    base
      ? `### Excerpts around finding lines the capped excerpt above does not show`
      : `### ${file} is ${totalLines} lines — too large to show whole; excerpts around every finding line`,
    `(judge these findings against the windows below, not against absence:\n` +
      `code outside these ranges was not shown to you and is not a coverage gap)`,
    ...windows,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (byteLen(excerpt) > JUDGE_CHANGE_MAX_BYTES) {
    return contextOverflow(
      `${windows.length} merged finding window(s) plus the base exceed ${JUDGE_CHANGE_MAX_BYTES} bytes`
    );
  }
  return excerpt;
}
```

Behavioural check against the old code: for a file unit `shown = {1,totalLines}` when whole, so `outside(line)` is never true for in-file anchors → identical to the old `line > visibleTo` test; for a diff base `shown = null` → every anchored finding gets a window only when `needsWindows` (diff truncated) — the old code returned `base` early when `!needsWindows`, and here `hiddenLines` would be non-empty for a diff base. Preserve the old short-circuit: compute `hiddenLines` only when `shown !== null || needsWindows`:

```ts
  const hiddenLines = (shown || needsWindows)
    ? findings.map((f) => f.line).filter((line): line is number => line !== undefined && outside(line))
    : [];
```

(Use this form instead of the simpler one above.)

- [ ] **Step 5: Implement `judge-prompt.ts` — prompts address the unit**

In `buildJudgePrompt`:
- `const unit = resultUnit(result); const range = targetRange(unit);`
- `const excerpt = changeExcerpt(meta, unit, cwd, scoped);`
- fcq: `renderFcqEvidence(violationsForTarget(readFcqFile(runDir(meta.runId, cwd), result.file), unit), meta.fcqFix)`
- heading: `` `You are judging the review of ${result.file}${range ? ` lines ${range.start}-${range.end}` : ""} (run ${meta.runId}, judge round ${round})` ``
- both instruction blocks: `file="${result.file}"` → `file="${unit}"`.

In `coveragePrompt`:
- `const unit = resultUnit(result); const range = targetRange(unit);`
- `const lo = range?.start ?? 1; const hi = range?.end ?? totalLines;`
- heading: `` `You are judging the review of ${result.file}${range ? ` lines ${lo}-${hi}` : ""} (run ${meta.runId})` ``
- instruction: `file="${unit}"`.
- `wholeHeading` non-diff branch: `` [`### The file under review (${range ? `lines ${lo}-${hi} of ${totalLines}` : `${totalLines} lines`})`] ``
- `partialHeading` non-diff branch: lines become `lines ${lo}-${lo + shownTo - 1} of ${lo}-${hi}` and `Lines ${lo + shownTo}-${hi} were NOT shown…`
- `const of = diff ? … : hi - lo + 1;`
- call `coverageOutline(result.file, content, totalLines, budget, lo, hi)`.

`coverageOutline` gains `lo = 1, hi = totalLines` parameters; `render(lines)` becomes `renderFileContent(file, content, lo, lo + lines - 1, lines, Number.POSITIVE_INFINITY)` and `shownTo` starts at `hi - lo + 1`. The `declarationOutline` fallback stays whole-file (structure of the entire file is still the right coverage view).

- [ ] **Step 6: Run tests**

Run: `bun test src/core/review/pipeline/__tests__/judge.test.ts src/core/review/pipeline/__tests__/judge-parts.test.ts src/core/review/pipeline/__tests__/run.test.ts && bun run typecheck`
Expected: PASS, including the pre-existing `judge excerpt covers finding lines past the cap` block (file units are unchanged by construction).

- [ ] **Step 7: Commit**

```bash
git add src/core/review/pipeline/judge.ts src/core/review/pipeline/judge-prompt.ts src/core/review/pipeline/__tests__/judge.test.ts
git commit -m "Judge segment units over their own window, keyed by unit id"
```

---

### Task 7: Orchestrator command template and user guide

**Files:**
- Modify: `src/adapters/opencode/review/prompts.ts:296-310` (`REVIEW_COMMAND_TEMPLATE`)
- Modify: `docs/guides/f-review-usage.md` (config table + fan-out lines 15, 226)
- Test: `src/adapters/opencode/review/__tests__/index.test.ts`

**Interfaces:** none new; text only.

- [ ] **Step 1: Write the failing test**

Add to `src/adapters/opencode/review/__tests__/index.test.ts` (find the existing `describe` that inspects `REVIEW_COMMAND_TEMPLATE`; if none imports it, add `import { REVIEW_COMMAND_TEMPLATE } from "../prompts";`):

```ts
  it("command template defers the batch size and unit list to the plan", () => {
    expect(REVIEW_COMMAND_TEMPLATE).not.toContain("At most 5 subagents");
    expect(REVIEW_COMMAND_TEMPLATE).toContain("the batch limit the plan states");
    expect(REVIEW_COMMAND_TEMPLATE).toContain("ONE f-reviewer subagent per unit");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/adapters/opencode/review/__tests__/index.test.ts -t "command template defers"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `REVIEW_COMMAND_TEMPLATE`, replace the hard rules bullets 1-2:

```
   - ONE f-reviewer subagent per unit listed by the plan; pass it the exact
     prompt from the plan (it must call \`f_review_context\` with the runId and
     its single unit id, copied EXACTLY — a large file is listed as several
     \`path#start-end\` segment units, and each is its own subagent).
   - Never exceed the batch limit the plan states (subagents in flight at a
     time); wait for the batch to finish before dispatching the next batch.
```

and in step 4 replace `re-spawn ONE subagent per missing file` with `re-spawn ONE subagent per missing unit`.

In `docs/guides/f-review-usage.md`:
- line 15: `파일 1개씩 병렬 리뷰 (최대 5개 동시)` → `unit 1개씩 병렬 리뷰 (동시 수는 batchSize, 기본 5). 1000줄 초과 파일은 500줄 세그먼트 unit으로 나뉘어 각각 병렬`
- config table: add a row after `maxToolCalls`:
  `| \`batchSize\`    | number   | \`5\` (1~20)             | 동시에 띄우는 서브에이전트 수. 세그먼트 unit이 많을수록 올릴 가치가 있음 |`
- line 226: `한 번에 최대 100개 파일, 동시 서브에이전트 5개.` → `한 번에 최대 100개 파일, 동시 서브에이전트 수는 \`batchSize\`(기본 5). 1000줄 초과 whole-file 대상은 세그먼트 unit으로 쪼개져 각각 디스패치되고, 리포트에서는 파일 1개 섹션으로 합쳐진다.`

- [ ] **Step 4: Run tests**

Run: `bun test src/adapters && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/opencode/review/prompts.ts src/adapters/opencode/review/__tests__/index.test.ts docs/guides/f-review-usage.md
git commit -m "Orchestrator template: dispatch per unit, batch size from the plan"
```

---

### Task 8: Whole-suite verification and build

**Files:** none new.

- [ ] **Step 1: Full test run**

Run: `bun test`
Expected: all pass (baseline was 897; expect ≥ 912 with the new tests), 0 fail.

- [ ] **Step 2: Typecheck and build**

Run: `bun run typecheck && bun run build`
Expected: both succeed.

- [ ] **Step 3: End-to-end smoke in a temp repo (no LLM)**

```bash
cd "$(mktemp -d)" && git init -q && git config user.email t@t && git config user.name t
seq 1 1300 | sed 's/^/\/\/ line /' > big.ts && echo 'x' > small.ts && git add -A && git commit -qm init
bun -e '
import { planReview, finalizeRun } from "/Users/koscom/workspace/gordian-coder/.claude/worktrees/segment-parallel-dispatch/src/core/review/pipeline/run";
import { startReview, submitReview } from "/Users/koscom/workspace/gordian-coder/.claude/worktrees/segment-parallel-dispatch/src/core/review";
import { guardExploration } from "/Users/koscom/workspace/gordian-coder/.claude/worktrees/segment-parallel-dispatch/src/core/review/pipeline/loop";
import { getState } from "/Users/koscom/workspace/gordian-coder/.claude/worktrees/segment-parallel-dispatch/src/core/review/pipeline/state";
import { loadRun, runUnits } from "/Users/koscom/workspace/gordian-coder/.claude/worktrees/segment-parallel-dispatch/src/core/review/pipeline/artifact";
const cwd = process.cwd();
const plan = await planReview({ files: ["big.ts", "small.ts"] }, cwd);
console.log(plan);
const runId = /Run created: (\S+)/.exec(plan)[1];
const units = runUnits(loadRun(runId, cwd));
await Promise.all(units.map(async (unit, i) => {
  const sid = `s${i}`;
  console.log(await startReview({ runId, files: [unit] }, cwd, sid));
  guardExploration(getState(sid), "file_read", "");
  console.log(await submitReview({ submitToken: getState(sid).submitToken, assessed: ["correctness","security","performance","maintainability","tests","framework"], findings: [] }, sid));
}));
console.log(await finalizeRun(runId, cwd));
'
```

Expected: plan lists 4 units (`big.ts#1-500`, `big.ts#441-940`, `big.ts#881-1300`, `small.ts`); four concurrent joins succeed; finalize prints `✅ Run complete — 4 unit(s) across 2 file(s), 0 issue(s)` and the report has one `## big.ts` section. If `REQUIRED_CATEGORIES` differs from the six listed, import it instead of the literal.

- [ ] **Step 4: Update the spec's status and commit**

Append to the spec under `## 작업 환경`: `구현 완료: <date>, 브랜치 worktree-segment-parallel-dispatch.` Then:

```bash
git add docs/superpowers/specs/2026-10-01-segment-parallel-dispatch-design.md
git commit -m "Mark segment parallel dispatch spec as implemented"
```

- [ ] **Step 5: Report**

State the test counts, the smoke output's unit list and finalize line, and that the branch is ready for review/merge into `develop` (do not merge or push unless asked).
