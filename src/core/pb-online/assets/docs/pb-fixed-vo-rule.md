# Controller VO Class Design Rules

## Core Principles
These VO classes support fixed-length data formatting using the `@FixedData` annotation.

## Naming Convention

### Class Names
- **Input VO**: `{ServiceId}In.java`
- **Output VO**: `{ServiceId}Out.java`

### Package Location
- All VO classes must be placed under the `model.vo` subpackage of your project's base package

## Class Structure

### `Inner` Wrapper Structure (REQUIRED)

Every In/Out VO wraps all of its business fields in a `@FixedVo` static class named `Inner`.
The PB fixed-text protocol prefixes every block with a 5-digit record count (e.g. `00001`);
the framework emits that count for each `@FixedVo` block, so the outer class carries nothing but `inner`.

```java
@Data
@NoArgsConstructor
@Schema(description = "{ServiceKoreanName} 요청/응답")
public class {ServiceId}In {

    @FixedVo
    private Inner inner;

    @Data
    @Builder
    @AllArgsConstructor
    @NoArgsConstructor
    public static class Inner {
        // all fields from the API spec go here
    }
}
```

- Outer class: `@Data` + `@NoArgsConstructor` + `@Schema` only (NO `@Builder`, NO `@AllArgsConstructor`)
- Outer class has exactly one field: `@FixedVo private Inner inner;` (no `@Schema` on this field)
- `Inner`: `@Data` + `@Builder` + `@AllArgsConstructor` + `@NoArgsConstructor`, no class-level `@Schema`
- Every field from the API spec (PLAIN / OBJECT / LIST) is declared inside `Inner`, never on the outer class
- Service code reads input via `param.getInner().getXxx()` and builds output via
  `new {ServiceId}Out()` + `result.setInner({ServiceId}Out.Inner.builder()...build())`

#### Fixed Data Annotation
- `@FixedData`: Used to define fixed-length field formatting for legacy system integration
- Import: `import kr.co.openlabs.fico.framework.internal.annotations.FixedData;`
- Import: `import kr.co.openlabs.fico.framework.internal.annotations.FixedData.PAD_TYPE;`
- Import: `import kr.co.openlabs.fico.framework.internal.annotations.FixedVo;` (always, for `Inner`)

### Class JavaDoc
```java
/**
 * {ServiceKoreanName} Input/Output VO
 *
 * @author FICO AI
 * @since {YYYY.MM.DD}
 */
```

### Field Rules

- Use camelCase for field names
- Every field MUST have `@Schema(description = "...")` with Korean description
- `@FixedData` annotation is **mandatory** for all PLAIN type fields
- All annotation values **must be set according to the API spec retrieved from fico-mcp**

## fico-mcp / fico-webadmin I/O Spec to VO Class (Fixed Data Format)

This section defines the rules for converting I/O specifications retrieved from fico-mcp or fico-webadmin resources into Java VO classes with Fixed Data Format annotations.

### JSON to Java Code Mapping

| JSON Field | Purpose | Java Code Mapping | Notes |
|---|---|---|---|
| `fieldName` | Field name | Variable name + `@Schema(description = "{Description}")` | Use camelCase as-is |
| `description` | Field description | `@Schema(description = "{Description}")` | If absent, use `fieldName` as description |
| `dataType` | Data type | Java type (see Data Type Mapping below) | |
| `type` | Field category | PLAIN → `@FixedData`, OBJECT → `@FixedVo`, LIST → `@FixedList` | If `type` is absent, treat as PLAIN |
| `length` | Fixed length | `@FixedData(length = {Length})` | Required for PLAIN type |
| `padType` | Padding direction | `PAD_TYPE.RIGHT` or `PAD_TYPE.LEFT` | JSON `"RIGHT"` → `PAD_TYPE.RIGHT`, `"LEFT"` → `PAD_TYPE.LEFT` |
| `padChar` | Padding character | `padChar = '{PadChar}'` | JSON string → Java char (`"0"` → `'0'`, `" "` → `' '`) |
| `objectTypeRefName` | Nested class name | `public static class {ServiceId}{ObjectTypeRefName}` | Capitalize first letter; if absent, use capitalized `fieldName`. MUST be static inner class, NOT separate file |
| `size` | List max count | `@FixedList(size = {Size})` | Required for LIST type |
| `properties` | Nested fields | Inner class fields | Recursively apply same mapping rules |

### Data Type Mapping

| JSON `dataType` | Java Type |
|-----------------|-----------|
| `java.lang.String` | `String` |
| `java.lang.Integer` | `Integer` |
| `java.lang.Long` | `Long` |
| `java.lang.Double` | `Double` |
| `java.lang.Float` | `Float` |
| `java.lang.Boolean` | `Boolean` |
| `java.math.BigInteger` | `BigInteger` |
| `java.math.BigDecimal` | `BigDecimal` |
| `java.sql.Timestamp` | `Timestamp` |
| `[B` | `byte[]` |

### Field Type Annotation Rules

#### PLAIN Type

```java
@Schema(description = "{FieldName}")
@FixedData(length = {Length}, padType = PAD_TYPE.{PadType}, padChar = '{PadChar}')
private {JavaType} {FieldName};
```

#### OBJECT Type

```java
@Schema(description = "{FieldName}")
@FixedVo
private {ServiceId}{FieldName} {FieldName};
```

- Use `@FixedVo` instead of `@FixedData` (no `length`, `padType`, `padChar`)
- Requires a **static inner class** inside the parent VO

#### LIST Type

```java
@Schema(description = "{FieldName}")
@FixedList(size = {Size})
private List<{ServiceId}{FieldName}> {FieldName};
```

- Use `@FixedList` with `size` attribute
- Generic type specifies the inner class for list items

### Nested (Inner) Class Rules

> **CRITICAL: All nested types MUST be generated as static inner classes, NOT as separate files.**

- **OBJECT** or **OBJECT inside LIST** MUST be generated as a **static inner class** within the parent VO class (sibling of `Inner`, not inside it)
- **DO NOT create separate `.java` files** for nested object types
- Nested classes are NOT named `Inner` — that name is reserved for the wrapper

### Naming Rules

| Element | Rule |
|---------|------|
| Main Class Name | `{ServiceId}In`, `{ServiceId}Out` |
| Wrapper Class Name | `Inner` (fixed name, one per VO) |
| Nested Class Name (OBJECT/LIST item) | `{ServiceId}{ObjectTypeRefName}` (fallback: `{ServiceId}{FieldName}`) |
| Field Name | Use `fieldName` value as-is (maintain camelCase) |
| Nested Class Location | **MUST be a static inner class of the top-level VO** |
