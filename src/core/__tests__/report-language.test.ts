import { describe, expect, test } from "bun:test"
import { foreignScriptProblem, languageName, scriptLine } from "../report-language"
import * as review from "../review/contract"

describe("report-language (shared by f-review, f-log, f-unit-test-code)", () => {
  test("foreignScriptProblem names the foreign words and skips backtick code", () => {
    expect(foreignScriptProblem("정상적인 한국어 문장", "ko", "the summary")).toBeNull()
    expect(foreignScriptProblem("로그 `조회 失败` 인용", "ko", "the summary")).toBeNull()
    const p = foreignScriptProblem("메서드入口处 확인", "ko", "the plan note")!
    expect(p).toContain("Non-Korean script in the plan note")
    expect(p).toContain("入口处")
  })
  test("an unlisted language is not checked", () => {
    expect(foreignScriptProblem("anything همین goes", "fr", "x")).toBeNull()
  })
  test("scriptLine is empty for ja/zh and names the language otherwise", () => {
    expect(scriptLine("ja")).toBe("")
    expect(scriptLine("ko")).toContain("Korean")
    expect(languageName("en")).toBe("English")
  })
  test("f-review still exports the same functions (re-export, no copy)", () => {
    expect(review.strayScript("값을 검증しています", "ko")).toEqual(["しています"])
  })
})
