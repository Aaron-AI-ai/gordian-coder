/**
 * Framework KB lookup: prefix specificity, package→path mapping, the name
 * fallback, and the skip rules that keep third-party imports out.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearKbCache, frameworkKbDocs, kbClues, kbDocsForCode, kbPrefetch, kbSearch, resolveKbDoc, KB_DOC_MAX_CHARS } from "../framework-kb";

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

function project(files: Record<string, string> = {}, config: Record<string, unknown> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "f-kb-"));
  tmps.push(d);
  writeFileSync(join(d, ".f-review.json"), JSON.stringify({ frameworkKb: KB, ...config }));
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

const ext = (title: string, description: string, tags: string[], body: string) =>
  `---\ntitle: ${title}\ndescription: ${description}\ntags:\n${tags.map((t) => `- ${t}`).join("\n")}\n---\n\n${body}`;

// Both rankers must honor the same contract; only their ordering differs.
for (const kbSearchMode of ["keyword", "bm25"] as const)
describe(`kbSearch (${kbSearchMode})`, () => {
  const projectFor = (files: Record<string, string>) => project(files, { kbSearch: kbSearchMode });

  it("finds a house replacement by the generic facility's name", () => {
    const d = projectFor({
      ".fico/kb/framework-site-ext/annotation/ExtTransactional.md": ext(
        "ExtTransactional",
        "ext 데이터베이스용 트랜잭션 어노테이션",
        ["transaction", "spring"],
        "일반적인 트랜잭션 설정 대신 ExtTransactional을 적용합니다."
      ),
      ".fico/kb/fico-fwk-core/utils/DateUtils.md": ext("DateUtils", "날짜 유틸", ["date"], "yyyyMMdd"),
    });
    const out = kbSearch(d, "Transactional extTransactionManager");
    expect(out).toContain(".fico/kb/framework-site-ext/annotation/ExtTransactional.md");
    expect(out).toContain("일반적인 트랜잭션 설정 대신");
    expect(out).not.toContain("DateUtils.md");
  });

  it("matches camelCase words and Korean description terms", () => {
    const d = projectFor({
      ".fico/kb/fico-fwk-core/internal/RetryableRestTemplate.md": ext(
        "RetryableRestTemplate",
        "재시도 정책을 가진 RestTemplate",
        ["rest"],
        "본문"
      ),
    });
    expect(kbSearch(d, "rest template")).toContain("RetryableRestTemplate.md");
    expect(kbSearch(d, "재시도")).toContain("RetryableRestTemplate.md");
  });

  it("says so when nothing matches or no KB is configured", () => {
    const d = projectFor({ ".fico/kb/fico-fwk-core/utils/DateUtils.md": ext("DateUtils", "날짜", [], "x") });
    expect(kbSearch(d, "zzzunknown")).toContain("No KB documents match");
    const bare = mkdtempSync(join(tmpdir(), "f-kb-bare-"));
    tmps.push(bare);
    expect(kbSearch(bare, "anything")).toContain("No framework KB is configured");
  });

  it("returns full text for the top hits only and caps each page", () => {
    // Foo1 is the strongest hit and Foo3 the weakest (body mention only) under
    // both rankers, so the full-text cut-off falls between Foo2 and Foo3.
    const d = projectFor({
      ".fico/kb/fico-fwk-core/a/Foo1.md": ext("Foo1", "foo", ["foo"], "foo ".repeat(KB_DOC_MAX_CHARS)),
      ".fico/kb/fico-fwk-core/a/Foo2.md": ext("Foo2", "foo", [], "b"),
      ".fico/kb/fico-fwk-core/a/Foo3.md": ext("Foo3", "bar", [], "foo c-body-unique"),
    });
    const out = kbSearch(d, "foo");
    expect(out).toContain("(doc truncated)");
    expect(out).toContain("Foo3.md"); // listed
    expect(out).not.toContain("c-body-unique"); // beyond the full-text hits
  });
});

describe("kbSearch ranking: bm25 vs keyword", () => {
  const firstHit = (out: string) => /^==== (\S+)/m.exec(out)?.[1] ?? "";
  // A page whose NAME merely contains a query word (format ⊂ formatter) vs the
  // page that is ABOUT the identifiers asked for.
  const formatterVsDate = {
    ".fico/kb/fico-fwk-core/utils/FormatterUtils.md": ext(
      "FormatterUtils",
      "고정 길이 전문 변환 유틸",
      ["fixed"],
      "FixedFormatter formatter 설정. formatter 체인으로 VO를 고정 길이 문자열로 바꾼다. formatter formatter"
    ),
    ".fico/kb/fico-fwk-core/utils/DateUtils.md": ext(
      "DateUtils",
      "날짜 형식 변환 유틸",
      ["date"],
      "SimpleDateFormat이나 DateTimeFormatter를 직접 만들지 말고 DateUtils.format을 쓴다."
    ),
    ".fico/kb/fico-fwk-core/utils/StringUtils.md": ext("StringUtils", "문자열 유틸", ["string"], "trim, pad"),
  };
  const query = "SimpleDateFormat date format DateTimeFormatter";

  it("keyword lets a substring of the page name win", () => {
    const out = kbSearch(project(formatterVsDate, { kbSearch: "keyword" }), query);
    expect(firstHit(out)).toEndWith("FormatterUtils.md");
  });

  it("bm25 matches whole tokens, so the page about the identifiers wins", () => {
    const out = kbSearch(project(formatterVsDate, { kbSearch: "bm25" }), query);
    expect(firstHit(out)).toEndWith("DateUtils.md");
  });

  it("bm25 lets a rare term outweigh one every page mentions", () => {
    const files: Record<string, string> = {
      ".fico/kb/fico-fwk-core/kafka/KafkaConsumerService.md": ext("KafkaConsumerService", "kafka 수신", ["kafka"], "x"),
    };
    for (let i = 1; i <= 4; i++) {
      files[`.fico/kb/fico-fwk-core/svc/Svc${i}.md`] = ext(`Svc${i}`, "서비스", [], "Autowired Autowired Autowired 주입");
    }
    const out = kbSearch(project(files, { kbSearch: "bm25" }), "Autowired KafkaConsumer");
    expect(firstHit(out)).toEndWith("KafkaConsumerService.md");
  });

  it("bm25 meets a Korean word that carries a particle in the page", () => {
    const d = project(
      { ".fico/kb/framework-site-ext/annotation/ExtTransactional.md": ext("ExtTransactional", "트랜잭션을 자동 적용", [], "x") },
      { kbSearch: "bm25" }
    );
    expect(kbSearch(d, "트랜잭션")).toContain("ExtTransactional.md");
  });

  it("bm25 splits an acronym prefix off a class name (PBTransactionAspect → pb, transaction, aspect)", () => {
    const d = project(
      {
        ".fico/kb/framework-site-ext/aspect/PBTransactionAspect.md": ext("PBTransactionAspect", "트랜잭션 에스펙트", [], "x"),
        ".fico/kb/fico-fwk-core/kafka/KafkaConsumerService.md": ext("KafkaConsumerService", "kafka 수신", [], "x"),
        ".fico/kb/fico-fwk-core/utils/DateUtils.md": ext("DateUtils", "날짜", [], "x"),
      },
      { kbSearch: "bm25" }
    );
    expect(firstHit(kbSearch(d, "transaction write"))).toEndWith("PBTransactionAspect.md");
    expect(firstHit(kbSearch(d, "IKafkaConsumerService"))).toEndWith("KafkaConsumerService.md");
  });

  // Both shapes lost under bm25 in the live A/B run (case-95, case-93): the page
  // NAMED for a query word must not be outvoted by long pages that merely use
  // several common query words, however often.
  it("bm25 ranks the page named for a query word above long pages matching common words", () => {
    const filler = "type type write write read read only only service service ".repeat(30);
    const d = project(
      {
        ".fico/kb/framework-site-ext/aspect/PBTransactionAspect.md": ext(
          "PBTransactionAspect",
          "서비스 유형별 트랜잭션 처리",
          ["aspect"],
          "svcId 5번째 글자가 Q면 transaction을 rollback한다."
        ),
        ".fico/kb/fico-fwk-core/converter/FixedDataConverter.md": ext("FixedDataConverter", "변환", [], filler),
        ".fico/kb/fico-fwk-core/converter/FixedDataModelConverter.md": ext("FixedDataModelConverter", "변환", [], filler),
        ".fico/kb/fico-fwk-core/utils/DateUtils.md": ext("DateUtils", "날짜", [], "date"),
      },
      { kbSearch: "bm25" }
    );
    expect(firstHit(kbSearch(d, "Q-type service transaction write read-only"))).toEndWith("PBTransactionAspect.md");
  });

  it("bm25 keeps a sibling class that shares the query's name parts in the full-text hits", () => {
    // unrelated pages, so word rarity means what it does in a real KB
    const unrelated: Record<string, string> = {};
    for (let i = 1; i <= 8; i++) unrelated[`.fico/kb/fico-fwk-core/misc/Misc${i}.md`] = ext(`Misc${i}`, "기타", [], "misc page");
    const d = project(
      {
        ...unrelated,
        ".fico/kb/fico-fwk-extension/daemon/idempotency/IdempotencyService.md": ext(
          "IdempotencyService",
          "멱등 처리 서비스",
          ["idempotency"],
          "checkAndStart로 처리 여부를 확인하고 complete로 끝낸다. IdempotencyCheckResult를 반환한다."
        ),
        ".fico/kb/fico-fwk-extension/daemon/idempotency/IdempotencyCheckResult.md": ext(
          "IdempotencyCheckResult",
          "checkAndStart 결과",
          ["idempotency"],
          "canProcess가 false면 처리하지 않는다."
        ),
        ".fico/kb/fico-fwk-extension/daemon/DaemonQueueListener.md": ext(
          "DaemonQueueListener",
          "큐 리스너",
          [],
          "IdempotencyService checkAndStart complete complete complete start start service service ".repeat(10)
        ),
      },
      { kbSearch: "bm25" }
    );
    const out = kbSearch(d, "IdempotencyService checkAndStart complete");
    const hits = [...out.matchAll(/^==== (\S+)/gm)].map((m) => m[1]);
    expect(hits.slice(0, 2).some((p) => p.endsWith("IdempotencyCheckResult.md"))).toBe(true);
  });

  it("an unknown mode falls back to keyword", () => {
    const out = kbSearch(project(formatterVsDate, { kbSearch: "vector" }), query);
    expect(firstHit(out)).toEndWith("FormatterUtils.md");
  });

  it("sees a page edited after an earlier search", () => {
    const d = project({ ".fico/kb/fico-fwk-core/utils/DateUtils.md": ext("DateUtils", "날짜", [], "old") });
    expect(kbSearch(d, "zebra")).toContain("No KB documents match");
    const path = join(d, ".fico/kb/fico-fwk-core/utils/DateUtils.md");
    writeFileSync(path, ext("DateUtils", "날짜", [], "zebra"));
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    expect(kbSearch(d, "zebra")).toContain("DateUtils.md");
  });
});

describe("kbClues / kbPrefetch", () => {
  const page = (title: string, description: string, body: string) =>
    `---\ntitle: ${title}\ndescription: ${description}\ntags:\n- x\n---\n\n${body}`;

  it("reads framework imports, annotations, constructed types and code-like literals off the source", () => {
    const clues = kbClues([
      "import kr.co.openlabs.fico.framework.model.CommonRequest;",
      "import org.springframework.stereotype.Service;",
      '@PostMapping("/acnt") @Transactional("extTransactionManager")',
      'throw CommonException.create("FWKE0001", "계좌번호"); new RestTemplate();',
    ].join("\n"));
    expect(clues).toEqual(expect.arrayContaining(["CommonRequest", "PostMapping", "Transactional", "extTransactionManager", "FWKE0001", "RestTemplate"]));
    expect(clues).not.toContain("Service");
    expect(clues).not.toContain("계좌번호");
  });

  it("finds the page for a literal error code and the house class behind a generic one", () => {
    const d = project({
      ".fico/kb/fico-fwk-extension/constant/MessageCode.md": page("MessageCode", "표준 코드", "FWKE0001 = 필수 입력"),
      ".fico/kb/framework-site-ext/annotation/ExtTransactional.md": page("ExtTransactional", "ext 트랜잭션", "Transactional 대신 사용"),
      ".fico/kb/fico-fwk-core/utils/DateUtils.md": page("DateUtils", "날짜", "x"),
    });
    const docs = kbPrefetch(d, 'throw CommonException.create("FWKE0001", "x");\n@Transactional("extTransactionManager")', new Set());
    const paths = docs.map((x) => x.path);
    expect(paths.some((p) => p.endsWith("MessageCode.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("ExtTransactional.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("DateUtils.md"))).toBe(false);
  });

  it("skips pages already injected by import and returns nothing for plain code", () => {
    const d = project({ ".fico/kb/fico-fwk-extension/constant/MessageCode.md": page("MessageCode", "표준 코드", "FWKE0001") });
    const have = new Set([".fico/kb/fico-fwk-extension/constant/MessageCode.md"]);
    expect(kbPrefetch(d, 'x("FWKE0001")', have)).toEqual([]);
    expect(kbPrefetch(d, "class A { int x = 1; }", new Set())).toEqual([]);
  });

  it("caps the extra pages", () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 6; i++) files[`.fico/kb/fico-fwk-core/a/Widget${i}.md`] = page(`Widget${i}`, "w", "x");
    const d = project(files);
    const src = Array.from({ length: 6 }, (_, i) => `new Widget${i + 1}();`).join("\n");
    expect(kbPrefetch(d, src, new Set()).length).toBeLessThanOrEqual(3);
  });
});

describe("kbDocsForCode", () => {
  it("returns pages named exactly after classes/annotations the code uses, in order of first use", () => {
    const d = project({
      ".fico/kb/framework-site-ext/exception/PBOnlineException.md": "# PBOnlineException\ncreate(code, args...)",
      ".fico/kb/fico-fwk-core/annotations/FixedData.md": "# FixedData\nlength in bytes",
      ".fico/kb/fico-fwk-core/converter/FixedDataConverter.md": "# FixedDataConverter",
    });
    const code = '@FixedData(length = 20)\nprivate String a;\nif (x == null) throw PBOnlineException.create("1002");\nString s = new String();';
    expect(kbDocsForCode(d, code).map((x) => x.path.split("/").at(-1))).toEqual(["FixedData.md", "PBOnlineException.md"]);
    expect(kbDocsForCode(d, "int a = 1;")).toEqual([]);
  });
});
