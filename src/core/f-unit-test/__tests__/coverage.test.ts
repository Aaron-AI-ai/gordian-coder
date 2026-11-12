import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { isFullyCovered, readCoverage, readFailedDetails, readFailedTests } from "../coverage"

const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="x"><sessioninfo id="a" start="1" dump="2"/>
  <package name="kr/co/x/service">
    <class name="kr/co/x/service/SvcA" sourcefilename="SvcA.java"><counter type="LINE" missed="1" covered="2"/></class>
    <sourcefile name="SvcA.java">
      <line nr="10" mi="0" ci="3" mb="0" cb="0"/>
      <line nr="11" mi="2" ci="0" mb="0" cb="0"/>
      <line cb="1" mb="1" ci="2" mi="1" nr="12"></line>
      <counter type="LINE" missed="1" covered="2"/>
      <counter type="BRANCH" covered="1" missed="1"/>
    </sourcefile>
    <sourcefile name="NoBranch.java">
      <line nr="3" mi="0" ci="1" mb="0" cb="0"/>
      <counter type="LINE" missed="0" covered="1"/>
    </sourcefile>
    <counter type="LINE" missed="1" covered="3"/>
  </package>
</report>`

describe("readCoverage", () => {
  const p = "mod/src/main/java/kr/co/x/service/SvcA.java"
  test("reads counters and line lists", () => {
    expect(readCoverage(XML, p)).toEqual({
      target: p,
      line: { missed: 1, covered: 2 },
      branch: { missed: 1, covered: 1 },
      uncoveredLines: [11],
      partialLines: [12],
    })
  })
  test("missing BRANCH counter gives zeros", () => {
    const c = readCoverage(XML, "src/main/java/kr/co/x/service/NoBranch.java")
    expect(c?.branch).toEqual({ missed: 0, covered: 0 })
    expect(isFullyCovered(c)).toBe(true)
  })
  test("unknown sourcefile gives null", () => {
    const c = readCoverage(XML, "src/main/java/kr/co/x/service/Other.java")
    expect(c).toBeNull()
    expect(isFullyCovered(c)).toBe(false)
  })
  test("backslash path works", () => {
    expect(readCoverage(XML, "mod\\src\\main\\java\\kr\\co\\x\\service\\SvcA.java")?.line).toEqual({ missed: 1, covered: 2 })
  })
  test("partially covered is not fully covered", () => {
    expect(isFullyCovered(readCoverage(XML, p))).toBe(false)
  })
})

describe("readFailedTests", () => {
  test("returns failure and error testcases only", () => {
    const d = mkdtempSync(join(tmpdir(), "cov-"))
    writeFileSync(join(d, "TEST-a.xml"), `<testsuite><testcase name="f" classname="p.A" time="0"><failure message="x">t</failure></testcase><testcase name="ok" classname="p.A"/></testsuite>`)
    writeFileSync(join(d, "TEST-b.xml"), `<testsuite><testcase classname="p.B" name="e"><error type="X"/></testcase></testsuite>`)
    expect(readFailedTests(d).sort()).toEqual(["p.A.f", "p.B.e"])
  })
  test("missing dir gives []", () => {
    expect(readFailedTests("/nonexistent-dir-xyz")).toEqual([])
  })
})

describe("readFailedDetails", () => {
  const XML = `<testsuite>
<testcase name="fee_normal1" classname="p.ShippingFeeServiceTest" time="0.1"><failure message="org.opentest4j.AssertionFailedError: expected: &lt;3000&gt; but was: &lt;3500&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected: &lt;3000&gt; but was: &lt;3500&gt;
	at org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)
	at p.ShippingFeeServiceTest.fee_normal1(ShippingFeeServiceTest.java:34)
	at java.base/java.lang.reflect.Method.invoke(Method.java:580)
</failure></testcase>
<testcase name="boom" classname="p.ShippingFeeServiceTest"><error message="NPE &amp; more" type="java.lang.NullPointerException">java.lang.NullPointerException
	at p.ShippingFeeService.fee(ShippingFeeService.java:21)
</error></testcase>
<testcase name="bare" classname="p.X"><failure message="x"/></testcase>
<testcase name="ok" classname="p.X"/>
</testsuite>`
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "cov-"))
    writeFileSync(join(d, "TEST-a.xml"), XML)
    return d
  }
  test("message, exception type, kind and the first project stack frame", () => {
    const [a, b, c] = readFailedDetails(dir())
    expect(a).toEqual({
      id: "p.ShippingFeeServiceTest.fee_normal1",
      cls: "p.ShippingFeeServiceTest",
      method: "fee_normal1",
      kind: "failure",
      type: "org.opentest4j.AssertionFailedError",
      message: "org.opentest4j.AssertionFailedError: expected: <3000> but was: <3500>",
      frame: "ShippingFeeServiceTest.java:34",
    })
    expect(b!.kind).toBe("error")
    expect(b!.message).toBe("NPE & more")
    expect(b!.frame).toBe("ShippingFeeService.java:21")
    expect(c).toMatchObject({ id: "p.X.bare", message: "x", frame: "", type: "" })
  })
  test("readFailedTests stays the id list of the same testcases", () => {
    expect(readFailedTests(dir())).toEqual(["p.ShippingFeeServiceTest.fee_normal1", "p.ShippingFeeServiceTest.boom", "p.X.bare"])
  })
})
