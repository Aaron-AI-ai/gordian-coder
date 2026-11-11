---
name: sql-query-gen
description: 'Generates SQL queries for financial systems built on the FICO framework, based on table schema and business requirements. TRIGGER when: user asks to generate, create, or write SQL queries in Korean or English (e.g. "SQL 쿼리 생성해줘", "쿼리 만들어줘", "SQL 작성해줘", "generate SQL", "write a query").'
---

# sql-query-gen

Generates SQL queries for financial systems built on the FICO framework, based on table schema and business requirements.
This skill ONLY generates SQL queries. It does NOT generate DB Access Layer or Mapper code.

When generating SQL queries, follow the workflow below

### Input Requirements
- **Database Type**: The target database (Oracle or PostgreSQL)
- **Table Name or Business Requirement**: Description of the target table(s) and the desired query logic

## Steps

### 1. Read the SQL Query Generation Rules
1. Read the rule file required for generating SQL queries:
   - `docs/sql-query-rule.md`

### 2. Get Table Schema Info
1. Get table schema information from the FICO MCP server. Use the table names identified from the input requirements as the target table names.
   - Replace `<DB_TYPE>` with the specified database type (`oracle` or `postgresql`).
   - Replace `<TABLE_NAMES>` with the actual target table names.
   - `fico://databases/<DB_TYPE>/tables/<TABLE_NAMES>/info`

### 3. Retrieve SQL Templates
1. Reference the template files under `templates/` directory. Select the appropriate template based on the query type:

| Template | When to Use |
|----------|-------------|
| `templates/select-where.sql` | SELECT queries with WHERE conditions |
| `templates/update-where.sql` | UPDATE queries with WHERE conditions |
| `templates/insert-values.sql` | INSERT queries with VALUES clause |
| `templates/delete-where.sql` | DELETE queries with WHERE conditions |

### 4. SQL Query Generation
1. Generate SQL queries based on the provided rules, schema information, templates, and user requirements.

2. Display the generated SQL queries for user review.

**CRITICAL - RESTRICTIONS:**
- Only display the generated SQL query as text output for user review
- **NEVER write or save the generated SQL to any file** (no write_to_file, create_file, or any file creation tools)
- **NEVER generate Java code** (no DTO, VO, Parameter, Result, Mapper interface, Service, Controller, etc.)
- **NEVER generate XML files** (no MyBatis Mapper XML, etc.)
- Only generate pure SQL query statements (SELECT, INSERT, UPDATE, DELETE)

### 5. SQL Query Verification
1. Read and apply the verification rules from `docs/sql-query-verification-rule.md`.
2. Apply the database-specific verification rules based on the target database type:
   - **Oracle**: Read and apply `docs/sql-query-oracle-verification-rule.md`
   - **PostgreSQL**: Read and apply `docs/sql-query-postgresql-verification-rule.md`
