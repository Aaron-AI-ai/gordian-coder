/**
 * Framework KB lookup: prefix specificity, package→path mapping, the name
 * fallback, and the skip rules that keep third-party imports out.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearKbCache, frameworkKbDocs, resolveKbDoc, KB_DOC_MAX_CHARS } from "../framework-kb";

const tmps: string[] = [];
afterEach(() => {
  clearKbCache();
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const KB = {
  "kr.co.openlabs.fico.framework.extension.*": ".fico/kb/fico-fwk-extension/",
  "kr.co.openlabs.fico.framework.*": ".fico/kb/fico-fwk-core/",
  "kr.co.koscom.pb.framework.site.ext.*": ".fico/kb/framework-site-ext/",
  "kr.co.openlabs.fico.common.*": ".fico/kb/fico-common-model/", // directory never created
};

function project(files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "f-kb-"));
  tmps.push(d);
  writeFileSync(join(d, ".f-review.json"), JSON.stringify({ frameworkKb: KB }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(d, dirname(path)), { recursive: true });
    writeFileSync(join(d, path), content);
  }
  return d;
}

describe("resolveKbDoc", () => {
  it("maps the package tail onto the KB directory layout", () => {
    const d = project({
      ".fico/kb/framework-site-ext/utils/PBCommonUtils.md": "# PBCommonUtils",
    });
    expect(resolveKbDoc(d, "kr.co.koscom.pb.framework.site.ext.utils.PBCommonUtils")).toBe(
      join(d, ".fico/kb/framework-site-ext/utils/PBCommonUtils.md")
    );
  });

  it("gives the longest matching prefix the import", () => {
    // The two framework prefixes overlap; an extension import must never be
    // judged by the core KB, so specificity — not config order — has to decide.
    const d = project({
      ".fico/kb/fico-fwk-extension/crypto/CryptoService.md": "# extension",
      ".fico/kb/fico-fwk-core/crypto/CryptoService.md": "# core",
      ".fico/kb/fico-fwk-core/utils/DateUtils.md": "# core utils",
    });
    expect(
      resolveKbDoc(d, "kr.co.openlabs.fico.framework.extension.crypto.CryptoService")
    ).toContain("fico-fwk-extension/crypto/CryptoService.md");
    expect(resolveKbDoc(d, "kr.co.openlabs.fico.framework.utils.DateUtils")).toContain(
      "fico-fwk-core/utils/DateUtils.md"
    );
  });

  it("falls back to the class name when the KB folders drift from the packages", () => {
    const d = project({ ".fico/kb/fico-fwk-core/misc/deep/DateUtils.md": "# moved" });
    expect(resolveKbDoc(d, "kr.co.openlabs.fico.framework.utils.DateUtils")).toContain(
      "misc/deep/DateUtils.md"
    );
  });

  it("skips a configured directory that does not exist", () => {
    const d = project();
    expect(resolveKbDoc(d, "kr.co.openlabs.fico.common.model.Money")).toBeNull();
  });

  it("skips a matching prefix whose page is missing", () => {
    const d = project({ ".fico/kb/fico-fwk-core/utils/DateUtils.md": "# core" });
    expect(resolveKbDoc(d, "kr.co.openlabs.fico.framework.utils.Undocumented")).toBeNull();
  });

  it("never claims third-party or JDK imports", () => {
    const d = project({ ".fico/kb/fico-fwk-core/utils/DateUtils.md": "# core" });
    for (const specifier of [
      "java.util.List",
      "javax.annotation.Resource",
      "org.springframework.stereotype.Service",
      "lombok.extern.slf4j.Slf4j",
      "com.fasterxml.jackson.databind.ObjectMapper",
    ]) {
      expect(resolveKbDoc(d, specifier)).toBeNull();
    }
  });

  it("returns nothing when the project configures no KB", () => {
    const d = mkdtempSync(join(tmpdir(), "f-kb-"));
    tmps.push(d);
    expect(resolveKbDoc(d, "kr.co.openlabs.fico.framework.utils.DateUtils")).toBeNull();
  });
});

describe("frameworkKbDocs", () => {
  it("returns matched pages in import order and skips the rest", () => {
    const d = project({
      ".fico/kb/fico-fwk-core/utils/DateUtils.md": "# DateUtils\nUse UTC.",
      ".fico/kb/framework-site-ext/utils/PBCommonUtils.md": "# PBCommonUtils\nNull-safe.",
    });
    const docs = frameworkKbDocs(d, [
      "java.util.List",
      "kr.co.koscom.pb.framework.site.ext.utils.PBCommonUtils",
      "kr.co.openlabs.fico.framework.utils.DateUtils",
      "kr.co.openlabs.fico.framework.utils.Undocumented",
    ]);
    expect(docs.map((doc) => doc.specifier)).toEqual([
      "kr.co.koscom.pb.framework.site.ext.utils.PBCommonUtils",
      "kr.co.openlabs.fico.framework.utils.DateUtils",
    ]);
    expect(docs[0].path).toBe(".fico/kb/framework-site-ext/utils/PBCommonUtils.md");
    expect(docs[1].content).toContain("Use UTC.");
  });

  it("truncates an oversized page instead of dropping it", () => {
    const d = project({
      ".fico/kb/fico-fwk-core/utils/DateUtils.md": "x".repeat(KB_DOC_MAX_CHARS + 5_000),
    });
    const [doc] = frameworkKbDocs(d, ["kr.co.openlabs.fico.framework.utils.DateUtils"]);
    expect(doc.content).toContain("(doc truncated)");
    expect(doc.content.length).toBeLessThan(KB_DOC_MAX_CHARS + 100);
  });

  it("ignores an empty page", () => {
    const d = project({ ".fico/kb/fico-fwk-core/utils/DateUtils.md": "   \n" });
    expect(frameworkKbDocs(d, ["kr.co.openlabs.fico.framework.utils.DateUtils"])).toEqual([]);
  });
});
