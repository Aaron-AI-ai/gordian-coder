# Guard Module Registry Implementation Plan (f-log Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the small-model loop defenses (`guardExploration` + `repeat-guard.ts`) module-neutral so f-log can register itself and get the exact same protection f-review has, without copying 450 lines.

**Architecture:** Move the per-round exploration guard and its constants out of `review/pipeline/loop.ts` into `src/core/guard.ts`, typed on a structural `GuardState` that `ReviewState` already satisfies. Turn `repeat-guard.ts` from "imports review state directly" into a registry: each feature module registers `{lookup, submitTool, explorers, idempotentPatterns, guard, submitAdvice}`, and every guard function resolves the active module for the session. f-review registers itself inside `repeat-guard.ts` at load (so every existing test keeps passing untouched); f-log registers from its own adapter in Plan B.

**Tech Stack:** Bun, TypeScript strict, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-16-f-log-design.md` §13 (가드 공용화).

## Global Constraints

- f-review behavior must not change. Proof: `src/adapters/opencode/__tests__/repeat-guard.test.ts` and `src/core/review/**/__tests__` pass **without modification**.
- `src/adapters/opencode/index.ts` is not modified (it consumes the same eight repeat-guard exports).
- Constants keep their values: `MAX_DUP_CALLS = 2`, `MAX_MISS_STREAK = 4`, `REPEAT_LIMIT = 3`, `HARD_LIMIT = 6`, `RESERVED_SUBMIT_CALLS = 2`, `GRACE_CALLS = 3`, `MAX_SESSIONS = 256`.
- Existing import paths keep working: `loop.ts` re-exports `guardExploration`, `MAX_DUP_CALLS`, `MAX_MISS_STREAK`.
- Commit messages: imperative, no prefix, no Co-Authored-By line (project memory rule).
- Run from the worktree: `/Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/guard.ts` (create) | `GuardState` interface, `guardExploration(st, scope, tool, out, args?)`, `MAX_DUP_CALLS`, `MAX_MISS_STREAK`, `MISS_PREFIXES`. Pure, no review imports. |
| `src/core/review/pipeline/loop.ts` (modify) | Delete the moved constants/function; keep a `guardExploration(st: ReviewState, tool, out, args?)` wrapper that passes `currentFile(st)` as scope; re-export the constants. |
| `src/adapters/opencode/repeat-guard.ts` (modify) | Add `GuardModule` + `registerGuardModule`; replace direct `getState`/`f_review_submit`/`REVIEW_EXPLORERS`/`IDEMPOTENT_REPLAY_PATTERN` uses with the active module's fields; register the review module at load. |
| `src/core/__tests__/guard.test.ts` (create) | Core guard on a bare `GuardState` literal. |
| `src/adapters/opencode/__tests__/repeat-guard-registry.test.ts` (create) | A fake second module registers and is gated with its own submit tool / explorers / advice. |

---

### Task 1: Extract the core exploration guard

**Files:**
- Create: `src/core/guard.ts`
- Modify: `src/core/review/pipeline/loop.ts:44-56` (constants) and the `guardExploration` function body (starts at the `/** Count an exploration call … */` comment, ends at the closing brace before `export const MAX_FINAL_RECHECKS` is *not* affected — only the three constants + the function move)
- Test: `src/core/__tests__/guard.test.ts`

**Interfaces:**
- Consumes: `MAX_ITER` from `src/core/review/tools/read.ts` (unchanged).
- Produces:
  ```ts
  export interface GuardState {
    active: boolean;
    iterations: number;
    maxIter?: number;
    toolCalls: number;
    explorationCalls: number;
    maxToolCalls: number;
    explorationSealed: boolean;
    toolBudgetExhausted: boolean;
    graceCalls?: number;
    callLog: Record<string, Record<string, number>>;
    dupCalls: Record<string, number>;
    missStreak: number;
  }
  export function guardExploration(st: GuardState, scope: string | undefined, tool: string, out: string, args?: unknown, submitTool?: string): string
  export const MAX_DUP_CALLS = 2;
  export const MAX_MISS_STREAK = 4;
  export const MISS_PREFIXES: readonly string[];
  ```
  `submitTool` defaults to `"f_review_submit"` so the review wrapper's messages are byte-identical to today.

- [ ] **Step 1: Write the failing test**

`src/core/__tests__/guard.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { guardExploration, MAX_DUP_CALLS, MAX_MISS_STREAK, type GuardState } from "../guard";
import { MAX_ITER } from "../review/tools/read";

function state(over: Partial<GuardState> = {}): GuardState {
  return {
    active: true,
    iterations: 0,
    toolCalls: 1,
    explorationCalls: 0,
    maxToolCalls: 10,
    explorationSealed: false,
    toolBudgetExhausted: false,
    callLog: {},
    dupCalls: {},
    missStreak: 0,
    ...over,
  };
}

describe("core guard", () => {
  test("passes fresh output through and logs the call under the scope", () => {
    const st = state();
    expect(guardExploration(st, "run-1", "f_log_read", "content", { p: 1 })).toBe("content");
    expect(st.iterations).toBe(1);
    expect(st.callLog["run-1"]).toEqual({ f_log_read: 1 });
  });

  test("withholds output past the per-round budget and names the submit tool", () => {
    const st = state({ iterations: MAX_ITER });
    const out = guardExploration(st, "run-1", "f_log_read", "content", undefined, "f_log_submit");
    expect(out).toContain("Exploration limit reached");
    expect(out).toContain("f_log_submit");
    expect(out).not.toContain("content");
  });

  test("withholds an exact duplicate past MAX_DUP_CALLS", () => {
    const st = state();
    for (let i = 0; i < MAX_DUP_CALLS; i++) {
      expect(guardExploration(st, "s", "t", "x", { a: 1 })).toBe("x");
    }
    expect(guardExploration(st, "s", "t", "x", { a: 1 })).toContain("Duplicate call");
  });

  test("withholds after MAX_MISS_STREAK consecutive misses and resets on a hit", () => {
    const st = state();
    for (let i = 0; i < MAX_MISS_STREAK - 1; i++) {
      guardExploration(st, "s", "code_search", "No matches for: x" + i);
    }
    expect(guardExploration(st, "s", "code_search", "No matches for: y")).toContain("found NOTHING");
    guardExploration(st, "s", "code_search", "hit");
    expect(st.missStreak).toBe(0);
  });

  test("sealed exploration withholds regardless of budget", () => {
    const st = state({ explorationSealed: true });
    expect(guardExploration(st, "s", "t", "x")).toContain("Exploration is sealed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/__tests__/guard.test.ts`
Expected: FAIL — `Cannot find module '../guard'`.

- [ ] **Step 3: Create `src/core/guard.ts`**

```ts
/**
 * Session-level exploration guard shared by every feature module (f-review,
 * f-log). A small model in a tool loop is starved, not argued with: past the
 * budget the output is withheld entirely, an exact duplicate is answered at
 * most MAX_DUP_CALLS times, and a run of consecutive misses is cut off.
 *
 * `GuardState` is structural — ReviewState satisfies it as-is, and a new
 * module's session state only has to carry these fields.
 */

import { MAX_ITER } from "./review/tools/read";

export interface GuardState {
  active: boolean;
  iterations: number;
  maxIter?: number; // per-round exploration budget (unset = MAX_ITER)
  toolCalls: number; // session-total calls, never reset
  explorationCalls: number; // session-total exploration attempts, never reset
  maxToolCalls: number; // hard ceiling for the session
  explorationSealed: boolean; // true once only the submit tool may make progress
  toolBudgetExhausted: boolean; // terminal: watchdog must finalize partial, never auto-resume
  graceCalls?: number; // non-submit calls seen after exhaustion
  callLog: Record<string, Record<string, number>>; // scope → tool → count
  dupCalls: Record<string, number>; // scope+tool+args hash → count
  missStreak: number; // consecutive not-found results
}

/** Max times the SAME tool call (identical args) is answered per scope/round;
 * past this, the output is withheld — a looping model gets no new content. */
export const MAX_DUP_CALLS = 2;

/** Max CONSECUTIVE not-found exploration results; past this, output is
 * withheld. Catches the "hunt an external symbol with endless pattern
 * variations" loop that exact-duplicate detection cannot see. */
export const MAX_MISS_STREAK = 4;

/** Not-found openings of the reader ops. Both modules' tools share read.ts /
 * related.ts, so the prefixes are the same for both. */
export const MISS_PREFIXES: readonly string[] = [
  "No matches for:", // code_search
  "// No file matches", // file_find
  "Error: file not found", // file_read
  "Error: diff not found", // file_read_diff
  "No related code candidates", // related_code
  "No git history found", // git_history
  "No blame available", // git_blame (f-log)
  "No callers found", // find_callers (f-log)
];

/**
 * Count an exploration call under `scope` (review: current file; log: runId)
 * and guard against degenerate loops. The op itself still runs — it's local
 * and cheap; the defense is starving the loop of fresh tokens. `submitTool`
 * names the only productive next move in every notice.
 */
export function guardExploration(
  st: GuardState,
  scope: string | undefined,
  tool: string,
  out: string,
  args?: unknown,
  submitTool = "f_review_submit"
): string {
  if (st.explorationSealed) {
    return (
      `⚠️ Exploration is sealed for this reviewer session (${st.toolCalls}/${st.maxToolCalls} ` +
      `tool calls used). Output withheld. Call ${submitTool} now.`
    );
  }
  if (scope) {
    const log = (st.callLog[scope] ??= {});
    log[tool] = (log[tool] ?? 0) + 1;
  }
  st.iterations++;
  const budget = st.maxIter ?? MAX_ITER;
  if (st.iterations > budget) {
    return `⚠️ Exploration limit reached (${budget} calls this round) — output withheld. Review with what you have and call ${submitTool} now. Do not fetch more context through any other tool.`;
  }
  if (args !== undefined) {
    const key = JSON.stringify([scope ?? "", tool, Bun.hash(JSON.stringify(args)).toString()]);
    const n = (st.dupCalls[key] = (st.dupCalls[key] ?? 0) + 1);
    if (n > MAX_DUP_CALLS) {
      return (
        `⚠️ Duplicate call — this exact ${tool} call already ran ${MAX_DUP_CALLS} times and its result does not change; output withheld. ` +
        `Explore something different or call ${submitTool} for ${scope ?? "the current target"} — do not re-fetch this content through any other tool.`
      );
    }
  }
  const miss = MISS_PREFIXES.some((p) => out.startsWith(p));
  st.missStreak = miss ? st.missStreak + 1 : 0;
  if (miss && st.missStreak >= MAX_MISS_STREAK) {
    return (
      `⚠️ ${st.missStreak} consecutive lookups found NOTHING — output withheld. What you are ` +
      `hunting was not resolved by the allowed targeted lookups; it may be external, generated, ` +
      `or a local alias the resolver cannot map. STOP retrying path/name variations with any tool. ` +
      `Review with the evidence you already have and call ${submitTool}.`
    );
  }
  return out;
}
```

- [ ] **Step 4: Replace the moved code in `loop.ts` with a wrapper**

In `src/core/review/pipeline/loop.ts`:
1. Delete the `MAX_DUP_CALLS`, `MAX_MISS_STREAK`, `MISS_PREFIXES` declarations and the whole `guardExploration` function.
2. Add near the top imports:
```ts
import { guardExploration as guardScoped, MAX_DUP_CALLS, MAX_MISS_STREAK } from "../../guard";
export { MAX_DUP_CALLS, MAX_MISS_STREAK };
```
3. Add where the function used to be:
```ts
/** Review wrapper over the shared guard: the scope is the file under review
 * and the productive next move is always f_review_submit. */
export function guardExploration(st: ReviewState, tool: string, out: string, args?: unknown): string {
  return guardScoped(st, currentFile(st), tool, out, args, "f_review_submit");
}
```
`currentFile` is already imported in loop.ts.

- [ ] **Step 5: Run the new test and the whole existing suite**

Run: `bun test src/core/__tests__/guard.test.ts`
Expected: PASS (5 tests).

Run: `bun test`
Expected: PASS — every pre-existing test, notably `src/adapters/opencode/__tests__/repeat-guard.test.ts` and `src/core/review/pipeline/__tests__/*`, unchanged. If a message-text assertion fails, the wrapper is not passing `"f_review_submit"` — fix the wrapper, never the test.

Run: `bun run typecheck`
Expected: no errors. (`ReviewState` must satisfy `GuardState` structurally; it does — every field exists with the same type.)

- [ ] **Step 6: Commit**

```bash
git add src/core/guard.ts src/core/__tests__/guard.test.ts src/core/review/pipeline/loop.ts
git commit -m "Move the exploration guard to core so any module can use it"
```

---

### Task 2: Turn repeat-guard into a module registry

**Files:**
- Modify: `src/adapters/opencode/repeat-guard.ts` (whole file — the imports, `ALWAYS_ALLOWED_TOOLS`, `REVIEW_EXPLORERS`, `IDEMPOTENT_REPLAY_PATTERN`, `REPEAT_OUTPUT_ALLOWLIST`, and every `getState(sessionID)` call)
- Test: `src/adapters/opencode/__tests__/repeat-guard-registry.test.ts`

**Interfaces:**
- Consumes: `GuardState` from Task 1; `getState` (review) and `guardExploration` (review wrapper) still imported *inside* repeat-guard.ts for the built-in review registration.
- Produces:
  ```ts
  export interface GuardModule {
    name: string;                                             // "review" | "log"; re-registering the same name replaces
    lookup: (sessionID: string) => GuardState | undefined;    // this module's session state
    submitTool: string;                                       // always allowed; the productive next move
    explorers: ReadonlySet<string>;                           // this module's exploration tools (counted + suppressible)
    idempotentPatterns: Record<string, RegExp>;               // control tool → "no-op replay" output pattern
    guard: (st: GuardState, tool: string, out: string, args?: unknown) => string; // module's guardExploration wrapper
    submitAdvice: string;                                     // appended by escalateLoop
  }
  export function registerGuardModule(m: GuardModule): void
  ```
  The eight exports `index.ts` uses keep their names and signatures: `recordCall`, `shouldSuppressRepeatOutput`, `shouldSuppressIdempotentReplay`, `loopNotice`, `escalateLoop`, `guardNativeCall`, `beforeReviewToolCall`, `afterReviewToolCall`.

- [ ] **Step 1: Write the failing test**

`src/adapters/opencode/__tests__/repeat-guard-registry.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
  registerGuardModule,
  recordCall,
  beforeReviewToolCall,
  afterReviewToolCall,
  escalateLoop,
  guardNativeCall,
  shouldSuppressRepeatOutput,
  shouldSuppressIdempotentReplay,
  HARD_LIMIT,
  RESERVED_SUBMIT_CALLS,
  type GuardModule,
} from "../repeat-guard";
import { guardExploration, type GuardState } from "../../../core/guard";

// A second feature module with its own session store — nothing from review.
const store = new Map<string, GuardState>();
function fakeState(): GuardState {
  return {
    active: true,
    iterations: 0,
    toolCalls: 1,
    explorationCalls: 0,
    maxToolCalls: 6,
    explorationSealed: false,
    toolBudgetExhausted: false,
    callLog: {},
    dupCalls: {},
    missStreak: 0,
  };
}
const fake: GuardModule = {
  name: "fake",
  lookup: (id) => store.get(id),
  submitTool: "fake_submit",
  explorers: new Set(["fake_read", "fake_search"]),
  idempotentPatterns: { fake_submit: /already recorded/ },
  guard: (st, tool, out, args) => guardExploration(st, "fake-run", tool, out, args, "fake_submit"),
  submitAdvice: " A fake run is active: call fake_submit NOW.",
};
registerGuardModule(fake);

describe("repeat-guard module registry", () => {
  test("a registered module's submit tool is always allowed after exhaustion", () => {
    const s = "reg-1";
    store.set(s, { ...fakeState(), toolBudgetExhausted: true });
    expect(beforeReviewToolCall(s, "fake_submit").allow).toBe(true);
    expect(beforeReviewToolCall(s, "fake_read").allow).toBe(false);
  });

  test("reserved slots are announced with the module's submit tool", () => {
    const s = "reg-2";
    const st = fakeState();
    st.toolCalls = st.maxToolCalls - RESERVED_SUBMIT_CALLS; // next call lands in the reserved zone
    store.set(s, st);
    const d = beforeReviewToolCall(s, "fake_read");
    expect(d.allow).toBe(false);
    expect(d.message).toContain("fake_submit");
    expect(d.message).not.toContain("f_review_submit");
  });

  test("the module's explorers count against exploration, unknown tools do not", () => {
    const s = "reg-3";
    store.set(s, fakeState());
    beforeReviewToolCall(s, "fake_search");
    expect(store.get(s)!.explorationCalls).toBe(1);
    beforeReviewToolCall(s, "some_control_tool");
    expect(store.get(s)!.explorationCalls).toBe(1);
  });

  test("escalateLoop seals the module's state and appends its advice", () => {
    const s = "reg-4";
    store.set(s, fakeState());
    for (let i = 0; i < HARD_LIMIT; i++) recordCall(s, "fake_read", { p: "same" });
    const tail = escalateLoop(s);
    expect(tail).toBe(fake.submitAdvice);
    expect(store.get(s)!.explorationSealed).toBe(true);
  });

  test("native explorers are guarded through the module's guard", () => {
    const s = "reg-5";
    store.set(s, { ...fakeState(), explorationSealed: true });
    recordCall(s, "grep", { pattern: "x" });
    expect(guardNativeCall(s, "grep")).toContain("fake_submit");
  });

  test("repeat suppression covers the module's explorers and its idempotent replays", () => {
    const s = "reg-6";
    store.set(s, fakeState());
    for (let i = 0; i < 3; i++) recordCall(s, "fake_read", { p: 1 });
    expect(shouldSuppressRepeatOutput(s, "fake_read")).toBe(true);
    for (let i = 0; i < 3; i++) recordCall(s, "fake_submit", { p: 1 });
    expect(shouldSuppressIdempotentReplay(s, "fake_submit", "ℹ️ already recorded")).toBe(true);
  });

  test("afterReviewToolCall exhausts the module's budget at the limit", () => {
    const s = "reg-7";
    const st = fakeState();
    st.toolCalls = st.maxToolCalls;
    store.set(s, st);
    const d = afterReviewToolCall(s, "fake_read");
    expect(d.allow).toBe(false);
    expect(d.message).toContain("fake_submit");
    expect(store.get(s)!.toolBudgetExhausted).toBe(true);
  });

  test("a session with no active module is not gated", () => {
    expect(beforeReviewToolCall("reg-none", "anything").allow).toBe(true);
    expect(escalateLoop("reg-none")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/adapters/opencode/__tests__/repeat-guard-registry.test.ts`
Expected: FAIL — `registerGuardModule is not exported` / type errors.

- [ ] **Step 3: Rewrite the registry parts of `repeat-guard.ts`**

Replace the three imports at the top with:
```ts
import { getState } from "../../core/review/pipeline/state";
import { MAX_ITER } from "../../core/review/tools/read";
import { guardExploration as reviewGuard } from "../../core/review/pipeline/loop";
import type { GuardState } from "../../core/guard";
```

Add after the `RecentCall` interface:
```ts
/** A feature module that wants the loop defenses. One is active per session
 * at most — a session is either a review or a log analysis. */
export interface GuardModule {
  name: string;
  lookup: (sessionID: string) => GuardState | undefined;
  submitTool: string;
  explorers: ReadonlySet<string>;
  idempotentPatterns: Record<string, RegExp>;
  guard: (st: GuardState, tool: string, out: string, args?: unknown) => string;
  submitAdvice: string;
}

const modules: GuardModule[] = [];

/** Register (or replace by name) a module. Idempotent so a plugin factory
 * may run more than once in tests. */
export function registerGuardModule(m: GuardModule): void {
  const i = modules.findIndex((x) => x.name === m.name);
  if (i >= 0) modules[i] = m;
  else modules.push(m);
}

/** The module whose state is active for this session, with that state. */
function activeModule(sessionID: string): { m: GuardModule; st: GuardState } | undefined {
  for (const m of modules) {
    const st = m.lookup(sessionID);
    if (st?.active) return { m, st };
  }
  return undefined;
}

/** Every module's exploration tools — the after-hook may suppress any of them. */
function moduleExplorers(): Set<string> {
  return new Set(modules.flatMap((m) => [...m.explorers]));
}
```

Delete the constants `REPEAT_OUTPUT_ALLOWLIST`, `IDEMPOTENT_REPLAY_PATTERN`, `REVIEW_EXPLORERS`, `ALWAYS_ALLOWED_TOOLS`. Keep `NATIVE_EXPLORERS` and `LOOKUP_ARG_FIELD`.

Rewrite the functions that used them (bodies otherwise unchanged):

```ts
function isSuppressibleTool(tool: string): boolean {
  return NATIVE_EXPLORERS.has(tool) || moduleExplorers().has(tool);
}

export function isAlternatingLoop(sessionID: string): boolean {
  const recentCalls = streaks.get(sessionID)?.recentCalls ?? [];
  if (recentCalls.length < RECENT_CALLS) return false;
  const [a, b, c, d] = recentCalls;
  if (!recentCalls.every((call) => isSuppressibleTool(call.tool))) return false;
  const exact = a.sig === c.sig && b.sig === d.sig && a.sig !== b.sig;
  const sameIntent =
    !!a.intent && a.intent === b.intent && b.intent === c.intent && c.intent === d.intent &&
    a.tool === c.tool && b.tool === d.tool && a.tool !== b.tool;
  return exact || sameIntent;
}

export function isRepeatOutputSuppressible(tool: string): boolean {
  return isSuppressibleTool(tool);
}

export function shouldSuppressIdempotentReplay(sessionID: string, tool: string, output: string): boolean {
  if (!isLooping(sessionID)) return false;
  return modules.some((m) => m.idempotentPatterns[tool]?.test(output));
}

export function escalateLoop(sessionID: string): string {
  if ((streaks.get(sessionID)?.count ?? 0) < HARD_LIMIT) return "";
  const active = activeModule(sessionID);
  if (!active) return "";
  active.st.iterations = Math.max(active.st.iterations, active.st.maxIter ?? MAX_ITER);
  active.st.explorationSealed = true;
  return active.m.submitAdvice;
}

export function beforeReviewToolCall(sessionID: string, tool: string): ReviewToolBudgetDecision {
  const active = activeModule(sessionID);
  if (!active) return allow();
  const { m, st } = active;
  const max = st.maxToolCalls;
  if (!Number.isFinite(max)) return allow();

  if (st.toolBudgetExhausted) {
    if (tool === m.submitTool) return allow();
    st.graceCalls = (st.graceCalls ?? 0) + 1;
    if (st.graceCalls > GRACE_CALLS) {
      return abort(
        `Review tool-call budget exhausted (maxToolCalls=${max}) and the ` +
          `${GRACE_CALLS}-call submit grace window is spent; aborting the session.`
      );
    }
    return deny(
      `Review tool-call budget exhausted (maxToolCalls=${max}). Only ${m.submitTool} ` +
        `may be called now — submit with what you have already seen.`
    );
  }

  st.toolCalls++;
  const isSubmit = tool === m.submitTool;
  const isExplorer = m.explorers.has(tool) || NATIVE_EXPLORERS.has(tool);
  if (isExplorer) st.explorationCalls++;

  if (st.toolCalls > max || (st.toolCalls === max && !isSubmit)) {
    st.toolCalls = max;
    st.explorationSealed = true;
    st.toolBudgetExhausted = true;
    return deny(
      `Review stopped exploring: maxToolCalls=${max} reached and call ${max} was ${tool}, ` +
        `not ${m.submitTool}. Only ${m.submitTool} may be called now — submit with what you have already seen.`
    );
  }

  const alternatingLoop = isExplorer && isAlternatingLoop(sessionID);
  if (alternatingLoop) st.explorationSealed = true;

  const explorationLimit = Math.max(0, max - RESERVED_SUBMIT_CALLS - 1);
  if (isExplorer && st.explorationCalls > explorationLimit) st.explorationSealed = true;

  if (!isSubmit && st.toolCalls > max - RESERVED_SUBMIT_CALLS) {
    st.explorationSealed = true;
    return deny(
      `Tool call ${st.toolCalls}/${max} blocked before execution because this slot was reserved ` +
        `for ${m.submitTool}/recovery. ${max - st.toolCalls} call(s) remain; call ${m.submitTool} now.`
    );
  }

  if (isExplorer && st.explorationSealed) {
    const reason = alternatingLoop
      ? "an alternating lookup loop was detected"
      : `the ${explorationLimit}-call exploration allowance was consumed`;
    return deny(`Exploration blocked before execution because ${reason}. Tool budget: ${st.toolCalls}/${max}; call ${m.submitTool} now.`);
  }
  return allow();
}

export function afterReviewToolCall(sessionID: string, tool: string): ReviewToolBudgetDecision {
  const active = activeModule(sessionID);
  if (!active || active.st.toolCalls < active.st.maxToolCalls) return allow();
  active.st.explorationSealed = true;
  active.st.toolBudgetExhausted = true;
  return deny(
    `Review tool-call budget exhausted after ${tool} (${active.st.toolCalls}/${active.st.maxToolCalls}). ` +
      `Only ${active.m.submitTool} may be called now — submit with what you have.`
  );
}

export function guardNativeCall(sessionID: string, tool: string): string {
  if (!NATIVE_EXPLORERS.has(tool)) return "";
  const active = activeModule(sessionID);
  if (!active) return "";
  const sig = streaks.get(sessionID)?.sig ?? "";
  const missStreak = active.st.missStreak;
  const notice = active.m.guard(active.st, tool, "", sig);
  active.st.missStreak = missStreak; // "" is never a miss — undo the reset
  return notice;
}
```

**Check against the original before deleting:** the original `beforeReviewToolCall` counted `isExplorer = REVIEW_EXPLORERS.has(tool)` where `REVIEW_EXPLORERS` included the native set — the rewrite keeps that (`m.explorers.has(tool) || NATIVE_EXPLORERS.has(tool)`). The original messages said "Only f_review_submit may be called now — submit the review with what you have already seen." — the existing test asserts on `f_review_submit`/`maxToolCalls` substrings only; if any existing assertion fails on the shortened wording, restore the exact original sentence with `${m.submitTool}` substituted.

At the very bottom of the file, register the review module so behavior at load is identical to today:
```ts
// f-review registers itself here — not from review/index.ts — so the guards
// are armed even in tests that never build the plugin. f-log registers from
// its adapter (createLogModule).
registerGuardModule({
  name: "review",
  lookup: getState,
  submitTool: "f_review_submit",
  explorers: new Set(["file_read", "file_read_diff", "file_find", "code_search", "related_code", "git_history"]),
  idempotentPatterns: {
    f_review_submit: /Stale\/duplicate f_review_submit ignored|No active review/,
    f_review_judge: /already recorded|Judge INCOMPLETE|already hit the judge rework cap/,
    f_review_plan: /Refusing to create another run|still being created by another process/,
    f_review_context: /Duplicate f_review_context ignored|already has (?:a submitted|a terminal) review artifact/,
  },
  guard: (st, tool, out, args) => reviewGuard(st as Parameters<typeof reviewGuard>[0], tool, out, args),
  submitAdvice:
    " A review is active in this session: STOP exploring — call f_review_submit " +
    "NOW with the findings you already have.",
});
```

- [ ] **Step 4: Run the registry test, then the whole suite**

Run: `bun test src/adapters/opencode/__tests__/repeat-guard-registry.test.ts`
Expected: PASS (8 tests).

Run: `bun test`
Expected: PASS with **zero edits** to `repeat-guard.test.ts`, `index.test.ts`, or any review test. A failure there means the rewrite changed review behavior — fix repeat-guard.ts.

Run: `bun run typecheck && bun run build`
Expected: clean. `index.ts` compiles untouched.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/opencode/repeat-guard.ts src/adapters/opencode/__tests__/repeat-guard-registry.test.ts
git commit -m "Let feature modules register with the repeat guard"
```

---

## Self-review

- **Spec coverage (§13):** `GuardState` ✓ Task 1; `guardExploration` moved + review re-export ✓ Task 1; `registerGuardModule` with `lookup/submitTool/explorers/idempotentPatterns/submitAdvice` ✓ Task 2 (plus `guard` so the native-call path uses the module's own scope); `opencode/index.ts` unchanged ✓; existing repeat-guard tests unmodified as regression proof ✓ Task 2 Step 4.
- **Deviation from spec, on purpose:** the spec said review registers from `review/index.ts`; here it registers at the bottom of `repeat-guard.ts` so the ~30 existing tests that seed review state without building the plugin keep passing unmodified. f-log still registers from its adapter as the spec says.
- **Type consistency:** `guardExploration(st, scope, tool, out, args?, submitTool?)` in core; review wrapper `guardExploration(st, tool, out, args?)` keeps the old 4-arg shape; `GuardModule.guard` is `(st, tool, out, args?)` — matches the wrapper shape.
