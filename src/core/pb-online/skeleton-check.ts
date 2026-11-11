/**
 * Structural check of generated PB skeleton code, with no LLM involved.
 *
 * Encodes the mechanical part of the skill's `docs/pb-code-verification-rule.md`
 * against a real Java parse, so an annotation in a comment or string never
 * counts and each annotation is tied to the member it sits on. Wording of
 * Javadoc and the business logic stay with the LLM verify step.
 */

import { parse } from "java-parser";

interface Cst {
  name: string;
  children: Record<string, CstElement[]>;
}
interface Token {
  image: string;
  startOffset: number;
}
type CstElement = Cst | Token;

export interface SkeletonCheckOptions {
  /** False when the file existed before this run: only the target method is ours. */
  isNew: boolean;
  methodName?: string;
  isTargetController: boolean;
}

export interface SkeletonCheckResult {
  problems: string[];
  /** Set when an existing file could not be parsed, so nothing was checked. */
  unparsable?: string;
}

interface Annotation {
  name: string;
  attrs: Map<string, string>;
}

const isNode = (e: CstElement): e is Cst => "children" in e;
const kids = (n: Cst, name: string): Cst[] => (n.children[name] ?? []).filter(isNode);
const first = (n: Cst, name: string): Cst => kids(n, name)[0]!;

function tokens(n: Cst): Token[] {
  const out: Token[] = [];
  const go = (e: CstElement): void => {
    if (isNode(e)) Object.values(e.children).forEach((list) => list.forEach(go));
    else out.push(e);
  };
  go(n);
  return out.sort((a, b) => a.startOffset - b.startOffset);
}
/** Source of a node without comments or whitespace. */
const text = (n: Cst): string => tokens(n).map((t) => t.image).join("");

function findAll(n: Cst, name: string): Cst[] {
  const found: Cst[] = n.name === name ? [n] : [];
  for (const list of Object.values(n.children)) {
    for (const e of list) if (isNode(e)) found.push(...findAll(e, name));
  }
  return found;
}

function readAnnotation(a: Cst): Annotation {
  const attrs = new Map<string, string>();
  for (const pair of findAll(a, "elementValuePair")) {
    attrs.set((pair.children.Identifier![0] as Token).image, text(first(pair, "elementValue")));
  }
  return { name: text(first(a, "typeName")), attrs };
}

const annotationsOf = (modifiers: Cst[]): Annotation[] =>
  modifiers.flatMap((m) => kids(m, "annotation").map(readAnnotation));
const has = (anns: Annotation[], name: string): boolean => anns.some((a) => a.name === name);
const get = (anns: Annotation[], name: string): Annotation | undefined => anns.find((a) => a.name === name);

interface ClassParts {
  name: string;
  annotations: Annotation[];
  fields: Cst[];
  methods: Cst[];
  classes: ClassParts[];
  firstOffset: number;
}

function readClass(decl: Cst): ClassParts {
  const normal = first(decl, "normalClassDeclaration");
  const members = kids(first(normal, "classBody"), "classBodyDeclaration").flatMap((d) => kids(d, "classMemberDeclaration"));
  return {
    name: text(first(normal, "typeIdentifier")),
    annotations: annotationsOf(kids(decl, "classModifier")),
    fields: members.flatMap((m) => kids(m, "fieldDeclaration")),
    methods: members.flatMap((m) => kids(m, "methodDeclaration")),
    classes: members.flatMap((m) => kids(m, "classDeclaration")).map(readClass),
    firstOffset: tokens(decl)[0]!.startOffset,
  };
}

const methodDeclarator = (m: Cst): Cst => first(first(m, "methodHeader"), "methodDeclarator");
const methodName = (m: Cst): string => (methodDeclarator(m).children.Identifier![0] as Token).image;
const methodAnnotations = (m: Cst): Annotation[] => annotationsOf(kids(m, "methodModifier"));
const methodBody = (m: Cst): string => text(first(m, "methodBody"));
const fieldName = (f: Cst): string => text(first(first(first(f, "variableDeclaratorList"), "variableDeclarator"), "variableDeclaratorId"));
const fieldType = (f: Cst): string => text(first(f, "unannType"));
const fieldAnnotations = (f: Cst): Annotation[] => annotationsOf(kids(f, "fieldModifier"));

function requireAnnotations(where: string, anns: Annotation[], names: string[], out: string[]): void {
  for (const name of names) if (!has(anns, name)) out.push(`${where} is missing @${name}`);
}

function checkController(top: ClassParts, options: SkeletonCheckOptions, out: string[]): void {
  if (options.isNew) requireAnnotations(`class ${top.name}`, top.annotations, ["RestController", "Slf4j", "Tag"], out);
  const method = top.methods.find((m) => methodName(m) === options.methodName);
  if (!method) {
    if (options.isTargetController) out.push(`method ${options.methodName} was not found in the target controller`);
    return;
  }

  const where = `method ${methodName(method)}`;
  const anns = methodAnnotations(method);
  requireAnnotations(where, anns, ["PostMapping"], out);
  const otherMapping = anns.find((a) => /^(Get|Put|Delete|Patch|Request)Mapping$/.test(a.name));
  if (otherMapping) out.push(`${where} must use @PostMapping only, found @${otherMapping.name}`);

  const operation = get(anns, "Operation");
  if (!operation) out.push(`${where} is missing @Operation`);
  else for (const attr of ["summary", "description"]) {
    if (!operation.attrs.has(attr)) out.push(`${where}: @Operation is missing ${attr}`);
  }

  const result = text(first(first(method, "methodHeader"), "result"));
  if (!result.startsWith("PBResponse<")) out.push(`${where} must return PBResponse<...>, found ${result}`);

  const params = kids(methodDeclarator(method), "formalParameterList")
    .flatMap((l) => kids(l, "formalParameter"))
    .flatMap((p) => kids(p, "variableParaRegularParameter"));
  if (params.length !== 1) {
    out.push(`${where} must take exactly one parameter: @RequestBody PBRequest<...> param`);
  } else {
    const param = params[0]!;
    if (!has(annotationsOf(kids(param, "variableModifier")), "RequestBody")) out.push(`${where}: parameter is missing @RequestBody`);
    if (!text(first(param, "unannType")).startsWith("PBRequest<")) out.push(`${where}: parameter must be PBRequest<...>`);
  }

  if (!methodBody(method).includes("PBResponse.success(param.getCommonHeader(),")) {
    out.push(`${where} must return PBResponse.success(param.getCommonHeader(), result)`);
  }
}

const SERVICE_CALLS = ["preprocess(", "checkParameter(", "PBCommonUtils.setResponseMessage(", "postprocess("];

function checkService(file: string, top: ClassParts, out: string[]): void {
  requireAnnotations(`class ${top.name}`, top.annotations, ["Service"], out);
  const declared = new Set(top.methods.map(methodName));
  for (const helper of ["preprocess", "checkParameter", "postprocess"]) {
    if (!declared.has(helper)) out.push(`class ${top.name} is missing helper method ${helper}()`);
  }

  const main = top.methods.find((m) => has(methodAnnotations(m), "Transactional"));
  if (!main) {
    out.push(`class ${top.name} has no method with @Transactional`);
    return;
  }

  const readOnly = get(methodAnnotations(main), "Transactional")!.attrs.get("readOnly") === "true";
  if (file.includes("/qry/") && !readOnly) out.push(`qry service must use @Transactional(readOnly = true)`);
  if (file.includes("/upd/") && readOnly) out.push(`upd service must use @Transactional without readOnly`);

  const body = methodBody(main);
  const positions = SERVICE_CALLS.map((call) => body.indexOf(call));
  positions.forEach((at, i) => {
    if (at < 0) out.push(`method ${methodName(main)} never calls ${SERVICE_CALLS[i]})`);
  });
  const found = positions.filter((at) => at >= 0);
  if (found.some((at, i) => i > 0 && at < found[i - 1]!)) {
    out.push(`method ${methodName(main)}: wrong call order, expected preprocess → checkParameter → setResponseMessage → postprocess`);
  }
}

const VALUE_CLASS = ["Data", "Builder", "AllArgsConstructor", "NoArgsConstructor"];

function checkVoField(owner: string, field: Cst, nestedNames: Set<string>, out: string[]): void {
  const name = `${owner}.${fieldName(field)}`;
  const type = fieldType(field);
  const anns = fieldAnnotations(field);
  const schema = get(anns, "Schema");
  if (!schema?.attrs.has("description")) out.push(`field ${name} is missing @Schema(description)`);

  const data = get(anns, "FixedData");
  const list = get(anns, "FixedList");
  const vo = get(anns, "FixedVo");
  if ([data, list, vo].filter(Boolean).length !== 1) {
    out.push(`field ${name} needs exactly one of @FixedData, @FixedVo, @FixedList`);
    return;
  }
  if (type.startsWith("List<") && !list) out.push(`field ${name} is a List and must use @FixedList`);
  if (list) {
    if (!type.startsWith("List<")) out.push(`field ${name}: @FixedList needs a List type`);
    if (!list.attrs.has("size")) out.push(`field ${name}: @FixedList is missing size`);
  }
  if (data) {
    if (nestedNames.has(type)) out.push(`field ${name} is an OBJECT and must use @FixedVo, not @FixedData`);
    // padChar is optional: the framework picks a default from the field type.
    for (const attr of ["length", "padType"]) {
      if (!data.attrs.has(attr)) out.push(`field ${name}: @FixedData is missing ${attr}`);
    }
    const padType = data.attrs.get("padType");
    if (padType && !/^PAD_TYPE\.(RIGHT|LEFT)$/.test(padType)) out.push(`field ${name}: padType must be PAD_TYPE.RIGHT or PAD_TYPE.LEFT`);
    const padChar = data.attrs.get("padChar");
    if (padChar && !/^'.*'$/.test(padChar)) out.push(`field ${name}: padChar must be a char literal`);
  }
}

function checkVo(top: ClassParts, imports: string[], out: string[]): void {
  requireAnnotations(`class ${top.name}`, top.annotations, ["Data", "NoArgsConstructor", "Schema"], out);

  for (const field of top.fields) {
    if (fieldName(field) !== "inner") out.push(`field ${fieldName(field)} must be inside Inner, not on ${top.name}`);
  }
  const wrapper = top.fields.find((f) => fieldName(f) === "inner");
  if (!wrapper) out.push(`class ${top.name} is missing the field: @FixedVo private Inner inner`);
  else if (!has(fieldAnnotations(wrapper), "FixedVo")) out.push(`field inner is missing @FixedVo`);

  const inner = top.classes.find((c) => c.name === "Inner");
  if (!inner) out.push(`class ${top.name} is missing the static class Inner`);

  const nestedNames = new Set(top.classes.map((c) => c.name));
  for (const cls of top.classes) {
    requireAnnotations(`class ${cls.name}`, cls.annotations, VALUE_CLASS, out);
    if (cls !== inner && has(cls.annotations, "Schema")) out.push(`class ${cls.name} must not have class-level @Schema`);
    for (const field of cls.fields) checkVoField(cls.name, field, nestedNames, out);
  }

  const used = new Set([...top.classes.flatMap((c) => c.fields.flatMap(fieldAnnotations)), ...top.fields.flatMap(fieldAnnotations)].map((a) => a.name));
  const required = ["FixedVo"];
  if (used.has("FixedData")) required.push("FixedData", "FixedData.PAD_TYPE");
  if (used.has("FixedList")) required.push("FixedList");
  for (const name of required) {
    if (!imports.some((i) => i.endsWith(`.${name}`))) out.push(`missing import for ${name}`);
  }
}

function checkNewFile(source: string, top: ClassParts, out: string[]): void {
  if (/^ *\t/m.test(source)) out.push("indentation must be 4 spaces, found a tab");
  const head = source.slice(0, top.firstOffset);
  const javadoc = head.slice(head.lastIndexOf("/**"));
  if (!head.includes("/**")) out.push(`class ${top.name} has no Javadoc`);
  else for (const tag of ["@author", "@since"]) {
    if (!javadoc.includes(tag)) out.push(`class ${top.name} Javadoc is missing ${tag}`);
  }
}

type Kind = "controller" | "service" | "vo";

function kindOf(file: string): Kind | null {
  if (file.endsWith("Controller.java")) return "controller";
  if (file.endsWith("Service.java")) return "service";
  if (file.includes("/model/vo/") && file.endsWith(".java")) return "vo";
  return null;
}

/** `file` uses forward slashes and is only used for its role in the project layout. */
export function checkSkeleton(file: string, source: string, options: SkeletonCheckOptions): SkeletonCheckResult {
  const kind = kindOf(file);
  // Only the controller has a target method we can scope to in an existing file.
  if (!kind || (!options.isNew && kind !== "controller")) return { problems: [] };

  let unit: Cst;
  try {
    unit = parse(source) as unknown as Cst;
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    if (options.isNew) return { problems: [`${file}: does not parse as Java: ${reason}`] };
    return { problems: [], unparsable: reason };
  }

  const ordinary = first(unit, "ordinaryCompilationUnit");
  const decl = ordinary ? kids(ordinary, "typeDeclaration").flatMap((t) => kids(t, "classDeclaration"))[0] : undefined;
  if (!decl || kids(decl, "normalClassDeclaration").length === 0) return { problems: [`${file}: no class found`] };

  const top = readClass(decl);
  const imports = kids(ordinary, "importDeclaration").map((i) => text(i).replace(/^import/, "").replace(/;$/, ""));
  const out: string[] = [];

  const seen = new Set<string>();
  for (const name of imports) {
    if (seen.has(name)) out.push(`duplicate import ${name}`);
    seen.add(name);
  }

  if (kind === "controller") checkController(top, options, out);
  if (kind === "service") checkService(file, top, out);
  if (kind === "vo") checkVo(top, imports, out);
  if (options.isNew) checkNewFile(source, top, out);

  return { problems: out.map((p) => `${file}: ${p}`) };
}
