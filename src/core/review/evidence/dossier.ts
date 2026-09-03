/**
 * The evidence dossier injected before a reviewer starts on a file.
 *
 * It composes what the deterministic tools already know — related code, git
 * history, the source of imports that resolve inside the repository, and the
 * framework KB pages a specifier maps to — into one bounded block, so a model
 * that would not have called those tools still sees the answers.
 *
 * Every section is budgeted. A file the budget drops stays listed as a
 * candidate path: dropped from injection must not mean invisible.
 */

import { capText, readFileAt } from "../tools/read";
import {
  discoverRelatedFiles,
  gitHistory,
  preview,
  renderRelatedList,
  type RelatedFile,
} from "../tools/related";
import { fileImports, isExternalImport, unresolvedImports } from "../imports";
import { frameworkKbDocs, type KbDoc } from "./framework-kb";

// Raised for the injected import sources and KB pages below. The budget buys
// back more than it costs: each fact the reviewer would otherwise fetch costs a
// tool call, a turn, AND a whole-file read to find a few lines.
const AUTO_EVIDENCE_MAX_CHARS = 24_000;

/** Imported project files whose source is injected, ranked most-related first. */
const IMPORT_SOURCE_MAX_FILES = 6;

/** Per-file cap for that source. A large utility class is truncated rather than
 * dropped: its head carries the class declaration, fields, and first methods. */
const IMPORT_SOURCE_MAX_CHARS = 3_000;

/** Section budget for injected import sources. Sized so a typical service's
 * whole import set (VOs, a BSM, a mapper) lands intact — a file the budget cuts
 * falls back to being a candidate the reviewer must go fetch, which is the cost
 * this section exists to remove. */
const IMPORT_SOURCE_SECTION_MAX_CHARS = 12_000;

/** Section budget for framework KB pages. */
const KB_SECTION_MAX_CHARS = 8_000;

/** Fill a section up to `maxChars`, whole entries only — half a source file is
 * worse than one fewer file. Returns what fits plus a note about what did not. */
function fitSection<T extends { text: string }>(
  entries: T[],
  maxChars: number
): { kept: T[]; note: string | null } {
  const kept: T[] = [];
  let used = 0;
  for (const entry of entries) {
    if (used + entry.text.length > maxChars) {
      return { kept, note: `… (${entries.length - kept.length} more omitted for space)` };
    }
    kept.push(entry);
    used += entry.text.length;
  }
  return { kept, note: null };
}

/** Repository files the reviewed file imports, ranked, with their source.
 *
 * The reviewer cannot judge a call it has not read, and asking it to go read
 * one costs a tool call, a turn, and a whole-file fetch to reach a few lines —
 * which a small model skips entirely. Injecting the source makes the analysis
 * input guaranteed rather than hoped for. */
function importedSources(
  cwd: string,
  ref: string | null,
  file: string,
  related: RelatedFile[]
): { rendered: string[]; paths: string[] } {
  const imported = related
    .filter((item) => item.reasons.some((reason) => reason.startsWith("direct import")))
    .slice(0, IMPORT_SOURCE_MAX_FILES);

  const blocks: { path: string; text: string }[] = [];
  for (const item of imported) {
    const content = readFileAt(cwd, ref, item.path);
    if (!content?.trim()) continue;
    const body =
      content.length > IMPORT_SOURCE_MAX_CHARS
        ? `${content.slice(0, IMPORT_SOURCE_MAX_CHARS)}\n… (file truncated)`
        : content;
    // The "uses:" reason names the members the reviewed file actually calls —
    // keep it next to the source so the model reads for those first.
    const uses = item.reasons.find((reason) => reason.includes("uses:")) ?? "";
    blocks.push({
      path: item.path,
      text: [`--- ${item.path} ---`, ...(uses ? [`(${uses})`] : []), body].join("\n"),
    });
  }
  // `paths` must be what SURVIVED the budget, not what was eligible: a file the
  // budget dropped has to stay listed as a candidate, or the reviewer can
  // neither see it nor be told it exists.
  const { kept, note } = fitSection(blocks, IMPORT_SOURCE_SECTION_MAX_CHARS);
  return {
    rendered: [...kept.map((block) => block.text), ...(note ? [note] : [])],
    paths: kept.map((block) => block.path),
  };
}

/** Framework KB pages, trimmed to the section budget. */
function kbSection(docs: KbDoc[]): { rendered: string[]; kept: KbDoc[] } {
  const { kept, note } = fitSection(
    docs.map((doc) => ({
      ...doc,
      text: [`--- ${doc.path} (${doc.specifier}) ---`, doc.content].join("\n"),
    })),
    KB_SECTION_MAX_CHARS
  );
  return { rendered: [...kept.map((doc) => doc.text), ...(note ? [note] : [])], kept };
}

/** Compact dossier automatically injected for each current review file.
 *
 * Cross-file related code is surfaced as a ranked PATH LIST only (no source
 * preview): a first-lines preview usually shows a file's imports, not the
 * function the code under review actually calls. Instead the model is told to
 * grep those project files for the specific symbols it uses — a targeted
 * code_search lands the real definition, and it naturally scopes to whatever
 * segment/diff is being reviewed. */
export function buildReviewEvidence(cwd: string, ref: string | null, file: string): string {
  return reviewEvidence(cwd, ref, file).text;
}

/** What the evidence build actually opened. Sources and docs are the two
 * things a reviewer would otherwise have had to fetch by hand; the structured
 * lists let tests verify injection without parsing `text`. */
export interface ReviewEvidence {
  text: string;
  /** Repository files whose source was injected. */
  sources: string[];
  /** Framework KB pages injected, as `<path> (<import>)`. */
  docs: string[];
}

/**
 * Compact dossier automatically injected for each reviewed file: the ranked
 * related-file list, the SOURCE of the project files it imports, the framework
 * KB pages for imports that resolve to no repository file, whatever imports
 * remain unaccounted for, and recent history.
 *
 * Imports that match neither a repository file nor a configured KB prefix are
 * never fetched. That is what keeps `java.*`, `org.springframework.*`, and
 * third-party jars out — nothing claims them, so nothing reads them.
 */
export function reviewEvidence(
  cwd: string,
  ref: string | null,
  file: string
): ReviewEvidence {
  const related = discoverRelatedFiles(cwd, ref, file, 8);
  const { rendered: sourceBlocks, paths: sources } = importedSources(cwd, ref, file, related);

  // KB lookup runs over EVERY import, not only the unresolved ones: a framework
  // class can have both repository source and a KB page, and the page is what
  // states its correct usage — which is the whole point of the framework rules.
  const kbDocs = frameworkKbDocs(cwd, fileImports(cwd, ref, file));
  const documented = new Set(kbDocs.map((doc) => doc.specifier));

  // What is left is genuinely unaccounted for: not a repository file, not a KB
  // page, not a known third-party namespace. Listing anything else here is what
  // sent reviewers grepping for Spring annotations.
  const stillUnresolved = unresolvedImports(cwd, ref, file).filter(
    (specifier) => !documented.has(specifier) && !isExternalImport(specifier)
  );

  // Files whose source is inlined below are REMOVED from the candidate list
  // rather than annotated "do not re-read". A small model treats a listed path
  // as an invitation, and an instruction not to follow it is one more rule it
  // can drop; a path it never sees costs nothing to resist.
  const injected = new Set(sources);
  const remaining = related.filter((item) => !injected.has(item.path));

  const text = capText(
    [
      ...(remaining.length
        ? [
            // Phrased as an instruction, not an invitation. "fetch only if it
            // matters" reads to a small model as "skip this", and a reviewer
            // handed a concrete fcq list took that permission every time.
            "## Related code (NOT yet read — READ THESE)",
            renderRelatedList(cwd, ref, file, remaining, false),
            "",
            "Their source is NOT included above. Before you submit, open the ones a " +
              "finding could depend on with code_search(<symbol>) or file_read: a caller " +
              "whose contract you never checked is where the bugs static analysis " +
              "cannot see actually live.",
          ]
        : []),
      ...(sourceBlocks.length
        ? [
            "",
            "## Imported project code (already read for you)",
            "Source of the project files this file imports. Do NOT re-read these with " +
              "file_read or code_search — they are here in full (or truncated where noted). " +
              "Judge the calls into them against this source, not against assumptions.",
            "",
            ...sourceBlocks,
          ]
        : []),
      ...(kbDocs.length
        ? [
            "",
            "## Framework knowledge base (already read for you)",
            "Documentation for the framework imports below, resolved through the " +
              "`frameworkKb` map. These are AUTHORITATIVE for the `framework` category: " +
              "when they conflict with general language conventions, follow them. " +
              "Do not re-read them with file_read.",
            "",
            ...kbSection(kbDocs).rendered,
          ]
        : []),
      ...(stillUnresolved.length
        ? [
            "",
            "## Unresolved imports (not confirmed external)",
            ...stillUnresolved.map((s) => `- ${s}`),
            "Neither a repository file nor a configured framework KB page. They may be " +
              "third-party, generated, or a local alias. If their behavior matters, make one " +
              "targeted code_search(<symbol>) or file_find lookup, then move on rather than " +
              "retrying path variations.",
          ]
        : []),
      "",
      "## Git history",
      gitHistory(cwd, file, 5, false, ref),
    ].join("\n"),
    AUTO_EVIDENCE_MAX_CHARS
  );

  return {
    text,
    sources,
    docs: kbDocs.map((doc) => `${doc.path} (${doc.specifier})`),
  };
}
