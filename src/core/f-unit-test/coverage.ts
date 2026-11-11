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

/** `<failure`/`<error`가 있는 testcase를 "Class.method"로. */
export function readFailedTests(resultsDir: string): string[] {
  if (!existsSync(resultsDir)) return []
  const failed: string[] = []
  for (const f of readdirSync(resultsDir)) {
    if (!/^TEST-.*\.xml$/.test(f)) continue
    const xml = readFileSync(join(resultsDir, f), "utf8")
    for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      if (!m[2] || !/<(?:failure|error)\b/.test(m[2])) continue
      const a = attrs(m[1]!)
      failed.push(`${a.classname ?? ""}.${a.name ?? ""}`)
    }
  }
  return failed
}

export function isFullyCovered(c: FileCoverage | null): boolean {
  return c !== null && c.line.missed === 0 && c.branch.missed === 0
}
