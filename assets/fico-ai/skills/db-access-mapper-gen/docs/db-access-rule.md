# FICO Framework Database Access Layer Guide

## Core Principles

**🚨 Absolute Rule: All Mapper methods must use DTO classes only (No Exceptions)**

- Primitive and wrapper types (`String`, `Integer`, `Long`) are strictly prohibited in input parameters
- `@Param` annotation is strictly prohibited
- `Map<String, Object>` type is strictly prohibited
- **Even single parameters must be wrapped in DTO classes**

---

## 1. Mapper Interface Rules

### Class Annotation Rule

**🚨 Required: `@Mapper` annotation is mandatory on all Mapper interfaces**

```
❌ Missing @Mapper annotation
✅ @Mapper annotation must be present on every Mapper interface
```

### Parameter Rules

**Prohibited parameter types:**
```
❌ String, Integer, Long   → Primitive/wrapper types are not allowed; must use a DTO class
❌ @Param("key")           → @Param annotation is prohibited; wrap all parameters in a single DTO class
❌ Map<String, Object>     → Map type is prohibited; use typed DTO classes
```

**Required pattern:**
```
✅ {MethodName}Parameter   → Even single parameters must be wrapped in a DTO class
```

### Return Type Rules

#### Allowed Return Types by Query Type

| Query Type | Allowed Return Types | Description |
|------------|---------------------|-------------|
| SELECT (Single row) | `{SQL_ID}Result` | Must use a dedicated Result DTO class |
| SELECT (Multiple rows) | `List<{SQL_ID}Result>` | Must use `List` of Result DTO class |
| COUNT | `Long` | Numeric return type allowed |
| INSERT | `void` or `Integer` | Row count or no return |
| UPDATE | `Integer` | Affected row count |
| DELETE | `Integer` | Affected row count |

#### Prohibited Return Types

```
❌ Map<String, Object>  → Map type is prohibited as return type
❌ String, Integer, Long → Primitive/wrapper types are prohibited as return type; must use Result DTO
```

#### Correct Return Type Examples

```
SELECT (Single row)  → {MethodName}Result
SELECT (Multiple)    → List<{MethodName}Result>
COUNT                → Long
INSERT               → Integer
UPDATE               → Integer
DELETE               → Integer
```

---

## 2. Mapper DTO Class Rules

### Package Location

**🚨 Required: Must be created in `model.dto` package under the module**

```
{module}/src/main/java/{base-package}/{module}/model/
├── vo/                           # ❌ No Mapper DTO (Business VO only: In/Out classes)
└── dto/                          # ✅ Mapper DTO dedicated package (Parameter/Result classes)
    ├── {MethodName}Parameter.java
    ├── {MethodName}Result.java
    └── ...
```

- `{module}`: Project module name (e.g., online, daemon, batch, bsm)
- `{base-package}`: Project-specific base package path
- **Key point**: Mapper DTOs must always reside under `{module}/model/dto`, regardless of the project's base package
---

## 3. MyBatis XML Rules

### Query Writing Rules

- **CDATA Required**: All SQL must be written inside `<![CDATA[...]]>` block
- **Comment Required**: `/* Query description */`
- **Case Convention**: SQL keywords in uppercase, tables/columns in lowercase snake_case
- **Parameter Binding**: Use `#{paramName}` format

---

## 4. Method Naming Conventions

### General Rules

1. **Method names must clearly indicate the return type**
2. **Use consistent patterns across the entire codebase**
3. **Avoid naming conflicts between List and Single return methods**

### Naming Patterns by Operation

| Operation | Return Type | Naming Pattern |
|-----------|-------------|----------------|
| SELECT (Multiple) | `List<T>` | `{verb}{Entity}s` or `{verb}{Entity}List` |
| SELECT (Single) | `T` | `{verb}{Entity}One` or `{verb}{Entity}By{Key}` |
| INSERT | `Integer` | `insert{Entity}` |
| UPDATE | `Integer` | `update{Entity}` |
| DELETE | `Integer` | `delete{Entity}` |
| COUNT | `Long` | `count{Entity}s` |

### List Return Methods (SELECT queries returning multiple rows)

- **Rule**: Method name must use **plural form** or **`List` suffix** to clearly indicate multiple rows
- **Pattern**: `select{Entity}s(...)` or `select{Entity}List(...)`

  ```
  ✅ select{Entity}s         → plural form (preferred)
  ✅ select{Entity}List      → List suffix (alternative)
  ❌ select{Entity}          → singular form is ambiguous, may conflict with single-return methods
  ```

  > `{Entity}` is a placeholder for the actual entity name (e.g., if entity is `Order`, method becomes `selectOrders`)

### Single Return Methods (SELECT queries returning one row)

- **Rule**: Method name must use **singular form** with an explicit suffix: `One`, `Single`, `ById`, or `By{Key}`
- **Pattern**: `select{Entity}One(...)` or `select{Entity}By{Key}(...)`

  ```
  ✅ select{Entity}One       → explicit single-row suffix (recommended)
  ✅ select{Entity}By{Key}   → suffix indicates lookup by specific key
  ❌ select{Entity}          → ambiguous, unclear whether it returns one or many
  ```

### Avoiding Name Conflicts

When both List and Single methods exist for the same entity, their names **must be clearly distinct**:

```
✅ Correct - Names are unambiguous:
   select{Entity}s(...)       → returns List
   select{Entity}One(...)     → returns single object

❌ Wrong - Same name causes compilation error (method signature conflict):
   select{Entity}(...)        → returns List
   select{Entity}(...)        → returns single object
```

---

**Document Version**: 1.2
**Last Updated**: 2026.04.06
