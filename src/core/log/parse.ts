/**
 * Java / fico stack trace parser. Pure: string in, structure out.
 *
 * Handles what real fico logs contain (see spec §5): the log4j2 line prefix
 * `[LEVEL:trace:user][host:ts][thread][logger{5}:method:L]` (plus the generic
 * `ts LEVEL … : msg` and bracketed `[ts] [] [host] [LEVEL] [thread] [logger:L]`
 * shapes), the four frame
 * suffix styles (`~[jar:ver]`, ` [jar:ver]`, `~[?:?]`, `[main/:?]`), the
 * `java.base/` module prefix, `Caused by:` chains with `... N more`
 * restoration, `Suppressed:`, Spring's legacy `; nested exception is`,
 * CGLIB/lambda names, message-less headers (`CommonException.create(code)`),
 * multi-line messages, and the handler log line that carries the error code
 * when the exception itself does not.
 */

export interface StackFrame {
  cls: string;
  method: string;
  file: string | null;
  line: number | null;
  raw: string;
}
export interface ExceptionBlock {
  type: string;
  message: string;
  frames: StackFrame[];
  /** "... N more" count — the frames were restored from the enclosing block. */
  omitted: number;
}
export interface HandlerInfo {
  errorCode?: string;
  svcId?: string;
  uri?: string;
  even?: string;
  logger?: string;
  exceptionType?: string;
  exceptionMessage?: string;
}
export interface ParsedLog {
  chain: ExceptionBlock[];
  suppressed: ExceptionBlock[];
  handler: HandlerInfo;
  raw: string;
}

// fico log4j2: [LEVEL:trace:user][host:ts][thread][logger:method:L] msg
const FICO_PREFIX = /^\[(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s*:[^\]]*\]\s*\[[^\]]*\]\s*\[[^\]]*\]\s*\[([^\]:]+)(?::[^\]]*)?\]\s*/;
// generic: 2026-01-01 00:00:00.000  INFO 1 --- [main] a.b.C : msg   /   2026-01-01T00:00:00Z LEVEL ... - msg
const GENERIC_PREFIX = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]?\d*Z?\s+(?:\S+\s+)*?(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b[^:]*?(?:\s[-:]\s|:\s)/;
// bracketed everything: [2026-09-17T09:47:07.352912] [] [host] [ERROR] [main] [logger.method:857] msg
const BRACKET_PREFIX = /^\[\d{4}-\d{2}-\d{2}[ T][^\]]*\]\s*(?:\[[^\]]*\]\s*)*\[(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]\s*\[[^\]]*\]\s*\[([^\]:]+)(?::[^\]]*)?\]\s*/;
const FRAME = /^\s*at\s+(?:[\w.$]+\/)?([\w$.]+)\.([\w$<>]+)\((?:([^:)]+):(\d+)|[^)]*)\)/;
const SUFFIX = /\s*~?\[[^\]]*\]\s*$/;
const MORE = /^\s*\.\.\.\s*(\d+)\s+more\s*$/;
const HEADER = /^(Caused by:\s*|Suppressed:\s*)?(?:Exception in thread "[^"]*"\s+)?([\w$.]+(?:Exception|Error|Throwable)[\w$]*)(?::\s?(.*))?$/;
// "Application run failed org.x.FooException: msg" — the logger message and the
// throwable glued on one line. FQCN only, so a bare "CommonException: errorCode=1"
// handler line is still a handler line and not a block.
const INLINE_HEADER = /(?:^|\s)([\w$]+(?:\.[\w$]+)+(?:Exception|Error|Throwable)[\w$]*):\s(.*)$/s;
const NESTED = /;\s*nested exception is\s+([\w$.]+(?:Exception|Error|Throwable)[\w$]*)(?::\s?(.*))?$/s;
const PROXY = /\$\$(?:EnhancerBySpringCGLIB|FastClassBySpringCGLIB|EnhancerByCGLIB|SpringCGLIB|Lambda)(?:\$\$[\w$]*|\$\d+)$/;
// JDK8+ hidden-class lambda naming glued onto the frame's module-prefix slot:
// "Cls$$Lambda$14/0x0000000800c0a208.accept(...)" — strip it before FRAME
// matches, or the optional module-prefix group swallows the class name.
const LAMBDA_ADDR = /\/0x[0-9a-f]+/g;
const LAMBDA_TAIL = /\$\$Lambda(?:\$\d+)?\/\S*/g;

// The exception PBGlobalExceptionAdvice maps each stack-less "PB <code>" line to.
const PB_CODE_TYPE: Record<string, string> = {
  "9604": "org.springframework.http.converter.HttpMessageNotReadableException",
  "404": "org.springframework.web.servlet.NoHandlerFoundException",
  "405": "org.springframework.web.HttpRequestMethodNotSupportedException",
  "415": "org.springframework.web.HttpMediaTypeNotSupportedException",
};

export function isExceptionType(s: string): boolean {
  return /^[\w$.]+(?:Exception|Error|Throwable)[\w$]*$/.test(s);
}

export function stripLinePrefix(line: string): { text: string; logger?: string; found: boolean } {
  const f = FICO_PREFIX.exec(line);
  if (f) return { text: line.slice(f[0].length), logger: f[1], found: true };
  const b = BRACKET_PREFIX.exec(line);
  if (b) return { text: line.slice(b[0].length), logger: b[1], found: true };
  const g = GENERIC_PREFIX.exec(line);
  if (g) return { text: line.slice(g[0].length), found: true };
  return { text: line, found: false };
}

export function normalizeClass(cls: string): string {
  return cls.replace(PROXY, "");
}

export function normalizeMethod(m: string): string {
  const l = /^lambda\$(\w+)\$\d+$/.exec(m);
  return l ? l[1] : m;
}

function parseFrame(line: string): StackFrame | null {
  const cleaned = line.replace(LAMBDA_ADDR, "").replace(LAMBDA_TAIL, "");
  const m = FRAME.exec(cleaned.replace(SUFFIX, ""));
  if (!m) return null;
  return {
    cls: normalizeClass(m[1]),
    method: normalizeMethod(m[2]),
    file: m[3] ?? null,
    line: m[4] ? Number(m[4]) : null,
    raw: line.trim(),
  };
}

/** Pull what the fico handlers log on the line before the trace. */
function extractHandler(text: string, into: HandlerInfo): void {
  const code = /(?:errorCode|\bcode)=([^\s,\]]+)/.exec(text);
  if (code) into.errorCode = code[1];
  const pb = /\bPB (404|405|415|9604)\b/.exec(text);
  if (pb) into.errorCode = pb[1];
  const uri = /\bURI=([^\s,\]]+)/.exec(text);
  if (uri) into.uri = uri[1];
  const svc = /\bsvcId=([A-Za-z0-9]+)/.exec(text);
  if (svc) into.svcId = svc[1];
  const even = /\beven[:=]\s*([^\s,\]]+)/.exec(text);
  if (even) into.even = even[1];
  const ex = /(?:Exception|CommonException):\[([\w$.]+(?:Exception|Error|Throwable)[\w$]*)(?::\s?([^\]]*))?\]/.exec(text);
  if (ex) {
    into.exceptionType = ex[1];
    into.exceptionMessage = ex[2] ?? "";
  } else if (/\bCommonException\b/.test(text) && !into.exceptionType) {
    // "PB CommonException: URI=…, code=…" — the type is implied
    into.exceptionType = "kr.co.openlabs.fico.framework.exception.CommonException";
    into.exceptionMessage = /msg=([^\]]*)$/.exec(text)?.[1]?.trim() ?? "";
  }
}

export function parseStackTrace(raw: string): ParsedLog {
  const chain: ExceptionBlock[] = [];
  const suppressed: ExceptionBlock[] = [];
  const handler: HandlerInfo = {};
  let current: ExceptionBlock | null = null;
  let currentIsSuppressed = false;
  let lastHandlerText: string | undefined;

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine.trim()) continue;
    const frame = parseFrame(rawLine);
    if (frame) {
      if (current) current.frames.push(frame);
      continue;
    }
    const more = MORE.exec(rawLine);
    if (more && current) {
      current.omitted = Number(more[1]);
      const enclosing = currentIsSuppressed ? chain.at(-1) : chain[chain.indexOf(current) - 1];
      if (enclosing) current.frames.push(...enclosing.frames.slice(-current.omitted));
      continue;
    }
    const { text, logger, found } = stripLinePrefix(rawLine);
    const h = HEADER.exec(text.trim());
    if (h) {
      const block: ExceptionBlock = { type: h[2], message: (h[3] ?? "").trim(), frames: [], omitted: 0 };
      if (block.message === "null") block.message = "";
      currentIsSuppressed = h[1]?.startsWith("Suppressed") ?? false;
      (currentIsSuppressed ? suppressed : chain).push(block);
      current = block;
      continue;
    }
    if (!current) {
      // Only before the first block: the handler line that precedes the trace.
      if (logger && !handler.logger) handler.logger = logger;
      const inline = INLINE_HEADER.exec(text);
      // Only a real header: the next non-blank line must be a stack frame, or
      // this is prose that merely quotes/mentions an FQCN (F1).
      const next = inline ? lines.slice(i + 1).find((l) => l.trim()) : undefined;
      if (inline && next && parseFrame(next)) {
        extractHandler(text, handler);
        current = { type: inline[1], message: inline[2].trim(), frames: [], omitted: 0 };
        chain.push(current);
        continue;
      }
      extractHandler(text, handler);
      lastHandlerText = text;
    } else if (found) {
      // A line carrying its own log prefix (and not a header/frame/"... N more")
      // is the next log entry, not a continuation of this message — stop here
      // rather than absorb it (I-3).
      break;
    } else {
      current.message = current.message ? `${current.message}\n${text}` : text;
    }
  }

  // Legacy Spring: "...; nested exception is X: msg" → X becomes the cause block.
  for (let i = 0; i < chain.length; i++) {
    const m = NESTED.exec(chain[i].message);
    if (!m) continue;
    chain[i].message = chain[i].message.slice(0, m.index).trim();
    chain.splice(i + 1, 0, { type: m[1], message: (m[2] ?? "").trim(), frames: [], omitted: 0 });
  }

  // No trace at all but the handler line named an exception, error code or URI →
  // one empty block, so a stack-less PB warn line is still a first-class input
  // (spec §6, §5.8). The type comes from the handler text itself when present,
  // else from what PBGlobalExceptionAdvice maps that error code to.
  if (!chain.length && (handler.exceptionType || handler.errorCode || handler.uri)) {
    const type = handler.exceptionType ?? PB_CODE_TYPE[handler.errorCode ?? ""] ?? "kr.co.openlabs.fico.framework.exception.CommonException";
    chain.push({ type, message: handler.exceptionMessage ?? lastHandlerText ?? "", frames: [], omitted: 0 });
  }

  return { chain, suppressed, handler, raw };
}
