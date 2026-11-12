/**
 * MyBatis Mapper targets: classification, declared methods, and the static "every method is
 * called by the planned test" check that replaces JaCoCo for them (their SQL lives in XML).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { strip as stripComments } from "./test-check";

export interface MapperMethod {
  name: string;
  called: boolean;
  /** The plan marked this method skip_reason, so it is exempt from the call check. */
  skipped: boolean;
}

export interface MapperCheck {
  target: string;
  /** Project-relative planned test file that was read, or null when none is named `<Mapper>Test.java`. */
  testFile: string | null;
  methods: MapperMethod[];
}

// ponytail: regex scan, not a Java parser; an annotation argument that itself holds `(` inside a char literal is not handled.
/** Declared abstract method names when `source` is a Mapper interface, else null. */
export function mapperMethods(source: string, fileName: string): string[] | null {
  let code = stripComments(source);
  const decl = /(?<!@)\binterface\s+\w+[^{]*\{/.exec(code);
  if (!decl) return null;
  if (!/@Mapper\b/.test(code.slice(0, decl.index)) && !fileName.endsWith("Mapper.java")) return null;
  // Annotations, innermost parentheses first, so `@Results({@Result(..)})` and `@Param("x")` vanish.
  let body = code.slice(decl.index + decl[0].length);
  for (let prev = ""; prev !== body; ) {
    prev = body;
    body = body.replace(/@[\w.]+\s*\([^()]*\)/g, " ");
  }
  body = body.replace(/@[\w.]+/g, " ");

  const members: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of body) {
    if (ch === "{") {
      if (depth === 0) members.push(buf), (buf = "");
      depth++;
    } else if (ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0) {
      if (ch === ";") members.push(buf), (buf = "");
      else buf += ch;
    }
  }
  const names: string[] = [];
  for (const m of members) {
    if (/(?<![\w$])(?:default|static)(?![\w$])/.test(m.split("(")[0]!)) continue;
    const name = /([A-Za-z_$][\w$]*)\s*\(/.exec(m)?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

const called = (testCode: string, name: string): boolean => new RegExp(`\\.\\s*${name.replace(/\$/g, "\\$")}\\s*\\(`).test(testCode);

/**
 * One check per Mapper target. `skippedMethods` are the plan's skip_reason methods of that target.
 * Targets that do not exist or are not Mappers are left out.
 */
export function checkMapperTargets(
  cwd: string,
  targets: string[],
  testFiles: string[],
  skippedMethods: (target: string) => string[],
): MapperCheck[] {
  const out: MapperCheck[] = [];
  for (const target of targets) {
    const abs = path.resolve(cwd, target);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const methods = mapperMethods(fs.readFileSync(abs, "utf-8"), path.posix.basename(target));
    if (!methods) continue;
    const testName = `${path.posix.basename(target, ".java")}Test.java`;
    const testFile = testFiles.find((f) => path.posix.basename(f) === testName) ?? null;
    const testPath = testFile ? path.resolve(cwd, testFile) : null;
    const code = testPath && fs.existsSync(testPath) ? stripComments(fs.readFileSync(testPath, "utf-8")) : "";
    const skipped = skippedMethods(target);
    out.push({ target, testFile, methods: methods.map((name) => ({ name, called: called(code, name), skipped: skipped.includes(name) })) });
  }
  return out;
}

/** Defects (Korean, like test-check) for Mapper methods the planned test never calls. */
export function mapperDefects(checks: MapperCheck[]): string[] {
  return checks.flatMap((c) => {
    const missing = c.methods.filter((m) => !m.called && !m.skipped).map((m) => m.name);
    if (missing.length === 0) return [];
    const where = c.testFile ?? `${path.posix.basename(c.target, ".java")}Test.java`;
    const why = c.testFile ? "" : " (계획된 테스트 파일 중 이 이름의 파일이 없거나 비어 있습니다)";
    return [`${where}: Mapper ${path.posix.basename(c.target, ".java")}의 메서드 ${missing.join(", ")}을(를) 호출하는 테스트가 없습니다${why}. 메서드마다 .<메서드>(...) 호출이 있어야 합니다.`];
  });
}
