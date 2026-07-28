import { afterEach, describe, expect, it } from "bun:test";
import { dbg, dbgOnce, reviewDebugEnabled } from "../debug";

const orig = process.env.F_REVIEW_DEBUG;
afterEach(() => {
  if (orig === undefined) delete process.env.F_REVIEW_DEBUG;
  else process.env.F_REVIEW_DEBUG = orig;
});

function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = console.error;
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.error = spy;
  }
  return lines;
}

describe("review debug", () => {
  it("is silent when the flag is unset", () => {
    delete process.env.F_REVIEW_DEBUG;
    expect(reviewDebugEnabled()).toBe(false);
    expect(captureStderr(() => dbg("x", "hi"))).toEqual([]);
  });

  it("emits when the flag is set", () => {
    process.env.F_REVIEW_DEBUG = "1";
    expect(captureStderr(() => dbg("start", "hi"))).toEqual(["[f-review:start] hi"]);
  });

  it("dbgOnce logs a key only the first time", () => {
    process.env.F_REVIEW_DEBUG = "1";
    const key = `k-${Math.random()}`; // fresh key: the dedup set persists across calls
    const out = captureStderr(() => {
      dbgOnce(key, "prompt", "first");
      dbgOnce(key, "prompt", "second");
    });
    expect(out).toEqual(["[f-review:prompt] first"]);
  });
});
