import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface Counter { missed: number; covered: number }
export interface FileCoverage {
  target: string
  line: Counter
  branch: Counter
  uncoveredLines: number[]
  partialLines: number[]
}

// ponytail: regex over JaCoCo's fixed XML output (no parser dependency); attribute order and
// self-closing/paired forms are tolerated, but attribute values containing ">" or XML
// comments/CDATA are not. Swap in a real XML parser if a report ever breaks this.
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = m[2]!
  return out
}

function counter(body: string, type: string): Counter {
  for (const m of body.matchAll(/<counter\b[^>]*>/g)) {
    const a = attrs(m[0])
    if (a.type === type) return { missed: Number(a.missed) || 0, covered: Number(a.covered) || 0 }
  }
  return { missed: 0, covered: 0 }
}

/** target = 프로젝트 상대 경로 (…/src/main/java/a/b/C.java). 소스 파일이 XML에 없으면 null. */
export function readCoverage(xml: string, target: string): FileCoverage | null {
  const norm = target.replace(/\\/g, "/")
  const marker = "src/main/java/"
  const at = norm.lastIndexOf(marker)
  const rel = at >= 0 ? norm.slice(at + marker.length) : norm
  const slash = rel.lastIndexOf("/")
  const pkg = slash >= 0 ? rel.slice(0, slash) : ""
  const file = rel.slice(slash + 1)

  for (const p of xml.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)) {
    if (attrs(p[1]!).name !== pkg) continue
    for (const s of p[2]!.matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g)) {
      if (attrs(s[1]!).name !== file) continue
      const body = s[2]!
      const uncoveredLines: number[] = []
      const partialLines: number[] = []
      for (const l of body.matchAll(/<line\b[^>]*>/g)) {
        const a = attrs(l[0])
        const nr = Number(a.nr)
        if (Number(a.ci) === 0 && Number(a.mi) > 0) uncoveredLines.push(nr)
        if (Number(a.mb) > 0) partialLines.push(nr)
      }
      return { target, line: counter(body, "LINE"), branch: counter(body, "BRANCH"), uncoveredLines, partialLines }
    }
  }
  return null
}

export interface FailedTest {
  /** "패키지.클래스.메서드" */
  id: string
  cls: string
  method: string
  kind: "failure" | "error"
  /** 예외 클래스 이름(junit 의 type 속성), 없으면 "" */
  type: string
  /** 메시지의 첫 줄(300자까지) */
  message: string
  /** 스택에서 처음 나오는 프로젝트 쪽 줄, 예: "FooTest.java:34", 없으면 "" */
  frame: string
}

/** Gradle writes `name="tax_boundary()"`; the method name is without the parameter list. */
const methodName = (n: string | undefined): string => (n ?? "").replace(/\(.*\)$/, "")

const entity = (t: string): string =>
  t
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")

const FRAMEWORK_FRAME = /^(?:org\.junit|org\.opentest4j|org\.mockito|org\.springframework|java\.|javax\.|jdk\.|sun\.|org\.apache|org\.gradle|worker\.)/

/** `<failure`/`<error`가 있는 testcase의 상세. 메시지·예외 종류·프로젝트 쪽 첫 스택 줄을 함께 읽는다. */
export function readFailedDetails(resultsDir: string): FailedTest[] {
  if (!existsSync(resultsDir)) return []
  const failed: FailedTest[] = []
  for (const f of readdirSync(resultsDir)) {
    if (!/^TEST-.*\.xml$/.test(f)) continue
    const xml = readFileSync(join(resultsDir, f), "utf8")
    for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      if (!m[2]) continue
      const e = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(m[2])
      if (!e) continue
      const a = attrs(m[1]!)
      const ea = attrs(e[2]!)
      const body = entity(e[3] ?? "")
      const message = entity(ea.message ?? body.split("\n")[0] ?? "").split("\n")[0]!.trim().slice(0, 300)
      let frame = ""
      for (const line of body.split("\n")) {
        const fm = /^\s*at\s+([\w.$]+)\.[\w$<>]+\(([\w$]+\.java:\d+)\)/.exec(line)
        if (fm && !FRAMEWORK_FRAME.test(fm[1]!)) {
          frame = fm[2]!
          break
        }
      }
      failed.push({
        id: `${a.classname ?? ""}.${methodName(a.name)}`,
        cls: a.classname ?? "",
        method: methodName(a.name),
        kind: e[1] as "failure" | "error",
        type: ea.type ?? "",
        message,
        frame,
      })
    }
  }
  return failed
}

/** `<failure`/`<error`가 있는 testcase를 "Class.method"로. */
export function readFailedTests(resultsDir: string): string[] {
  return readFailedDetails(resultsDir).map((d) => d.id)
}

export function isFullyCovered(c: FileCoverage | null): boolean {
  return c !== null && c.line.missed === 0 && c.branch.missed === 0
}

export interface TestRunCase {
  cls: string
  method: string
  status: "passed" | "failed" | "error" | "skipped"
  seconds: number
}
export interface TestRun {
  total: number
  passed: number
  failed: number
  errored: number
  skipped: number
  seconds: number
  tests: TestRunCase[]
}

/** 실행한 모든 testcase(JUnit XML)의 결과. 결과 디렉터리가 없으면 0건. */
export function readTestRun(resultsDir: string): TestRun {
  const run: TestRun = { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0, seconds: 0, tests: [] }
  if (!existsSync(resultsDir)) return run
  for (const f of readdirSync(resultsDir).sort()) {
    if (!/^TEST-.*\.xml$/.test(f)) continue
    const xml = readFileSync(join(resultsDir, f), "utf8")
    for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const a = attrs(m[1]!)
      const inner = m[2] ?? ""
      const status: TestRunCase["status"] = /<failure\b/.test(inner) ? "failed" : /<error\b/.test(inner) ? "error" : /<skipped\b/.test(inner) ? "skipped" : "passed"
      const seconds = Number(a.time) || 0
      run.tests.push({ cls: a.classname ?? "", method: methodName(a.name), status, seconds })
      run.total++
      run.seconds += seconds
      if (status === "passed") run.passed++
      else if (status === "failed") run.failed++
      else if (status === "error") run.errored++
      else run.skipped++
    }
  }
  return run
}
