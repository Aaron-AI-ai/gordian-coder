import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEGMENT_THRESHOLD,
  inFileRelated,
  planSegments,
  segmentId,
  targetPath,
  targetRange,
} from "../segment";
import { currentFile, currentFilePath, type ReviewState } from "../state";

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "k-seg-"));
  tmps.push(d);
  return d;
}

describe("segment id encode/decode", () => {
  it("round-trips a segment id", () => {
    const id = segmentId("src/big.ts", 801, 1600);
    expect(id).toBe("src/big.ts#801-1600");
    expect(targetPath(id)).toBe("src/big.ts");
    expect(targetRange(id)).toEqual({ start: 801, end: 1600 });
  });

  it("treats a plain path as a whole-file target", () => {
    expect(targetPath("src/a.ts")).toBe("src/a.ts");
    expect(targetRange("src/a.ts")).toBeNull();
  });

  it("currentFilePath hands filesystem/git callers the real path", () => {
    const st = { targets: ["src/big.ts#1-500", "src/big.ts#441-940"], currentIndex: 0 } as ReviewState;
    expect(currentFile(st)).toBe("src/big.ts#1-500"); // raw target id
    expect(currentFilePath(st)).toBe("src/big.ts"); // what git can actually resolve
    st.currentIndex = 2;
    expect(currentFilePath(st)).toBeUndefined(); // exhausted queue
  });
});

describe("planSegments", () => {
  it("leaves a small file unsplit", () => {
    const d = dir();
    writeFileSync(join(d, "small.ts"), "x\n".repeat(100));
    expect(planSegments(d, null, "small.ts")).toEqual(["small.ts"]);
  });

  it("splits a large file into overlapping segments covering every line", () => {
    const d = dir();
    const n = 4000;
    writeFileSync(join(d, "big.ts"), Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n") + "\n");
    const segs = planSegments(d, null, "big.ts");
    expect(segs.length).toBeGreaterThan(1);

    const ranges = segs.map((s) => targetRange(s)!);
    expect(ranges[0].start).toBe(1);
    expect(ranges.at(-1)!.end).toBe(n); // last segment reaches EOF
    // Contiguous coverage: each segment starts at/before the previous end (overlap).
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBeLessThanOrEqual(ranges[i - 1].end + 1);
    }
    expect(SEGMENT_THRESHOLD).toBeGreaterThan(0);
  });
});

describe("inFileRelated", () => {
  it("surfaces a declaration referenced by the segment but defined outside it", () => {
    const d = dir();
    const lines = [
      "export function helper() { return 42; }", // line 1 — declared outside the segment
      ...Array.from({ length: 900 }, () => "// filler"), // lines 2..901
      "export function useHelper() { return helper(); }", // ~line 902 — references helper
    ];
    writeFileSync(join(d, "big.ts"), lines.join("\n") + "\n");

    const related = inFileRelated(d, null, "big.ts", 900, 903);
    expect(related).toContain("helper (declared at line 1)");
    expect(related).toContain("1|export function helper");
  });

  it("returns empty when the segment references nothing outside itself", () => {
    const d = dir();
    writeFileSync(join(d, "big.ts"), "const a = 1;\nconst b = 2;\n");
    expect(inFileRelated(d, null, "big.ts", 1, 2)).toBe("");
  });

  it("surfaces ALL referenced out-of-window declarations, not a capped subset", () => {
    const d = dir();
    const n = 9; // more than the old cap of 6
    const decls = Array.from({ length: n }, (_, i) => `export function helper${i}() { return ${i}; }`);
    const filler = Array.from({ length: 700 }, () => "// filler");
    const user = `export function useAll() { return ${decls.map((_, i) => `helper${i}()`).join(" + ")}; }`;
    writeFileSync(join(d, "big.ts"), [...decls, ...filler, user].join("\n") + "\n");

    const related = inFileRelated(d, null, "big.ts", 700, 710);
    for (let i = 0; i < n; i++) expect(related).toContain(`helper${i} (declared at line ${i + 1})`);
    expect(related).toContain(`${n} found`);
  });
});
