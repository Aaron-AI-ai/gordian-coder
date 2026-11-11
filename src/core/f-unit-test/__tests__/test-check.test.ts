import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { checkTestSource, testMethodNames } from "../test-check"

const TPL_DIR = join(import.meta.dir, "../../../../assets/fico-ai/skills/f-unit-test-code/templates")
const fill = (s: string): string =>
  s
    .replaceAll("{PackagePath}", "kr.co.koscom.pb.on.stk.ord.online.qry.service")
    .replaceAll("{ClassName}", "SONAQ001ServiceTest")
    .replaceAll("{TargetClass}", "SONAQ001Service")
const service = readFileSync(join(TPL_DIR, "ServiceTestTemplate.java"), "utf8")
const controller = readFileSync(join(TPL_DIR, "ControllerTestTemplate.java"), "utf8")
const healthy = fill(service)
const mocks = ["AccountBSM"]

describe("testMethodNames", () => {
  test("한 줄/여러 줄 @Test, 다른 애노테이션 사이에 낀 경우", () => {
    const src = `class T {
      @Test void a() {}
      @Test
      public void b() {}
      @ParameterizedTest(name = "x")
      @ValueSource(strings = {"p"})
      void c(String s) {}
      @RepeatedTest(3) void d() {}
    }`
    expect(testMethodNames(src)).toEqual(["a", "b", "c", "d"])
  })
  test("주석·문자열 안의 @Test는 무시", () => {
    const src = `// @Test void line()
/* @Test void block() */
class T { String s = "@Test void str()"; @Test void real() {} }`
    expect(testMethodNames(src)).toEqual(["real"])
  })
})

describe("checkTestSource", () => {
  test("채워진 서비스·컨트롤러 템플릿은 정상", () => {
    expect(checkTestSource(healthy, { mocks })).toEqual([])
    expect(checkTestSource(fill(controller), { mocks, previousMethods: ["sonaq001_normal1"] })).toEqual([])
  })
  test("mocks가 비면 mock 점검을 건너뛴다", () => {
    const src = healthy.replaceAll("@MockitoBean", "").replaceAll("AccountBSM", "Other")
    expect(checkTestSource(src, { mocks: [] })).toEqual([])
  })
  test("채우지 않은 템플릿은 플레이스홀더로 지적", () => {
    const r = checkTestSource(service, { mocks })
    expect(r).toHaveLength(1)
    expect(r[0]).toContain("{ClassName}")
  })
  test("플레이스홀더 규칙은 ${var}, JSON 문자열, 제네릭을 오탐하지 않는다", () => {
    const src = healthy.replace(
      "    // 정상 1",
      `    String j = "{\\"a\\":1}"; String k = "\${Var}"; java.util.Map<String, java.util.List<String>> m;\n    // 정상 1`,
    )
    expect(checkTestSource(src, { mocks })).toEqual([])
  })
  test("@AfterEach 제거", () => {
    const r = checkTestSource(healthy.replace("@AfterEach", ""), { mocks })
    expect(r).toHaveLength(1)
    expect(r[0]).toContain("@AfterEach")
  })
  test("단언 없는 @Test", () => {
    const src = healthy.replace(/}\s*$/, "    @Test\n    void lonely() {\n        target.x();\n    }\n}\n")
    const r = checkTestSource(src, { mocks })
    expect(r).toHaveLength(1)
    expect(r[0]).toContain("lonely")
  })
  test("assertNotNull / assertTrue(true)만 있는 @Test", () => {
    const src = healthy.replace(
      /}\s*$/,
      "    @Test\n    void weak() {\n        assertNotNull(target);\n        assertTrue(true);\n    }\n}\n",
    )
    const r = checkTestSource(src, { mocks })
    expect(r).toHaveLength(1)
    expect(r[0]).toContain("weak")
  })
  test("주석 속 assert는 단언으로 세지 않는다", () => {
    const src = healthy.replace(/}\s*$/, "    @Test\n    void c() {\n        // assertEquals(1, 1);\n    }\n}\n")
    expect(checkTestSource(src, { mocks }).join()).toContain("c")
  })
  test("@Disabled", () => {
    const r = checkTestSource(healthy.replace("    @Test\n    void sonaq001_exception", "    @Disabled\n    @Test\n    void sonaq001_exception"), { mocks })
    expect(r).toHaveLength(1)
    expect(r[0]).toContain("@Disabled")
  })
  test("@Test는 주석 안에만 있어도 본문 경계를 흐리지 않는다", () => {
    const src = healthy.replace("    // 정상 1: 기본 경로", "    // @Test void ghost()\n    // 정상 1: 기본 경로")
    expect(checkTestSource(src, { mocks })).toEqual([])
  })
  test("mock 대상 클래스명이 없음", () => {
    const r = checkTestSource(healthy, { mocks: ["AccountBSM", "AccountMapper"] })
    expect(r).toHaveLength(1)
    expect(r[0]).toContain("AccountMapper")
  })
  test("@MockitoBean/@MockBean이 하나도 없음", () => {
    const r = checkTestSource(healthy.replace("    @MockitoBean\n", ""), { mocks })
    expect(r).toHaveLength(1)
    expect(r[0]).toContain("@MockitoBean")
  })
  test("@MockBean도 인정", () => {
    expect(checkTestSource(healthy.replace("    @MockitoBean\n", "    @MockBean\n"), { mocks })).toEqual([])
  })
  test("이전에 있던 메서드가 사라짐", () => {
    const r = checkTestSource(healthy, { mocks, previousMethods: ["old_case", "sonaq001_normal1"] })
    expect(r).toHaveLength(1)
    expect(r[0]).toContain("old_case")
  })
})
