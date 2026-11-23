import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { checkTestSource, testMethodBodies, testMethodNames } from "../test-check"

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

describe("기존 테스트 파일 보완 (previousMethods 있음)", () => {
  // 형식 규칙(@SpringBootTest 등)이 빠진 기존 파일: 옛 메서드 두 개는 단언도 없고 하나는 @Disabled
  const legacy = (extra: string): string => `class LegacyTest {
    @Disabled
    @Test void old1() { service.run(); }
    @Test void old2() { service.run(); }
${extra}
  }`
  const prev = ["old1", "old2"]
  const good = `    @Test void inquire_normal1() { assertEquals(1, service.inquire(1)); }`

  test("기존 파일 + 좋은 새 메서드는 결함 없음", () => {
    expect(checkTestSource(legacy(good), { mocks: [], previousMethods: prev })).toEqual([])
  })
  test("단언 없는 새 메서드만 결함", () => {
    const d = checkTestSource(legacy(`    @Test void inquire_normal2() { service.inquire(2); }`), { mocks: [], previousMethods: prev })
    expect(d).toHaveLength(1)
    expect(d[0]).toContain("inquire_normal2")
  })
  test("새 메서드의 @Disabled는 결함, 기존 메서드의 것은 아님", () => {
    const d = checkTestSource(legacy(`    @Disabled\n${good}`), { mocks: [], previousMethods: prev })
    expect(d).toHaveLength(1)
    expect(d[0]).toContain("inquire_normal1")
    expect(d[0]).toContain("@Disabled")
  })
  test("사라진 기존 메서드는 여전히 결함", () => {
    const d = checkTestSource(legacy(good).replace(/@Test void old2[^\n]*/, ""), { mocks: [], previousMethods: prev })
    expect(d.some((x) => x.includes("old2"))).toBe(true)
  })
  test("새 파일(previousMethods 없음)은 모든 점검 유지", () => {
    const d = checkTestSource(legacy(good), { mocks: [] })
    expect(d.some((x) => x.includes("@SpringBootTest"))).toBe(true)
    expect(d.some((x) => x.includes("old1"))).toBe(true)
    expect(d.some((x) => x.includes("@Disabled"))).toBe(true)
  })
})

describe("mock 이름 비교", () => {
  test("FQCN은 단순명으로, 정규식 문자는 리터럴로 비교한다", () => {
    expect(checkTestSource(healthy, { mocks: ["kr.co.koscom.pb.bsm.AccountBSM"] })).toEqual([])
    expect(() => checkTestSource(healthy, { mocks: ["AccountBSM.getAccount("] })).not.toThrow()
    expect(checkTestSource(healthy, { mocks: ["Account"] }).some((x) => x.includes("Account"))).toBe(true)
  })
})

describe("트랜잭션 안전 결함", () => {
  const withClassBody = (extra: string): string => healthy.replace("@Transactional", `@Transactional\n${extra}`)

  test.each([
    ["@Commit", "@Commit"],
    ["@Rollback(false)", "@Rollback(false)"],
    ["@Rollback(value = false)", "@Rollback(value = false)"],
    ["NOT_SUPPORTED", "@Transactional(propagation = Propagation.NOT_SUPPORTED)"],
    ["REQUIRES_NEW", "@Transactional(propagation = Propagation.REQUIRES_NEW)"],
    ["NEVER", "@Transactional(propagation = Propagation.NEVER)"],
    ["SUPPORTS", "@Transactional(propagation = Propagation.SUPPORTS)"],
  ])("%s 는 결함", (_label, construct) => {
    const d = checkTestSource(withClassBody(construct), { mocks })
    expect(d.some((x) => x.includes("롤백") || x.includes("트랜잭션"))).toBe(true)
  })

  test("확장 중인 기존 파일에도 적용된다", () => {
    const d = checkTestSource(withClassBody("@Commit"), { mocks, previousMethods: ["sonaq001_normal1"] })
    expect(d.some((x) => x.includes("@Commit"))).toBe(true)
  })

  test("평범한 @Transactional 클래스와 주석·문자열 속 언급은 통과", () => {
    expect(checkTestSource(healthy, { mocks })).toEqual([])
    expect(checkTestSource(withClassBody('// @Commit Propagation.NEVER\n/* @Rollback(false) */'), { mocks })).toEqual([])
  })

  test("Mapper 테스트(mock 없음)는 mock 점검을 받지 않는다", () => {
    const mapper = readFileSync(join(TPL_DIR, "MapperTestTemplate.java"), "utf8")
      .replaceAll("{PackagePath}", "x").replaceAll("{ClassName}", "AccountMapperTest").replaceAll("{TargetClass}", "AccountMapper")
    expect(checkTestSource(mapper, { mocks: [] })).toEqual([])
  })
})

describe("트랜잭션 매니저 지정·추가 결함 형태", () => {
  const withClassBody = (extra: string): string => healthy.replace("@Transactional", `@Transactional\n${extra}`)
  const mapperTpl = readFileSync(join(TPL_DIR, "MapperTestTemplate.java"), "utf8")
    .replaceAll("{PackagePath}", "x").replaceAll("{ClassName}", "AccountMapperTest").replaceAll("{TargetClass}", "AccountMapper")

  test.each(['@Transactional("secondaryTransactionManager")', '@Transactional(transactionManager = "extTransactionManager")'])(
    "%s 는 @Transactional로 인정",
    (form) => {
      expect(checkTestSource(healthy.replace("@Transactional", form), { mocks })).toEqual([])
      expect(checkTestSource(mapperTpl.replace("@Transactional", form), { mocks: [], requireTransactional: true, mapperUnderTest: "AccountMapper" })).toEqual([])
    },
  )

  test.each([
    ["FQCN @Commit", "@org.springframework.test.annotation.Commit"],
    ["@Rollback(Boolean.FALSE)", "@Rollback(Boolean.FALSE)"],
    ["@Rollback(value = Boolean.FALSE)", "@Rollback(value = Boolean.FALSE)"],
    ["FQCN @Rollback(false)", "@org.springframework.test.annotation.Rollback(false)"],
  ])("%s 는 결함", (_label, construct) => {
    expect(checkTestSource(withClassBody(construct), { mocks }).some((x) => x.includes("롤백"))).toBe(true)
  })

  test.each(["TestTransaction.flagForCommit();", "TestTransaction.end();"])("%s 는 결함", (call) => {
    const src = healthy.replace("@BeforeEach", `@BeforeEach void commitIt() { ${call} }\n    @BeforeEach`)
    expect(checkTestSource(src, { mocks }).some((x) => x.includes("TestTransaction"))).toBe(true)
  })

  test("static import 뒤의 맨 REQUIRES_NEW·NOT_SUPPORTED도 결함", () => {
    const src = withClassBody("@Transactional(propagation = REQUIRES_NEW)").replace(
      "import ",
      "import static org.springframework.transaction.annotation.Propagation.*;\nimport ",
    )
    const d = checkTestSource(src, { mocks })
    expect(d.some((x) => x.includes("Propagation.REQUIRES_NEW"))).toBe(true)
    // static import가 없으면 같은 이름의 다른 상수는 건드리지 않는다
    expect(checkTestSource(withClassBody("static final String NEVER = \"x\";"), { mocks })).toEqual([])
  })

  test("Mapper 테스트가 대상 Mapper 자신을 mock하면 결함", () => {
    for (const field of ["@MockitoBean AccountMapper mapper;", "@MockBean\n    private AccountMapper mapper;", "@MockitoSpyBean AccountMapper mapper;"]) {
      const src = mapperTpl.replace(/@Autowired\s+private AccountMapper mapper;/, field)
      expect(checkTestSource(src, { mocks: [], requireTransactional: true, mapperUnderTest: "AccountMapper" }).some((x) => x.includes("실제"))).toBe(true)
    }
    expect(checkTestSource(mapperTpl, { mocks: [], requireTransactional: true, mapperUnderTest: "AccountMapper" })).toEqual([])
  })

  test("Mapper 테스트는 기존 파일 보완 중에도 @Transactional·@ActiveProfiles가 필수", () => {
    const opts = { mocks: [], previousMethods: ["selectByAccountNo_normal1"], requireTransactional: true, mapperUnderTest: "AccountMapper" }
    const noProfile = mapperTpl.replace(/@ActiveProfiles\([^)]*\)[^\n]*\n/, "")
    const noTx = mapperTpl.replace(/@Transactional[^\n]*\n/, "")
    expect(checkTestSource(noProfile, opts).some((x) => x.includes("@ActiveProfiles"))).toBe(true)
    expect(checkTestSource(noTx, opts).some((x) => x.includes("@Transactional"))).toBe(true)
    // 보완 중인 일반 파일은 클래스 애노테이션을 여전히 점검하지 않는다
    expect(checkTestSource(noTx, { mocks: [], previousMethods: ["selectByAccountNo_normal1"] }).some((x) => x.includes("@Transactional"))).toBe(false)
    // 새 Mapper 테스트 파일에서 @Transactional 누락은 한 번만 보고
    expect(checkTestSource(noTx, { mocks: [], requireTransactional: true }).filter((x) => x.includes("@Transactional 애노테이션"))).toHaveLength(1)
  })
})

describe("기존 테스트 본문 변경 (update_existing)", () => {
  const before = `class FeeTest {
    @Test void fee_normal1() { assertEquals(3000, service.fee(10)); }
    @Disabled
    @Test void fee_old() { assertEquals(1, service.fee(0)); }
  }`
  const opts = (allowed: string[] = []) => ({ mocks: [], previousMethods: ["fee_normal1", "fee_old"], previousBodies: testMethodBodies(before), allowedUpdates: allowed })
  const changed = before.replace("3000", "2500")

  test("그대로 두고 새 메서드·필드만 추가하면 결함 없음", () => {
    const added = before.replace(/\n  }$/, "\n    @MockitoBean FeeBSM bsm;\n    @Test void fee_normal2() { assertEquals(2, service.fee(2)); }\n  }")
    expect(checkTestSource(added, opts())).toEqual([])
  })
  test("승인 목록에 없는 기존 테스트의 기대값을 바꾸면 결함", () => {
    const d = checkTestSource(changed, opts())
    expect(d).toHaveLength(1)
    expect(d[0]).toContain("fee_normal1")
    expect(d[0]).toContain("update_existing")
  })
  test("문자열 기대값(오류 코드)만 바꿔도 결함으로 잡고, 문자열 안 중괄호가 있어도 본문 경계가 깨지지 않는다", () => {
    const base = `class T {
      @Test void ex() { assertEquals("4701", code(0)); }
      @Test void braces() { assertEquals("{x}", fmt(1)); }
    }`
    const o = { mocks: [], previousMethods: ["ex", "braces"], previousBodies: testMethodBodies(base), allowedUpdates: [] as string[] }
    expect(checkTestSource(base, o)).toEqual([])
    const d = checkTestSource(base.replace("4701", "4705"), o)
    expect(d).toHaveLength(1)
    expect(d[0]).toContain("ex의 본문이 바뀌었습니다")
    expect(checkTestSource(base.replace("{x}", "{y}"), o)[0]).toContain("braces")
  })
  test("승인 목록에 있으면 기대값 변경은 허용", () => {
    expect(checkTestSource(changed, opts(["fee_normal1"]))).toEqual([])
  })
  test("승인받았어도 기존 테스트에 @Disabled를 붙이면 결함", () => {
    const d = checkTestSource(changed.replace("@Test void fee_normal1", "@Disabled @Test void fee_normal1"), opts(["fee_normal1"]))
    expect(d.some((x) => x.includes("fee_normal1") && x.includes("@Disabled"))).toBe(true)
  })
  test("원래 @Disabled였던 기존 테스트는 결함 아님", () => {
    expect(testMethodBodies(before).fee_old!.startsWith("@Disabled ")).toBe(true)
    expect(checkTestSource(before, opts())).toEqual([])
  })
})
