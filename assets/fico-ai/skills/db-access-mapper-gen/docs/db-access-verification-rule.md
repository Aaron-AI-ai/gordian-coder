# DB Access Layer Code Verification Rules

## 1. Common Verification (All Query Types)

### 1.1 Java Code Structure
- [ ] Java interfaces begin with `public` keyword
- [ ] `@Mapper` annotation is present on the Mapper interface
- [ ] Indentation is 4 spaces (not tabs)
- [ ] Simple class names with imports (not fully qualified names like `java.util.List`)
- [ ] No duplicate import statements
- [ ] No duplicate method declarations in the Mapper interface

### 1.2 DTO Rules
- [ ] All Mapper methods use DTO classes only
- [ ] No primitive/wrapper types (`String`, `Integer`, `Long`) as parameters
- [ ] No `@Param` annotation usage
- [ ] No `Map<String, Object>` type usage
- [ ] Even single parameters are wrapped in DTO classes
- [ ] Parameter DTOs are in `model.dto` package (NOT `model.vo`)
- [ ] Result DTOs are in `model.dto` package (NOT `model.vo`)

### 1.3 MyBatis XML Structure
- [ ] All SQL is written inside `<![CDATA[...]]>` block
- [ ] SQL comment exists: `/* Query description */`
- [ ] SQL keywords in UPPERCASE, tables/columns in lowercase snake_case
- [ ] All parameter placeholders use `#{paramName}` format
- [ ] XML mapper `id` matches Java method name exactly
- [ ] No duplicate SQL mappings in the XML file
- [ ] `namespace` matches the Mapper interface's fully qualified name

### 1.4 Existing Code Preservation
- [ ] All existing methods in the file are still present
- [ ] All existing imports are preserved
- [ ] Only new code (method, imports, SQL mapping) has been added

---

## 2. Prohibited Pattern Search

```bash
# Search for prohibited patterns
grep -r "@Param" src/main/java/**/mapper/
grep -r "Map<String, Object>" src/main/java/**/mapper/

# Check if Mapper DTOs exist in vo package
ls -la src/main/java/**/model/vo/ | grep -E "(Parameter|Result)"

# Check for ambiguous method names (potential naming conflicts)
# List methods without plural form
grep -rE "List<.*> select[A-Z][a-z]+\(" src/main/java/**/mapper/ | grep -v "List\|s("
```
