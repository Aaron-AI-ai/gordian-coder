# SQL Generation Rules - Performance and Security Guidelines

## 1. Performance Rules

### 1.1 SELECT Optimization
- **Prohibit `SELECT *`** → Explicitly list only required columns
- **Avoid unnecessary DISTINCT usage**

### 1.2 JOIN Optimization
- **Select appropriate JOIN type** (INNER vs OUTER)
- **Prefer JOIN over subqueries** (optimizer efficiency)

### 1.3 Other Performance Considerations
- **Prohibit excessive values in IN clause** (use temporary table for 1000+ values)
- **Consider UNION ALL instead of OR conditions**
- **EXISTS vs IN**: Prefer EXISTS for large datasets

---

## 2. Security Rules

### 2.1 SQL Injection Prevention
- **Mandatory PreparedStatement/parameter binding** instead of dynamic SQL
- **Prohibit direct concatenation of user input** into query strings
- **MyBatis**: Use `#{}` instead of `${}` (prohibit literal substitution)

### 2.2 Access Control
- **Apply least privilege principle** (access only required tables/columns)
- **Consider masking for sensitive data columns**
- **Prohibit DDL statements** (DROP, TRUNCATE, ALTER) at application level

### 2.3 Data Protection
- **Encrypt sensitive information** (passwords, SSN, etc.) before storage
- **Prohibit logging queries containing sensitive data**
- **Prohibit full table scan without LIMIT/ROWNUM** (data leak prevention)

### 2.4 WHERE Clause Rules
- **SELECT statements MUST include `1=1` condition** in WHERE clause (facilitates dynamic condition addition)
- **UPDATE, DELETE statements MUST NOT use `1=1`** (prevents unintended bulk data modification)

> Reference: [templates/select-where.sql](../templates/select-where.sql) | [templates/update-where.sql](../templates/update-where.sql) | [templates/delete-where.sql](../templates/delete-where.sql)

---

## 3. Additional Recommended Rules

### 3.1 Coding Standards
- **Uppercase SQL keywords** (SELECT, FROM, WHERE, etc.)
- **Use meaningful table aliases**
- **Add comments to explain complex queries**

---

**Document Version**: 1.1
**Last Updated**: 2026.04.02
