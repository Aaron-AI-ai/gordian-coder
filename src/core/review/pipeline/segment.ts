/**
 * Whole-file review of large files.
 *
 * A 4000-line file reviewed in one shot either overflows the injection budget
 * or dilutes the model's attention, so we split it into overlapping line
 * segments — each becomes its own review target and gets a fresh pass. To keep
 * a segment from being reviewed blind, we also surface the same-file
 * declarations it references but that live outside its window, so related code
 * is read together with the segment rather than in isolation.
 *
 * Segment target ids are encoded as `path#start-end`; `targetPath` /
 * `targetRange` decode them, and every other module treats a target as opaque.
 */

import { fileLineCount, fileRead, readFileAt } from "../tools/read";

/** Files at or below this line count are reviewed whole (unsplit). */
export const SEGMENT_THRESHOLD = 1000;
/** Lines per segment for a split file. */
const SEGMENT_LINES = 500;
/** Lines carried over between adjacent segments so boundary code isn't split blind. */
const SEGMENT_OVERLAP = 60;
/** Lines shown per surfaced declaration. */
const INFILE_WINDOW = 24;
/** Backstop on the whole related-code block so a segment that references very many
 * out-of-window declarations can't produce an unbounded prompt. */
const INFILE_MAX_CHARS = 24_000;

// ponytail: a real source path is very unlikely to end in "#\d+-\d+"; if one
// ever does it would be misread as a segment. Accept the edge case.
const SEG_RE = /^(.*)#(\d+)-(\d+)$/;

export function segmentId(path: string, start: number, end: number): string {
  return `${path}#${start}-${end}`;
}

/** Real file path for a target id (segment ids strip their `#start-end`). */
export function targetPath(target: string): string {
  const m = SEG_RE.exec(target);
  return m ? m[1] : target;
}

/** Line range for a segment target, or null for a plain (whole-file) target. */
export function targetRange(target: string): { start: number; end: number } | null {
  const m = SEG_RE.exec(target);
  return m ? { start: Number(m[2]), end: Number(m[3]) } : null;
}

/**
 * Expand a file into overlapping segment ids when it exceeds the threshold;
 * otherwise return the path unchanged (reviewed whole). Unreadable files are
 * left as a single target.
 */
export function planSegments(cwd: string, ref: string | null, path: string): string[] {
  const total = fileLineCount(cwd, ref, path);
  if (total === null || total <= SEGMENT_THRESHOLD) return [path];

  const ids: string[] = [];
  let start = 1;
  while (start <= total) {
    const end = Math.min(total, start + SEGMENT_LINES - 1);
    ids.push(segmentId(path, start, end));
    if (end >= total) break;
    start = end - SEGMENT_OVERLAP + 1;
  }
  return ids;
}

const DECL_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/, // python
];

/** Declared symbol → 1-based line of its first declaration. */
function fileDeclarations(content: string): Map<string, number> {
  const decls = new Map<string, number>();
  const lines = content.replace(/\n$/, "").split("\n");
  lines.forEach((line, i) => {
    for (const re of DECL_PATTERNS) {
      const m = re.exec(line);
      if (m && m[1].length >= 3 && !decls.has(m[1])) decls.set(m[1], i + 1);
    }
  });
  return decls;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = "\n… (truncated)";
  return text.slice(0, maxChars - suffix.length) + suffix;
}

/**
 * Same-file declarations the segment [start,end] references but that are
 * defined outside its window — rendered as small line-numbered previews so the
 * model reviews the segment together with the code it depends on. "" when none.
 */
export function inFileRelated(
  cwd: string,
  ref: string | null,
  path: string,
  start: number,
  end: number
): string {
  const content = readFileAt(cwd, ref, path);
  if (content === null) return "";
  const decls = fileDeclarations(content);
  if (!decls.size) return "";

  const segment = content.replace(/\n$/, "").split("\n").slice(start - 1, end).join("\n");

  const hits: { name: string; line: number }[] = [];
  for (const [name, line] of decls) {
    if (line >= start && line <= end) continue; // declared inside the segment already
    if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(segment)) hits.push({ name, line });
  }
  if (!hits.length) return "";
  hits.sort((a, b) => a.line - b.line);

  // Every referenced-but-out-of-window declaration is surfaced (no count cap);
  // the char backstop only trips for pathological files.
  const blocks = hits.flatMap(({ name, line }) => [
    `- ${name} (declared at line ${line}):`,
    fileRead(cwd, ref, path, line, line + INFILE_WINDOW - 1, INFILE_WINDOW),
  ]);
  const header =
    `Same-file declarations referenced by this segment but defined outside it ` +
    `(${hits.length} found — review these together with the segment):`;
  return capText([header, ...blocks].join("\n"), INFILE_MAX_CHARS);
}
