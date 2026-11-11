---
name: db-access-mapper-gen
description: 'Generates MyBatis-based DB Access Layer code (Mapper Java interface, Mapper XML, Parameter/Result DTOs) from SQL queries for the FICO framework. TRIGGER when: user asks to generate mapper code, DB access layer code, or MyBatis code from SQL in Korean or English (e.g. "매퍼 코드 생성해줘", "DB 접근 코드 만들어줘", "mapper 코드 생성", "generate mapper from SQL", "MyBatis 코드 생성").'
---

# db-access-mapper-gen

Generates MyBatis-based DB Access Layer mapper code (Java interface, XML, Parameter/Result DTOs) from SQL queries.

When generating mapper code, follow the workflow below.

### Input Requirements
- **SQL Query**: The SQL query to generate mapper code from (SELECT, INSERT, UPDATE, DELETE)
- **Query Type** (auto-detected if not specified): One of the following:
  - `SELECT ONE` — Single row SELECT
  - `SELECT LIST` — Multiple rows SELECT
  - `SELECT PAGING` — Paginated SELECT (FICO Framework paging)
  - `INSERT` — INSERT statement
  - `UPDATE` — UPDATE statement
  - `DELETE` — DELETE statement

## Steps

### 1. Instruction Analysis & Query Type Detection

1. Analyze the user-provided SQL query to determine:
   - The SQL operation type (SELECT / INSERT / UPDATE / DELETE)
   - For SELECT queries, determine the result cardinality:
     - **SELECT ONE**: When query has `LIMIT 1`, selects by primary key, or user explicitly states single row
     - **SELECT PAGING**: When user explicitly requests paging functionality
     - **SELECT LIST**: All other SELECT queries returning multiple rows
2. Display the SQL query and detected query type.
3. **Determine the method name following the naming convention for the detected query type:**

   | Query Type | Prefix | Suffix Rule | Return Type |
   |------------|--------|-------------|-------------|
   | SELECT ONE | `select`/`find` | Singular + `One`/`ById`/`By{Condition}` | `{Result}` |
   | SELECT LIST | `select`/`find` | Plural or `List` suffix + `By{Condition}` | `List<{Result}>` |
   | SELECT PAGING | `select`/`find` | Plural + `By{Condition}` + `Paging` | `List<{Result}>` |
   | INSERT | `insert` | `insert{Entity}` | `Integer` |
   | UPDATE | `update` | `update{Entity}` + `By{Condition}` | `Integer` |
   | DELETE | `delete` | `delete{Entity}` + `By{Condition}` | `Integer` |
4. Display proposed method name to the user for confirmation.
5. If the SQL query is missing or incorrect, ask the user to provide it.

### 2. Read the DB Access Layer Code Rules

1. Read the rule file required for generating DB Access Layer code:
   - `docs/db-access-rule.md`

### 3. Retrieve Code Templates & Examples

1. Reference the template files under `templates/` directory. Select the appropriate templates based on the query type:

   **Java Templates:**

   | Template | When to Use |
   |----------|-------------|
   | `templates/ParameterTemplate.java` | Parameter DTO for all query types |
   | `templates/ResultTemplate.java` | Result DTO |
   | `templates/MapperInterfaceTemplate.java` | Mapper interface for SELECT ONE/LIST, INSERT, UPDATE, DELETE |
   | `templates/MapperInterfacePagingTemplate.java` | Mapper interface for SELECT PAGING (includes `PagingInfo` parameter) |

   **MyBatis XML Templates:**

   | Template | When to Use |
   |----------|-------------|
   | `templates/MapperXmlSelectOneTemplate.xml` | SELECT ONE queries |
   | `templates/MapperXmlSelectListTemplate.xml` | SELECT LIST queries (with `1=1` in WHERE) |
   | `templates/MapperXmlSelectPagingTemplate.xml` | SELECT PAGING queries (no LIMIT/OFFSET) |
   | `templates/MapperXmlInsertTemplate.xml` | INSERT queries |
   | `templates/MapperXmlUpdateTemplate.xml` | UPDATE queries |
   | `templates/MapperXmlDeleteTemplate.xml` | DELETE queries |

### 4. Code Generation

1. Generate code based on the provided rules, templates, and file locations.
2. **Generated files depend on the query type:**

   | Query Type | Generated Files |
   |------------|----------------|
   | SELECT ONE | `{MethodName}Parameter.java`, `{MethodName}Result.java`, `Mapper.java` (method), `Mapper.xml` (SQL mapping) |
   | SELECT LIST | `{MethodName}Parameter.java`, `{MethodName}Result.java`, `Mapper.java` (method), `Mapper.xml` (SQL mapping) |
   | SELECT PAGING | `{MethodName}Parameter.java` (no pagination fields), `{MethodName}Result.java`, `Mapper.java` (method with `PagingInfo`), `Mapper.xml` (SQL mapping, no LIMIT/OFFSET) |
   | INSERT | `{MethodName}Parameter.java`, `Mapper.java` (method), `Mapper.xml` (SQL mapping) |
   | UPDATE | `{MethodName}Parameter.java`, `Mapper.java` (method), `Mapper.xml` (SQL mapping) |
   | DELETE | `{MethodName}Parameter.java`, `Mapper.java` (method), `Mapper.xml` (SQL mapping) |

### 5. Code Verification

1. Read and apply the common verification rules from `docs/db-access-verification-rule.md`.
2. Read and apply the query-type-specific verification rules based on the detected query type:

   | Query Type | Verification Rule File |
   |------------|----------------------|
   | SELECT ONE | `docs/verification-select-one.md` |
   | SELECT LIST | `docs/verification-select-list.md` |
   | SELECT PAGING | `docs/verification-select-paging.md` |
   | INSERT | `docs/verification-insert.md` |
   | UPDATE | `docs/verification-update.md` |
   | DELETE | `docs/verification-delete.md` |

3. Only files modified or created during this operation will be verified.

### 6. Placeholder Replacement Verification

1. **All template placeholders (e.g., `{PackagePath}`, `{MethodName}`, `{CurrentDate}`) must be replaced with actual values.**
2. **Final Validation Checklist:**
   - No `{...}` template placeholders remain in any generated file
   - `{PackagePath}` is replaced with actual project package (e.g., `kr.co.fico.framework.example`)
   - `{CurrentDate}` is replaced with actual date in YYYY-MM-DD format
   - Method name follows the correct naming convention for query type
   - Return type matches query type rules
   - XML tag matches query type (`<select>`, `<insert>`, `<update>`, `<delete>`)
   - XML mapper `id` matches Java method name exactly
   - No naming conflicts with existing methods
   - All import statements are present and use actual package paths