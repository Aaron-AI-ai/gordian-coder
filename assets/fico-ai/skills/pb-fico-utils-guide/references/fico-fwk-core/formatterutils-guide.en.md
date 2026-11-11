# FormatterUtils User Guide

## Overview

`FormatterUtils` is a common utility class provided by the FICO framework.
It serializes Java objects to fixed-length strings and parses fixed-length strings back into objects, driven by `@FixedData` / `@FixedVo` / `@FixedList` annotations on VO classes.

- Package: `kr.co.openlabs.fico.framework.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.openlabs.fico.framework.utils.FormatterUtils;
import kr.co.openlabs.fico.framework.utils.FormatterUtils.LengthCheck;
import kr.co.openlabs.fico.framework.utils.FormatterUtils.ReplaceAndTrimWhenParseOptions;
```

> ⚠️ Annotated VO fields drive the layout. Use `@FixedData` for primitive/string fields, `@FixedVo` for nested VOs, and `@FixedList` (with `size` or `sizeRef`) for repeating groups.

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. Object → fixed-length string (serialize)

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Convert an annotated VO into a fixed-length string with the default encoding" | [`getFixedData(Object obj)`](#getfixeddataobject-obj) |
| "Convert an annotated VO into a fixed-length string with a specific encoding (UTF-8 / EUC-KR …)" | [`getFixedData(Object obj, String encoding)`](#getfixeddataobject-obj-string-encoding) |
| "Convert a single primitive/string field into a fixed-length token using `FixedFieldData`" | [`getFixedDataString`](#getfixeddatastringfixedfielddata-fielddata) |

### B. Fixed-length string → object (parse)

| Situation | Function |
|-----------|----------|
| "Parse a fixed-length string into a VO" | [`getFixedData(String fld, Class<T>)`](#getfixeddatastring-fld-classt-objecttype) |
| "Parse a fixed-length string but skip the byte-length check (allow undersize)" | [`getFixedData(... LengthCheck)`](#length-check-overloads) |
| "Parse a fixed-length string and decide whether the BigDecimal sign character (`+`/`-`) is included in the slot width" | [`getFixedData(... boolean includeSigned)`](#getfixeddatastring-fld-classt-objecttype-boolean-includesigned) |
| "Parse a generic VO such as `PBRequest<SonaQ002In>` — supply the inner generic type explicitly" | [`getFixedData(... Class<?> genericType)`](#getfixeddatastring-fld-classt-objecttype-class-generictype) |
| "Parse with explicit encoding + generic type" | [`getFixedData(... String encoding, Class<?> genericType)`](#getfixeddatastring-fld-classt-objecttype-string-encoding-class-generictype) |

### C. Parse error retrieval

| Situation | Function |
|-----------|----------|
| "Inspect length-mismatch / per-field cast errors collected during the last parse" | [`getErrorDataMap`](#geterrordatamap) |

### D. Object size lookup

| Situation | Function |
|-----------|----------|
| "Compute the maximum byte length a VO type can reach (returns `Integer.MAX_VALUE` if it contains a `FixedList`)" | [`getObjectMaxLength`](#getobjectmaxlengthclasst-objecttype-class-generictype) |

### E. Global behaviour switches (typically called from framework configuration)

| Situation | Function |
|-----------|----------|
| "Change the default character encoding for the parser/serializer" | [`setDefaultCharEncoding`](#setdefaultcharencodingstring-encoding) |
| "Decide whether parsing errors throw or are silently recorded in the error map" | [`setDataParsingThrowException`](#setdataparsingthrowexceptionboolean-dataparsingthrowexception) |
| "Strip padding characters when populating fields during parse" | [`setTrimPaddingCharacters`](#settrimpaddingcharactersboolean-trimpaddingcharacters) |
| "Allow oversize data to be truncated to the slot length instead of throwing" | [`setCutOversizeData`](#setcutoversizedataboolean-cutoversizedata) |
| "Trim values before padding when the pad character is not space" | [`setTrimBeforePadding`](#settrimbeforepaddingboolean-trimbeforepadding) |
| "On parse, replace full-width spaces and trim (handy when upstream uses EUC-KR full-width)" | [`setReplaceAndTrimWhenParse`](#setreplaceandtrimwhenparsereplaceandtrimwhenparseoptions-replaceandtrimwhenparse) |

> 💡 **What is NOT in FormatterUtils' scope?** JSON/XML serialization, schema-less mapping, DB I/O, and runtime annotation modification are not the role of this utility.

---

## 1. Serialize (Object → Fixed-Length String)

### `getFixedData(Object obj)`

Converts an annotated VO into a fixed-length string using the default encoding (set via [`setDefaultCharEncoding`](#setdefaultcharencodingstring-encoding)).

```java
String fld = FormatterUtils.getFixedData(fixedDataTestInfo);
// e.g.
// "0000001654000003432300001233.000000012.20000000003000000001200004334.0000123.2340000001234            ZZZABC"
```

| Parameter | Description |
|-----------|-------------|
| `obj` | Annotated VO instance |

| Returns | Description |
|---------|-------------|
| `String` | Fixed-length string |

---

### `getFixedData(Object obj, String encoding)`

Same as above but with an explicit encoding.

```java
String fld = FormatterUtils.getFixedData(fixedDataTestInfo, "UTF-8");
```

| Parameter | Description |
|-----------|-------------|
| `obj`      | Annotated VO instance |
| `encoding` | Charset name (e.g., `"UTF-8"`, `"EUC-KR"`) |

| Returns | Description |
|---------|-------------|
| `String` | Fixed-length string |

---

### `getFixedDataString(FixedFieldData fieldData)`

Converts a single primitive/string value into a fixed-length token, padded according to `FixedFieldData` instructions. The 2-arg overload accepts an explicit encoding.

```java
FixedFieldData fieldData = FixedFieldData.builder()
        .dataType("java.lang.Integer")
        .length(10)
        .padChar('0')
        .padType(PAD_TYPE.RIGHT)
        .value("0")
        .build();
String token = FormatterUtils.getFixedDataString(fieldData);   // "0000000000"
```

| Parameter | Description |
|-----------|-------------|
| `fieldData` | Field descriptor (data type, length, pad character, pad direction, value) |
| `encoding`  | (optional) Charset name |

| Returns | Description |
|---------|-------------|
| `String` | Fixed-length token |

---

## 2. Parse (Fixed-Length String → Object)

### `getFixedData(String fld, Class<T> objectType)`

Parses `fld` into an instance of `objectType`. Performs a max-byte-length check against the VO definition (unless it contains a `FixedList`).

```java
FixedDataTestInfo converted =
        FormatterUtils.getFixedData(fixedString, FixedDataTestInfo.class);
```

| Parameter | Description |
|-----------|-------------|
| `fld`        | Fixed-length string to parse |
| `objectType` | Target VO type |

| Returns | Description |
|---------|-------------|
| `T` | Parsed VO instance |

---

### `getFixedData(String fld, Class<T> objectType, boolean includeSigned)`

Adds control over whether the BigDecimal sign character (`+` / `-`) is considered part of the slot length.

```java
FixedDataTestInfo converted =
        FormatterUtils.getFixedData(fixedString, FixedDataTestInfo.class, false);
```

| Parameter | Description |
|-----------|-------------|
| `fld`           | Fixed-length string |
| `objectType`    | Target VO type |
| `includeSigned` | `true` = the slot width already includes the sign; `false` = the parser will absorb the sign separately |

| Returns | Description |
|---------|-------------|
| `T` | Parsed VO instance |

---

### `getFixedData(String fld, Class<T> objectType, Class<?> genericType)`

For generic VOs (e.g., `PBRequest<InnerMessage>`), pass the inner type explicitly because of Java type erasure.

```java
GenericMessage<InnerMessage> converted =
        FormatterUtils.getFixedData(message, GenericMessage.class, InnerMessage.class);
```

| Parameter | Description |
|-----------|-------------|
| `fld`         | Fixed-length string |
| `objectType`  | Target generic VO type |
| `genericType` | Actual type used for the generic parameter |

| Returns | Description |
|---------|-------------|
| `T` | Parsed VO instance |

---

### `getFixedData(String fld, Class<T> objectType, String encoding, Class<?> genericType)`

Generic-type variant with explicit encoding.

```java
GenericMessage<InnerMessage> converted =
        FormatterUtils.getFixedData(message, GenericMessage.class, "UTF-8", InnerMessage.class);
```

| Parameter | Description |
|-----------|-------------|
| `fld`         | Fixed-length string |
| `objectType`  | Target VO type |
| `encoding`    | Charset name |
| `genericType` | Generic parameter type |

| Returns | Description |
|---------|-------------|
| `T` | Parsed VO instance |

---

### Length-check overloads

These variants accept a `LengthCheck` enum (`CHECK` = default, `NO_CHECK` = skip the byte-length comparison). Use `NO_CHECK` when the input may be shorter than the VO defines.

```java
FormatterUtils.getFixedData(fld, MyVo.class, LengthCheck.NO_CHECK);
FormatterUtils.getFixedData(fld, MyVo.class, true, LengthCheck.NO_CHECK);
FormatterUtils.getFixedData(fld, MyVo.class, InnerType.class, LengthCheck.NO_CHECK);
FormatterUtils.getFixedData(fld, MyVo.class, "UTF-8", InnerType.class, LengthCheck.NO_CHECK);
```

| `LengthCheck` value | Meaning |
|---------------------|---------|
| `CHECK`    | Default. Compare input byte length vs. VO max length; over/under recorded into error map; oversize may throw. |
| `NO_CHECK` | Skip the length comparison entirely. Parse only what the VO defines. |

---

## 3. Parse Error Retrieval

### `getErrorDataMap()`

Returns the map of errors recorded during the most recent parse (kept in the current thread).

Special key `FORMATTER_LENGTH_ERROR`:
- `OVERSIZE:{inputBytes}/{vo size}` — input was longer than the VO max length
- `UNDERSIZE:{inputBytes}/{vo size}` — input was shorter than the VO max length

Per-field entries are stored under each field's name; nested VOs hold their own `LinkedHashMap`, and lists hold a `List<LinkedHashMap>`.

```java
Map<String, Object> errors = FormatterUtils.getErrorDataMap();
```

| Returns | Description |
|---------|-------------|
| `Map<String, Object>` | Error map from the last parse |

---

## 4. Object Size Lookup

### `getObjectMaxLength(Class<T> objectType, Class<?> genericType)`

Computes the maximum byte length that `objectType` can produce. Returns `Integer.MAX_VALUE` if the VO contains a `FixedList` (variable size) or a multi-depth nested structure.

```java
FormatterUtils.getObjectMaxLength(FixedDataTestInfo.class, null);   // 110
```

| Parameter | Description |
|-----------|-------------|
| `objectType`  | VO type |
| `genericType` | Generic parameter type (or `null`) |

| Returns | Description |
|---------|-------------|
| `Integer` | Max byte length, or `Integer.MAX_VALUE` if unbounded |

---

## 5. Global Behaviour Switches

> These setters affect every subsequent serialize/parse call across the JVM. Typically wired from framework configuration; calling them ad-hoc from business code is **discouraged**.

### `setDefaultCharEncoding(String encoding)`

Sets the default character encoding used when an overload without an explicit `encoding` is called. Kept in sync with the `formatter.charset` property.

```java
FormatterUtils.setDefaultCharEncoding("EUC-KR");
```

| Parameter | Description |
|-----------|-------------|
| `encoding` | Charset name (e.g., `"UTF-8"`, `"EUC-KR"`) |

---

### `setDataParsingThrowException(boolean dataParsingThrowException)`

When `true` (default), parse errors throw `CommonException`. When `false`, errors are silently captured in the error map and parsing continues.

```java
FormatterUtils.setDataParsingThrowException(false);
```

| Parameter | Description |
|-----------|-------------|
| `dataParsingThrowException` | `true` = throw on error, `false` = record only |

---

### `setTrimPaddingCharacters(boolean trimPaddingCharacters)`

When `true` (default), padding characters are stripped from the field value during parse. When `false`, `String` fields keep the padding bytes as-is.

```java
FormatterUtils.setTrimPaddingCharacters(true);
```

| Parameter | Description |
|-----------|-------------|
| `trimPaddingCharacters` | `true` = trim padding |

---

### `setCutOversizeData(boolean cutOversizeData)`

When `true`, values longer than the declared slot length are truncated to fit. When `false` (default), an exception is thrown.

```java
FormatterUtils.setCutOversizeData(true);
```

| Parameter | Description |
|-----------|-------------|
| `cutOversizeData` | `true` = truncate, `false` = throw |

---

### `setTrimBeforePadding(boolean trimBeforePadding)`

When `true`, values are `trim()`-ed before padding **if** the padding character is not space (`0x20`). Useful when input data contains stray surrounding whitespace.

```java
FormatterUtils.setTrimBeforePadding(true);
```

| Parameter | Description |
|-----------|-------------|
| `trimBeforePadding` | `true` = trim before padding |

---

### `setReplaceAndTrimWhenParse(ReplaceAndTrimWhenParseOptions replaceAndTrimWhenParse)`

Adds post-processing to parsed values:

| Option | Behaviour |
|--------|-----------|
| `NONE`             | No extra processing |
| `REPLACE_AND_TRIM` | Replace full-width spaces (`0xA1 0xA1` / `U+3000`) with normal spaces, then trim |
| `TRIM`             | Trim only |

```java
FormatterUtils.setReplaceAndTrimWhenParse(
        FormatterUtils.ReplaceAndTrimWhenParseOptions.REPLACE_AND_TRIM);
```

| Parameter | Description |
|-----------|-------------|
| `replaceAndTrimWhenParse` | Post-processing option |

---

## 6. Public Constants

These keys are used to look up entries in the error map returned by [`getErrorDataMap`](#geterrordatamap).

| Constant | Value | Description |
|----------|-------|-------------|
| `FormatterUtils.FORMATTER_ERROR_DATA`      | `"FORMATTER_ERROR_DATA"` | Thread-local key under which the error data map is stored (read via `ThreadRepository.get`) |
| `FormatterUtils.FORMATTER_LENGTH_ERROR`    | `"FORMATTER_LENGTH_ERROR"` | Key set in the error map when input byte length and VO max length differ |
| `FormatterUtils.FORMATTER_LENGTH_OVERSIZE` | `"OVERSIZE"` | Prefix used inside the `FORMATTER_LENGTH_ERROR` value when input exceeds VO size |
| `FormatterUtils.FORMATTER_LENGTH_UNDERSIZE`| `"UNDERSIZE"` | Prefix used inside the `FORMATTER_LENGTH_ERROR` value when input is shorter than VO size |

```java
Map<String, Object> errors = FormatterUtils.getErrorDataMap();
String lengthErr = (String) errors.get(FormatterUtils.FORMATTER_LENGTH_ERROR);
// lengthErr might look like "OVERSIZE:120/110" or "UNDERSIZE:100/110"
if (lengthErr != null && lengthErr.startsWith(FormatterUtils.FORMATTER_LENGTH_OVERSIZE)) {
    // handle oversize
}
```
