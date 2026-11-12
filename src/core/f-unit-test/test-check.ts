// 생성된 Java 테스트 소스의 정적 점검. 결함 메시지가 비어 있으면 통과.
// ponytail: 정규식 기반이라 중첩 클래스·텍스트 블록(""")·테스트 뒤의 private 헬퍼 안 단언 같은 드문 형태는 놓칠 수 있다.
// 오탐보다 미탐을 택한다. 정확해야 하면 Java 파서로 교체.

export interface TestCheckOptions {
  /** mock 대상 클래스(단순명 또는 FQCN, 단순명으로 비교). 비어 있으면 mock 점검(규칙 4)을 건너뛴다. */
  mocks: string[]
  /**
   * 계획 시점에 이미 있던 @Test 메서드 이름. 비어 있지 않으면 기존 파일을 보완하는 것이므로
   * 클래스 애노테이션·파일 전체 @Disabled 점검을 건너뛰고, 단언·@Disabled 점검은 새 메서드에만 한다.
   */
  previousMethods?: string[]
}

// 주석은 제거, 문자열·문자 리터럴은 내용만 비운다 (그 안의 @Test, {Name}, assert 오탐 방지)
export function strip(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])'/g,
    (m) => (m.startsWith("/") ? " " : m[0] + m[0]),
  )
}

const TEST_ANNOTATION = /@(?:Test|ParameterizedTest|RepeatedTest)\b(?:\s*\([^)]*\))?((?:\s*@\w+(?:\([^)]*\))?)*)(?:\s+(?:public|protected|private|static|final))*\s+[\w<>\[\],?]+\s+(\w+)\s*\(/g
const BOUNDARY = /@(?:Test|ParameterizedTest|RepeatedTest|BeforeEach|AfterEach)\b/g

interface TestMethod { name: string; body: string; start: number; headerEnd: number }

function testMethods(code: string): TestMethod[] {
  const bounds = [...code.matchAll(BOUNDARY)].map((m) => m.index!)
  return [...code.matchAll(TEST_ANNOTATION)].map((m) => {
    const end = bounds.find((b) => b > m.index!) ?? code.length
    return { name: m[2]!, body: code.slice(m.index!, end), start: m.index!, headerEnd: m.index! + m[0].length }
  })
}

/** @Disabled가 붙은 테스트 메서드 이름: 메서드 머리(애노테이션~이름) 안이거나 바로 다음 메서드. */
function disabledMethods(code: string, methods: TestMethod[]): Set<string> {
  const names = new Set<string>()
  for (const d of code.matchAll(/@Disabled\b/g)) {
    const at = d.index!
    const m = methods.find((x) => x.start <= at && at < x.headerEnd) ?? methods.find((x) => x.start > at)
    if (m) names.add(m.name)
  }
  return names
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** 식별자 경계로 둘러싼 리터럴 일치 (`$`도 식별자 문자로 본다). */
const mentions = (code: string, name: string): boolean => new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(code)

export function testMethodNames(source: string): string[] {
  return testMethods(strip(source)).map((m) => m.name)
}

function assertionState(body: string): "none" | "weak" | "ok" {
  const calls = [...body.matchAll(/\b(assert\w*|fail|verify\w*)\s*\(\s*([^)]*)/g)]
  if (calls.length === 0) return "none"
  const weak = calls.every((c) => c[1] === "assertNotNull" || (c[1] === "assertTrue" && c[2]!.trim() === "true"))
  return weak ? "weak" : "ok"
}

export function checkTestSource(source: string, opts: TestCheckOptions): string[] {
  const code = strip(source)
  const defects: string[] = []

  const previous = new Set(opts.previousMethods ?? [])
  // 기존 파일의 형식 누락은 계획 단계에서 보고만 하고 고치지 않는다 (기존 테스트는 바꾸지 않는다).
  const extending = previous.size > 0
  if (!extending) {
    for (const a of ["@SpringBootTest", "@Transactional", "@BeforeEach", "@AfterEach"]) {
      if (!new RegExp(`${a}\\b`).test(code)) defects.push(`${a} 애노테이션이 없습니다. 템플릿대로 추가하세요.`)
    }
  }

  const methods = testMethods(code)
  for (const m of methods) {
    if (previous.has(m.name)) continue
    const s = assertionState(m.body)
    if (s === "none") defects.push(`@Test 메서드 ${m.name}에 단언(assert*/verify/fail)이 없습니다. 결과를 검증하는 단언을 추가하세요.`)
    if (s === "weak") defects.push(`@Test 메서드 ${m.name}의 단언이 assertNotNull/assertTrue(true) 뿐입니다. 실제 값을 비교하는 단언으로 바꾸세요.`)
  }

  if (!extending) {
    if (/@Disabled\b/.test(code)) defects.push("@Disabled 테스트가 있습니다. 비활성화하지 말고 통과하도록 고치거나 삭제하세요.")
  } else {
    for (const name of disabledMethods(code, methods)) {
      if (!previous.has(name)) defects.push(`새 테스트 메서드 ${name}에 @Disabled가 붙어 있습니다. 비활성화하지 말고 통과하도록 고치거나 삭제하세요.`)
    }
  }

  if (opts.mocks.length > 0) {
    for (const mock of opts.mocks) {
      const simple = mock.split(".").pop()!
      if (!mentions(code, simple)) defects.push(`mock 대상 ${simple}이(가) 테스트에 없습니다.`)
    }
    if (!/@(?:MockitoBean|MockBean)\b/.test(code)) defects.push("@MockitoBean(또는 @MockBean)이 하나도 없습니다. mock 대상 필드에 붙이세요.")
  }

  // 트랜잭션 안전: 테스트 데이터가 DB에 남는 구성은 모든 테스트에서 금지 (Mapper 테스트는 실제 DB라 특히 중요)
  if (/@Commit\b/.test(code)) defects.push("@Commit이 있습니다. 테스트 트랜잭션은 롤백되어야 하므로 제거하세요.")
  if (/@Rollback\s*\(\s*(?:value\s*=\s*)?false\s*\)/.test(code)) defects.push("@Rollback(false)가 있습니다. 테스트 트랜잭션은 롤백되어야 하므로 제거하세요.")
  const propagation = [...new Set([...code.matchAll(/\bPropagation\.(NOT_SUPPORTED|REQUIRES_NEW|NEVER|SUPPORTS)\b/g)].map((m) => m[1]!))]
  if (propagation.length > 0) {
    defects.push(`Propagation.${propagation.join(", Propagation.")}이(가) 있습니다. 테스트 트랜잭션 밖에서 실행되거나 따로 커밋되므로 쓰지 말고 하나의 @Transactional 안에서 처리하세요.`)
  }

  const names = new Set(methods.map((m) => m.name))
  for (const prev of previous) {
    if (!names.has(prev)) defects.push(`기존 테스트 메서드 ${prev}이(가) 사라졌습니다. 삭제하지 말고 유지하세요.`)
  }

  const holders = [...new Set(code.match(/(?<!\$)\{[A-Z][A-Za-z]+\}/g) ?? [])]
  if (holders.length > 0) defects.push(`템플릿 플레이스홀더가 남아 있습니다: ${holders.join(", ")}. 실제 값으로 바꾸세요.`)

  return defects
}
