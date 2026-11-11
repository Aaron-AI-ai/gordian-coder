---
name: pb-fico-utils-guide
description: Helps developers reuse the Util functions the FICO framework already ships — by consulting the human-readable English guide documents under references/ — instead of reimplementing them, whenever they are writing or modifying Java business code (Service, Controller, Mapper, Batch) on a FICO-based project. Trigger this skill the moment the code in front of you involves — or is about to involve — date/time conversion, string validation/masking/padding, number formatting/rounding, currency comma formatting, object mapping (DTO↔Entity, snake_case↔camelCase), fixed-length message (de)serialization, encryption/hashing, LZO compression, Spring Bean lookup, request/thread-scope data, common response construction (CommonResponse), i18n message lookup, GUID/TraceId generation, or environment detection (prod/dev, online/batch). Also trigger it when the user mentions "fico util", "공통 함수", "framework helpers", or specific classes like "DateUtils / StringUtils". Apply this skill proactively, without waiting for an explicit ask, the moment a developer looks like they are about to roll their own version of any capability above. This skill ships curated English guide docs with built-in "Situation → Function" tables — use them first to locate the right function quickly.

---

# FICO Framework Util Usage Guide (Doc-Driven)

This skill helps you reuse the Util functions the FICO framework already provides whenever you are writing or modifying Java business code on a FICO-based project. Reimplementing the same capability by hand breaks project-wide consistency and bypasses the guarantees the framework already gives you — multi-byte (EUC-KR/UTF-8) handling, fixed-length message compatibility, exception wrapping, locale resolution, and so on. **The rule of thumb: first check whether a Util exists, and only write your own when none does.**

## What's Different About This Skill — Guide-Doc References

The [references/](references/) directory does **not** contain raw `.java` source. It contains **English user guides** — one per Util class — written specifically to help you (and an AI assistant) pick the right function fast. Each guide is structured the same way:

1. **Overview** — what the class is for, its package (so you know the `import`), and any cross-cutting caveats (e.g. "this length is character count, that length is UTF-8 bytes").
2. **🎯 Situational Function Selection Guide** — a set of tables keyed by **situation / trigger phrase** ("Is the string `null` or empty?", "Get UTF-8 byte length", "Mask middle digits of an account number", …) that point to the exact function name with an in-doc anchor link.
3. **Per-function detail sections** — full signature, parameters, return type, behavior on null/empty/boundary inputs, examples, related functions.

Because of this structure, the fastest way to use a guide is: jump to its "Situational Function Selection Guide" tables, find the phrase that matches your intent, click through to the function's anchor section, copy the exact signature. The tables are the index; the per-function sections are the truth.

## 🔑 First Principle — Prefer FICO Utils Over Java / Spring Built-ins

The moment you are about to `import` or call a util from `java.util.UUID`, `java.text.SimpleDateFormat`, `java.time.LocalDate`, `java.security.MessageDigest`, `javax.crypto.Cipher`, `String.format("%,d", …)`, `org.apache.commons.lang3.StringUtils`, `org.springframework.util.StringUtils`, `org.springframework.beans.BeanUtils`, `org.modelmapper.ModelMapper`, `org.springframework.context.MessageSource`, or any similar **Java standard / Spring / Commons utility**, stop and first check whether the FICO framework — via the guides under [references/](references/) — provides an equivalent. If it does, **the FICO version is the one to use**; fall back to the standard library only when there is no FICO counterpart.

Why this rule is non-negotiable:

- **Convention consistency** — The same capability should be invoked through the same function across the codebase. This keeps code review, static analysis, and large-scale refactors tractable.
- **Multi-byte (EUC-KR/UTF-8) and fixed-length compatibility** — Standard-library calls force the caller to handle 3-byte Hangul, byte boundaries, and fixed-length padding by hand. FICO Utils have already solved those problems.
- **Exception wrapping** — Runtime exceptions inside the Utils are consistently re-thrown as `CommonException`. Calling the standard library directly bypasses this and breaks the global error contract.
- **Locale and DB-driven messages** — Calling `MessageSource` directly skips the project's i18n / `COM_MSG` integration. Going through `MessageUtils` keeps it intact.
- **Encryption keys and algorithms** — Using `MessageDigest`/`Cipher` directly leaks the choice of salt, IV, algorithm, and padding to each caller. `EncryptUtils` enforces a single framework-wide configuration.

Common substitutions — if you were about to reach for the left column, look at the right column first:

| What you were about to use (Std / Spring / Commons) | FICO Util to check first |
|---|---|
| `java.util.UUID.randomUUID()` (transaction / request IDs) | `CommonUtils.generateGuid(prefix)` |
| `new SimpleDateFormat("yyyyMMdd").format(...)`, `DateTimeFormatter` | `DateUtils.getCurrentDate()`, `DateUtils.setDateFormat(...)` |
| `LocalDate.now()`, `ChronoUnit.between(...)`, `Calendar` arithmetic | `DateUtils` (`getCurrentDate`, `getDaysBetween`, `addDay`, `getAge`, …) |
| `MessageDigest.getInstance("SHA-256")` | `EncryptUtils.encrypt()` / `encryptSha256()` |
| `Cipher.getInstance("AES/...")` hand-rolled | `EncryptUtils.encryptAES()` / `decryptAES()` |
| `String.format("%,d", amount)` / `NumberFormat.getInstance().format(...)` | `StringUtils.setComma()` / `longToComma()` / `doubleToComma()` |
| `org.apache.commons.lang3.StringUtils.isEmpty/isBlank/…` | `kr.co.openlabs.fico.framework.utils.StringUtils.isEmpty/isBlank/…` |
| `org.springframework.util.StringUtils` trim / checks | FICO `StringUtils` |
| `org.springframework.beans.BeanUtils.copyProperties(...)` | `MapperUtils.convert(...)` |
| `new ModelMapper().map(...)` (own instance) | `MapperUtils` (pre-configured instance) |
| `ApplicationContextAware` implementation / `ApplicationContext.getBean()` | FICO `BeanUtils.getBean()` |
| `MessageSource.getMessage(...)` direct call | `MessageUtils.getMessage(...)` |
| `RequestContextHolder.currentRequestAttributes()` direct use | `RequestScopeUtils` |
| `BigDecimal.setScale(n, RoundingMode.X)`, `Math.round(...)` | `NumberUtils.setScalePrc(...)`, `NumberUtils.longRoundUp/Down/Off(...)` |
| `SecureRandom` for serial / sequence numbers | `NumberUtils.generateSecretLongNumber()` / `EncryptUtils.encryptNumberByBlake2b()` |
| `Integer.parseInt`/`Long.parseLong`/`Double.parseDouble` with manual null/exception handling | `NumberUtils.stringToInt/Long/Double(...)` |
| `Base64` / `GZIP` for ad-hoc compression (large messages) | `CompressionUtils.compressLzo()` / `decompressLzo()` |

This table is still only a quick index. Once you've picked a FICO method to switch to, confirm its real signature by following the rule below ("Always read the guide doc directly"). And even when nothing in this table fits, grep the guides before concluding "no FICO util exists."

## ⚠️ Most Important Rule — Always Read the Guide Doc Directly

**Before you write a single line of calling code, and before you conclude "there is no Util for this," you must** open the relevant `*-guide.en.md` file under [references/](references/) yourself — with the Read or Grep tool — and verify the following with your own eyes:

1. **Does the function actually exist?** — Grep the function name (e.g. `grep -n "masking" stringutils-guide.en.md`) in the guide, then jump to the anchor section the index table points to. The tables in this SKILL.md were written by a human and may contain omissions, typos, or renamings — the guide doc is the source of truth.
2. **What is the exact signature?** — Argument count, types, order, return type, and thrown exceptions. The guide lists each overload separately with its full signature; pick the one that matches your intent.
3. **How does it handle null / empty / boundary cases?** — Each function's detail section explicitly documents how it deals with empty strings, null input, byte boundaries, encoding options. This determines whether the caller has to defend or whether the Util already does. **Don't skip this — it is the single biggest source of subtle bugs.**
4. **Are there functions the table missed?** — Before deciding "no Util exists, I'll write it myself," grep `references/` for two or three intent-related keywords (e.g. `mask`, `format`, `convert`). Useful helpers that didn't make it into this SKILL.md show up surprisingly often, especially in the larger guides (`stringutils-guide.en.md`, `dateutils-guide.en.md`, `formatterutils-guide.en.md`).

> Guessing function names from this SKILL.md, or inventing signatures from intuition, is **the single most common failure mode for this skill**. It produces compile errors, wrong arguments, and calls to functions that don't exist. Re-reading a guide section is far cheaper than fixing those — don't hesitate, open the file.

### Working with the Guide Format

Each guide is structured for fast lookup. The recommended traversal is:

1. **Open the file at the top** (`Read` with `limit: 30` is usually enough) to see the Overview + the `🎯 Situational Function Selection Guide` headings. This tells you what's available without loading the whole doc.
2. **Grep for the situation or keyword** that matches your intent (e.g. `grep -n "mask\|masking" stringutils-guide.en.md`). The Situational Function Selection Guide tables are explicitly designed for this — they use phrases like "Is the string null or empty?", "Get UTF-8 byte length", "Mask middle digits of an account number".
3. **Jump to the anchor** the index links to (the guides use intra-document `#anchor` links of the form `#functionname-paramtypes`). `Read` the file with `offset` set to that section to load just the function's detail block.
4. **Copy the exact signature** from the detail section into your code. If the detail section lists overloads, choose deliberately — they often differ in null handling or encoding behavior.

## Operating Procedure

When writing business code, follow this sequence. The "Most Important Rule" applies at every step.

1. **Identify intent** — Determine which category the logic falls into (date / string / number / mapping / response / message / encryption / compression / Bean / Scope / PB-specific / …).
2. **Narrow down candidate guides** — Use the "Capability → Guide" tables below to identify candidate guide files. Treat the result as a **shortlist**, not an answer.
3. **Open the guide and use its Situational Selection table (mandatory)** — Read the candidate `*-guide.en.md`. Start with the doc's own situation→function index, then jump to the matching function's detail section. If your intent is ambiguous or no situation matches, run `grep -rn "<keyword>" skills/pb-fico-utils-guide/references/` first to re-narrow. **Do not skip this step.**
4. **Pick the function** — Compare signatures, arguments, return types, null/empty handling, and encoding options against your intent — based on the actual guide section you just read.
5. **Write the call** — `import` using the precise FQCN (see the package table) and invoke as `ClassName.methodName(...)`. Every Util is `@UtilityClass` or has a `private` constructor, so **all calls are static**.
6. **Re-read on doubt** — When the behavior feels uncertain, re-open the guide. Do not hallucinate function names or signatures.

## Package Paths (for imports)

| Directory | Package | Classes (covered by guides) |
|---|---|---|
| [references/fico-fwk-core/](references/fico-fwk-core/) | `kr.co.openlabs.fico.framework.utils` | BeanUtils, CompressionUtils, DateUtils, EncryptUtils, FormatterUtils, MapperUtils, MemberCheckUtils, NumberUtils, RequestScopeUtils, StringUtils |
| [references/fico-fwk-extension/](references/fico-fwk-extension/) | `kr.co.openlabs.fico.framework.extension.utils` | CommonUtils, MessageUtils |
| [references/framework-site-ext/](references/framework-site-ext/) | `kr.co.koscom.pb.framework.site.ext.utils` | PBCommonUtils |

## Capability → Guide (Quick Lookup)

Whenever you are about to perform any task below, open the referenced guide first before writing your own version.

### Date / Time

| What you want to do | Reference guide |
|---|---|
| Current date/time (YYYYMMDD, HHmmss, milli/microsecond variants) | [dateutils-guide.en.md](references/fico-fwk-core/dateutils-guide.en.md) |
| Validate YYYYMMDD / HHMMSS format (including leap years) | [dateutils-guide.en.md](references/fico-fwk-core/dateutils-guide.en.md) |
| Compare two dates, add days/months/years, weekday / quarter / business-day arithmetic | [dateutils-guide.en.md](references/fico-fwk-core/dateutils-guide.en.md) |
| Western age / Korean age | [dateutils-guide.en.md](references/fico-fwk-core/dateutils-guide.en.md) |
| Convert between `LocalDate` / `LocalDateTime` / Epoch | [dateutils-guide.en.md](references/fico-fwk-core/dateutils-guide.en.md) |
| **Fixed-length timestamp formatting** (`YYYYMMDDhhmmssccc`-style PB tokens) | [pbcommonutils-guide.en.md](references/framework-site-ext/pbcommonutils-guide.en.md) `getSysTimeStr()` |

> Use `DateUtils` for standard formats. Use `PBCommonUtils.getSysTimeStr()` when you need PB-specific tokens such as 2-digit year `YY` or variable-width microsecond `c`.

### String

| What you want to do | Reference guide |
|---|---|
| null / empty / blank / whitespace checks (`isEmpty`, `isBlank`, `isSpace`, `isAllSpace`) | [stringutils-guide.en.md](references/fico-fwk-core/stringutils-guide.en.md) |
| Character-class checks (digit / alpha / upper / lower / hex / contains-Hangul) | [stringutils-guide.en.md](references/fico-fwk-core/stringutils-guide.en.md) |
| Case conversion, trim (left / right / both), character replace / remove | [stringutils-guide.en.md](references/fico-fwk-core/stringutils-guide.en.md) |
| String compare (partial / case-insensitive), null-default (`nvl`) | [stringutils-guide.en.md](references/fico-fwk-core/stringutils-guide.en.md) |
| Padding (left / right, custom char), substring, byte-aware slicing | [stringutils-guide.en.md](references/fico-fwk-core/stringutils-guide.en.md) |
| Currency comma formatting (`setComma`, `longToComma`, `doubleToComma`) | [stringutils-guide.en.md](references/fico-fwk-core/stringutils-guide.en.md) |
| Sensitive-data masking (`masking`, `automaskingView` — account / SSN / card numbers) | [stringutils-guide.en.md](references/fico-fwk-core/stringutils-guide.en.md) |
| EUC-KR ↔ UTF-8 encoding conversion, multi-byte-safe padding / slicing | [stringutils-guide.en.md](references/fico-fwk-core/stringutils-guide.en.md) |
| Date-string format conversion (`setDateFormat`) | [stringutils-guide.en.md](references/fico-fwk-core/stringutils-guide.en.md) |

### Number

| What you want to do | Reference guide |
|---|---|
| String ↔ int / long / double / BigDecimal | [numberutils-guide.en.md](references/fico-fwk-core/numberutils-guide.en.md) |
| Round up / down / off (`setScalePrc`, `longRoundUp/Down/Off`, `truncDecimal`, …) — money and interest math | [numberutils-guide.en.md](references/fico-fwk-core/numberutils-guide.en.md) |
| Index lookup in a numeric array (`inStringArray`, `inLongArray`) | [numberutils-guide.en.md](references/fico-fwk-core/numberutils-guide.en.md) |
| Numeric amount to Korean words (`longToKor` — "사천팔백만…") | [numberutils-guide.en.md](references/fico-fwk-core/numberutils-guide.en.md) |
| Secure random / sequence number generation (`generateSecretLongNumber`) | [numberutils-guide.en.md](references/fico-fwk-core/numberutils-guide.en.md) |

### Membership Check

| What you want to do | Reference guide |
|---|---|
| Is a string / number in an allowed list (1-based index, 0 = not found) — code-value validation, SQL-IN replacement | [membercheckutils-guide.en.md](references/fico-fwk-core/membercheckutils-guide.en.md) |

### Object Mapping

| What you want to do | Reference guide |
|---|---|
| DTO ↔ Entity ↔ VO conversion (matching field names) | [mapperutils-guide.en.md](references/fico-fwk-core/mapperutils-guide.en.md) `convert()` |
| Partial mapping into an existing object | [mapperutils-guide.en.md](references/fico-fwk-core/mapperutils-guide.en.md) `convert(source, destinationObj)` |
| Bulk list conversion | [mapperutils-guide.en.md](references/fico-fwk-core/mapperutils-guide.en.md) `convertList()` |
| **DB result (snake_case) → Java object (camelCase)** | [mapperutils-guide.en.md](references/fico-fwk-core/mapperutils-guide.en.md) `convertFromUnderscoreToCamel(...)`, `convertListFromUnderscoreToCamel(...)` |

> Do not hand-write rows of `setXxx()` calls. If the field names match, `MapperUtils` does it in one line.

### Fixed-Length Message

| What you want to do | Reference guide |
|---|---|
| Java Object → fixed-length string serialization | [formatterutils-guide.en.md](references/fico-fwk-core/formatterutils-guide.en.md) `getFixedData(Object)` |
| Fixed-length string → Java Object parsing (encoding / length-check / generic options) | [formatterutils-guide.en.md](references/fico-fwk-core/formatterutils-guide.en.md) `getFixedData(String, Class, ...)` |
| Default encoding (UTF-8 / EUC-KR), padding / cut / trim behavior | [formatterutils-guide.en.md](references/fico-fwk-core/formatterutils-guide.en.md) (`setDefaultCharEncoding`, …) |
| Inspect parse errors, compute VO max length | [formatterutils-guide.en.md](references/fico-fwk-core/formatterutils-guide.en.md) |
| `@FixedList(size)` cap of a List field on a VO | [pbcommonutils-guide.en.md](references/framework-site-ext/pbcommonutils-guide.en.md) `getMaxSize()` |

### Encryption / Hashing

| What you want to do | Reference guide |
|---|---|
| One-way password hashing (SHA-256, salted by default) | [encryptutils-guide.en.md](references/fico-fwk-core/encryptutils-guide.en.md) `encrypt()` |
| SHA-256 with explicit salt / case options | [encryptutils-guide.en.md](references/fico-fwk-core/encryptutils-guide.en.md) `encryptSha256()` |
| Two-way encryption of sensitive data (AES-256-GCM) | [encryptutils-guide.en.md](references/fico-fwk-core/encryptutils-guide.en.md) `encryptAES()` / `decryptAES()` |
| Generate a unique numeric ID (Blake2b, fixed width) | [encryptutils-guide.en.md](references/fico-fwk-core/encryptutils-guide.en.md) `encryptNumberByBlake2b()` |

### Compression

| What you want to do | Reference guide |
|---|---|
| LZO compression / decompression of strings (large message transport) | [compressionutils-guide.en.md](references/fico-fwk-core/compressionutils-guide.en.md) |

### Spring / Scope / Bean

| What you want to do | Reference guide |
|---|---|
| Dynamically look up a Spring bean when `@Autowired` injection is not possible | [beanutils-guide.en.md](references/fico-fwk-core/beanutils-guide.en.md) |
| HTTP request / thread-scope attribute store (`getAttribute`, `setAttribute`, `removeAttribute`, `removeAllAttribute`) | [requestscopeutils-guide.en.md](references/fico-fwk-core/requestscopeutils-guide.en.md) |
| Direct access to `HttpServletRequest` | [requestscopeutils-guide.en.md](references/fico-fwk-core/requestscopeutils-guide.en.md) `getServletRequestAttributes()` |

### Common Response / Message / GUID

| What you want to do | Reference guide |
|---|---|
| **Construct a JSON response (`CommonResponse`)** — data / header copy / paging meta | [commonutils-guide.en.md](references/fico-fwk-extension/commonutils-guide.en.md) `createCommonResponse(...)` |
| Set success / error message on a JSON response (or pre-set into RequestScope) | [commonutils-guide.en.md](references/fico-fwk-extension/commonutils-guide.en.md) `setResponseMessage(...)` |
| Generate a distributed-tracing GUID / TraceId (3-digit prefix + 17-digit timestamp + 12-digit random) | [commonutils-guide.en.md](references/fico-fwk-extension/commonutils-guide.en.md) `generateGuid(prefix)` |
| Resolve message code → text in current locale (`COM_MSG` table) | [messageutils-guide.en.md](references/fico-fwk-extension/messageutils-guide.en.md) `getMessage(code, args)` |
| Resolve message code → text in an explicit locale (batch / admin / …) | [messageutils-guide.en.md](references/fico-fwk-extension/messageutils-guide.en.md) `getMessage(code, locale, args)` |

### PB Fixed-Length Response / Environment (PB-Specific)

| What you want to do | Reference guide |
|---|---|
| **Convert exception to PB fixed-length error response (`PBResponse`)** (`CommonException` / generic `Exception` → 4-digit msgCode + VarMsg) | [pbcommonutils-guide.en.md](references/framework-site-ext/pbcommonutils-guide.en.md) `createErrorResponse(...)` |
| Pre-set a custom success message into RequestScope for PB responses | [pbcommonutils-guide.en.md](references/framework-site-ext/pbcommonutils-guide.en.md) `setResponseMessage(msgCode, args)` |
| Store / retrieve the account number that should be auto-attached to transaction logs | [pbcommonutils-guide.en.md](references/framework-site-ext/pbcommonutils-guide.en.md) `setAccountNo()` / `getAccountNo()` |
| Resolve message code → VarMsg (byte-cut to the current request's charset) | [pbcommonutils-guide.en.md](references/framework-site-ext/pbcommonutils-guide.en.md) `resolveVarMsg()` |
| Byte length of a string under the current request's charset | [pbcommonutils-guide.en.md](references/framework-site-ext/pbcommonutils-guide.en.md) `getVarMsgByteLength()` |
| Online vs. batch detection (presence of a request context) | [pbcommonutils-guide.en.md](references/framework-site-ext/pbcommonutils-guide.en.md) `isOnline()` / `getOnlineEnvFlag()` |
| Prod vs. dev detection (Spring profile starts with `prod`) | [pbcommonutils-guide.en.md](references/framework-site-ext/pbcommonutils-guide.en.md) `isProduct()` / `isDevelop()` |
| HTS self-account verification flag, firm number (`firmNo`) | [pbcommonutils-guide.en.md](references/framework-site-ext/pbcommonutils-guide.en.md) `getHtsAcntVerifyTp()` / `getFirmNo()` / `getFirmNum()` |

## Common Anti-Patterns

Easy to hand-write, but a Util already exists — **do not roll your own**:

- `str == null || str.isEmpty()` → `StringUtils.isEmpty(str)`
- `String.format("%,d", amount)` / hand-rolled comma formatting → `StringUtils.setComma(...)` / `longToComma(...)`
- Hand-rolled `substring` to star out account / SSN / card numbers → `StringUtils.masking(...)` / `automaskingView(...)`
- `new SimpleDateFormat("yyyyMMdd").format(new Date())` → `DateUtils.getCurrentDate()` and friends
- Manually computing the gap between two dates → `DateUtils.getDaysBetween(...)` / `getMonthsBetween(...)`
- Field-by-field `setXxx` copy between DTO and Entity → `MapperUtils.convert(...)`
- Manual snake_case-Map → VO transcription → `MapperUtils.convertFromUnderscoreToCamel(...)`
- Direct `MessageDigest.getInstance("SHA-256")` → `EncryptUtils.encrypt(...)` / `encryptSha256(...)`
- Hand-rolled AES → `EncryptUtils.encryptAES(...)` / `decryptAES(...)`
- `UUID.randomUUID()` for transaction tracing → `CommonUtils.generateGuid(prefix)` (OpenTelemetry-compatible 32-byte HEX)
- Hand-constructed response object → `CommonUtils.createCommonResponse(...)` or `PBCommonUtils.createErrorResponse(...)`
- Hard-coded message text → `MessageUtils.getMessage(code, args)` (i18n + `COM_MSG`)
- Parsing `System.getProperty("spring.profiles.active")` → `PBCommonUtils.isProduct()` / `isDevelop()`
- Hard-coding the max size of a VO List field → `PBCommonUtils.getMaxSize(vo, "fieldName")` (driven by `@FixedList(size)`)

## Call-Site Caveats

- **Every method is `static`** — never instantiate. Call via the class name directly.
- **Exceptions are wrapped in `CommonException`** — most internal `RuntimeException`s are re-thrown as `CommonException`. Account for that in your `catch`.
- **Check overload differences carefully** — methods with the same name often behave very differently depending on arguments (e.g. `StringUtils.compareString` has options for case-insensitive comparison and comparison length). Don't guess — read the guide section and pick deliberately.
- **Encoding context** — fixed-length, masking, and padding methods handle EUC-KR vs. UTF-8 multi-byte differently. When you need legacy fixed-length compatibility, explicitly select the EUC-KR variants (`getEucKrPadding`, `ecdUtfToEucKr`, …). The String guide explicitly calls out which "length" each function uses (character count vs. UTF-8 bytes vs. EUC-KR bytes) — read that note before choosing.
- **RequestScope dependency** — `RequestScopeUtils`, `PBCommonUtils.setAccountNo` / `setResponseMessage`, and `MessageUtils` (via `LocaleContextHolder`) behave differently or throw when there is no HTTP request context. In batch / daemon code, branch on `PBCommonUtils.isOnline()`.
- **`FormatterUtils.setXxx` is global** — those setters mutate JVM-wide state. Do not invoke them from business code; only from application bootstrap / configuration.

## Worked Example

If the user says "calculate the customer's western age and put it in the response":

1. **Intent**: age calculation → date category.
2. **Open the guide**: [dateutils-guide.en.md](references/fico-fwk-core/dateutils-guide.en.md). Read the top of the file to see the Situational Function Selection Guide. Find the row for "calculate (western) age from birth year/month/day" — it points to `getAge`.
3. **Jump to the anchor section** for `getAge` in the same guide and confirm the exact signature: `getAge(int birthYear, int month, int day)` — returns western age. Note the doc's "Behavior on edge cases" notes (e.g., what if today is before the birthday this year — the guide will tell you whether the Util handles that itself).
4. **Call site**:
   ```java
   import kr.co.openlabs.fico.framework.utils.DateUtils;
   ...
   int age = DateUtils.getAge(customer.getBirthYear(), customer.getBirthMonth(), customer.getBirthDay());
   ```
5. **Response wrapping**: for a standard JSON response, follow [commonutils-guide.en.md](references/fico-fwk-extension/commonutils-guide.en.md) `createCommonResponse(request, data)`; for a PB fixed-length message, put the value on the appropriate domain VO and return that.

Always follow this flow: **identify the category → open the matching guide → use its Situational table → confirm the signature in the function's anchor section → call with the exact signature**.
