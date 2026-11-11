import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkSkeleton } from "../skeleton-check";

const TEMPLATES = path.resolve(import.meta.dir, "../../../../assets/fico-ai/skills/pb-fixed-online-code/templates");
const VALUES: Record<string, string> = {
  PackagePath: "x.online.qry", CurrentDate: "2026.11.10", AuthorName: "FICO AI", ServiceId: "AIAC0007", serviceId: "aiac0007",
  ServiceKoreanName: "계좌", ServiceDescription: "설명", ChangeDescription: "신규", Collection: "ac", DependencyType: "Foo",
  dependencyName: "foo", ResponseMessageCode: "M1", FieldName: "acctNo", Description: "계좌번호", Length: "10", PadType: "RIGHT",
  PadChar: "0", Size: "5",
};
const render = (name: string): string =>
  fs.readFileSync(path.join(TEMPLATES, name), "utf-8").replace(/\{(\w+)\}/g, (m, k: string) => VALUES[k] ?? m);

const CONTROLLER = "a-online/src/main/java/x/online/qry/controller/AcController.java";
const QRY = "a-online/src/main/java/x/online/qry/service/AIAC0007Service.java";
const UPD = "a-online/src/main/java/x/online/upd/service/AIAC0007Service.java";
const VO = "a-online/src/main/java/x/online/qry/model/vo/AIAC0007In.java";
const NEW = { isNew: true, methodName: "aiac0007", isTargetController: true };

function replaced(source: string, from: string, to: string): string {
  expect(source).toContain(from);
  return source.replace(from, to);
}
const problems = (file: string, source: string, options = NEW) => checkSkeleton(file, source, options).problems.join("\n");

describe("the real templates are clean", () => {
  test.each([
    ["ControllerTemplate.java", CONTROLLER],
    ["QryServiceTemplate.java", QRY],
    ["UpdServiceTemplate.java", UPD],
    ["VoInTemplate.java", VO],
    ["VoOutTemplate.java", VO],
    ["VoInNestedTemplate.java", VO],
    ["VoOutNestedTemplate.java", VO],
  ])("%s", (template, file) => {
    expect(checkSkeleton(file, render(template), NEW)).toEqual({ problems: [] });
  });
});

describe("files outside the skeleton are skipped", () => {
  test("not even parsed", () => {
    expect(checkSkeleton("a/Helper.java", "not java at all", NEW)).toEqual({ problems: [] });
  });
});

describe("controller", () => {
  const src = render("ControllerTemplate.java");
  test.each([
    ["@RestController\n", "", "@RestController"],
    ["@Slf4j\n", "", "@Slf4j"],
    ['@PostMapping(value = "/ac/AIAC0007")', '@GetMapping(value = "/ac/AIAC0007")', "@PostMapping"],
    [', description = "설명")\n    public', ")\n    public", "@Operation"],
    ["public PBResponse<AIAC0007Out>", "public AIAC0007Out", "PBResponse"],
    ["@RequestBody PBRequest<AIAC0007In> param", "PBRequest<AIAC0007In> param", "@RequestBody"],
    ["@RequestBody PBRequest<AIAC0007In> param", "@RequestBody AIAC0007In param", "PBRequest"],
    ["return PBResponse.success(param.getCommonHeader(), result);", "return null;", "PBResponse.success"],
  ])("removing %s is reported", (from, to, expected) => {
    expect(problems(CONTROLLER, replaced(src, from, to))).toContain(expected);
  });

  test("both Mapping styles on the method are rejected", () => {
    const bad = replaced(src, "@PostMapping(", '@PutMapping("/x")\n    @PostMapping(');
    expect(problems(CONTROLLER, bad)).toContain("@PostMapping only");
  });

  test("a required annotation that only appears in a comment does not count", () => {
    const bad = replaced(src, "@RestController\n", "// @RestController\n");
    expect(problems(CONTROLLER, bad)).toContain("@RestController");
  });

  test("the target method must exist in the target controller", () => {
    expect(problems(CONTROLLER, src, { ...NEW, methodName: "other" })).toContain("other");
  });

  test("an existing controller is held to the method rules only", () => {
    const old = replaced(replaced(src, "@RestController\n", ""), "@Slf4j\n", "");
    expect(checkSkeleton(CONTROLLER, old, { ...NEW, isNew: false })).toEqual({ problems: [] });
    const broken = replaced(old, "@RequestBody ", "");
    expect(problems(CONTROLLER, broken, { ...NEW, isNew: false })).toContain("@RequestBody");
  });
});

describe("service", () => {
  const qry = render("QryServiceTemplate.java");
  const upd = render("UpdServiceTemplate.java");

  test("qry needs readOnly and upd must not have it", () => {
    expect(problems(QRY, replaced(qry, "@Transactional(readOnly = true)", "@Transactional"))).toContain("readOnly");
    expect(problems(UPD, replaced(upd, "@Transactional\n", "@Transactional(readOnly = true)\n"))).toContain("readOnly");
  });

  test("no @Transactional at all is reported", () => {
    expect(problems(QRY, replaced(qry, "@Transactional(readOnly = true)\n", ""))).toContain("@Transactional");
  });

  test("call order is enforced", () => {
    const swapped = replaced(qry, "preprocess();\n        checkParameter(param);", "checkParameter(param);\n        preprocess();");
    expect(problems(QRY, swapped)).toContain("order");
  });

  test("response message must come before postprocess", () => {
    const swapped = replaced(
      qry,
      'PBCommonUtils.setResponseMessage("M1");\n        postprocess();',
      'postprocess();\n        PBCommonUtils.setResponseMessage("M1");'
    );
    expect(problems(QRY, swapped)).toContain("order");
  });

  test("a call that exists only in a comment is missing", () => {
    const bad = replaced(qry, "        postprocess();\n", "        // postprocess();\n");
    expect(problems(QRY, bad)).toContain("postprocess");
  });

  test("a missing helper is reported", () => {
    const bad = replaced(qry, "private void checkParameter(", "private void renamedCheck(");
    expect(problems(QRY, bad)).toContain("checkParameter");
  });
});

describe("vo", () => {
  const plain = render("VoInTemplate.java");
  const nested = render("VoInNestedTemplate.java");

  test.each([
    [plain, "@FixedVo\n    private Inner inner;", "private Inner inner;", "@FixedVo"],
    [plain, "    @Builder\n", "", "@Builder"],
    [plain, ", padType = PAD_TYPE.RIGHT", "", "padType"],
    [plain, "length = 10, ", "", "length"],
    [plain, "padType = PAD_TYPE.RIGHT", "padType = RIGHT", "padType"],
    [plain, "padChar = '0'", 'padChar = "0"', "padChar"],
    [nested, "@FixedList(size = 5)", "@FixedList", "size"],
    [nested, "@FixedList(size = 5)\n", "@FixedData(length = 1, padType = PAD_TYPE.RIGHT, padChar = '0')\n", "@FixedList"],
  ])("%#", (source, from, to, expected) => {
    expect(problems(VO, replaced(source, from, to))).toContain(expected);
  });

  test("padChar may be omitted, but must be a char literal when present", () => {
    expect(problems(VO, replaced(plain, ", padChar = '0'", ""))).toBe("");
    expect(problems(VO, replaced(plain, "padChar = '0'", 'padChar = "0"'))).toContain("padChar");
  });

  test("a field with no fixed annotation is reported by name", () => {
    const bad = replaced(plain, "@FixedData(length = 10, padType = PAD_TYPE.RIGHT, padChar = '0')\n", "");
    expect(problems(VO, bad)).toContain("acctNo");
  });

  test("@FixedData that only appears in a comment or string does not count", () => {
    const line = "@FixedData(length = 10, padType = PAD_TYPE.RIGHT, padChar = '0')";
    expect(problems(VO, replaced(plain, line, `// ${line}`))).toContain("acctNo");
  });

  test("a field initializer is not part of the field name", () => {
    expect(problems(VO, replaced(plain, "private Inner inner;", "private Inner inner = new Inner();"))).toBe("");
  });

  test("a business field on the outer class is reported", () => {
    expect(problems(VO, replaced(plain, "private Inner inner;", "private Inner inner;\n    private String stray;"))).toContain("stray");
  });

  test("an OBJECT field typed as a nested class cannot use @FixedData", () => {
    const bad = replaced(nested, "@FixedVo\n        private AIAC0007acctNo", "@FixedData(length = 1, padType = PAD_TYPE.RIGHT, padChar = '0')\n        private AIAC0007acctNo");
    expect(problems(VO, bad)).toContain("@FixedVo");
  });

  test("a nested class must not carry class-level @Schema", () => {
    const bad = replaced(nested, "public static class AIAC0007acctNo", '@Schema(description = "x")\n    public static class AIAC0007acctNo');
    expect(problems(VO, bad)).toContain("@Schema");
  });

  test("required imports and duplicates", () => {
    const fixedVo = "import kr.co.openlabs.fico.framework.internal.annotations.FixedVo;\n";
    expect(problems(VO, replaced(plain, fixedVo, ""))).toContain("FixedVo");
    expect(problems(VO, replaced(plain, fixedVo, fixedVo + fixedVo))).toContain("duplicate import");
  });

  test("tabs and the class Javadoc", () => {
    expect(problems(VO, replaced(plain, "    private Inner inner;", "\tprivate Inner inner;"))).toContain("tab");
    expect(problems(VO, replaced(plain, " * @author FICO AI\n", ""))).toContain("@author");
  });
});

describe("unparsable", () => {
  const broken = "public class {{{";

  test("a new file is a problem, since the skeleton should always parse", () => {
    const result = checkSkeleton(VO, broken, NEW);
    expect(result.problems.join()).toContain("does not parse");
    expect(result.unparsable).toBeUndefined();
  });

  test("an existing file is flagged as unchecked, not passed and not failed", () => {
    const result = checkSkeleton(CONTROLLER, broken, { ...NEW, isNew: false });
    expect(result.problems).toEqual([]);
    expect(result.unparsable).toBeDefined();
  });
});
