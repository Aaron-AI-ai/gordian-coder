# DELETE Verification

- [ ] Return type is `Integer` (NOT `void`, NOT `int`, NOT any other type)
- [ ] Method name uses `delete` prefix (NOT `remove`, `erase`, `drop`)
- [ ] When WHERE clause has specific condition (non-PK), `By{Condition}` suffix is applied
- [ ] Parameter DTO name follows `Delete{Entity}Parameter` or `Delete{Entity}By{Condition}Parameter` pattern
- [ ] XML uses `<delete>` tag (NOT `<select>`, `<insert>`, `<update>`)
- [ ] XML has `parameterType` attribute (NOT `resultType`)
- [ ] WHERE clause exists in SQL (to prevent mass deletions)
- [ ] DELETE SQL uses proper `DELETE FROM` syntax

```
✅ Integer delete{Entity}(Delete{Entity}Parameter param)
✅ Integer delete{Entity}By{Condition}(Delete{Entity}By{Condition}Parameter param)

❌ void delete{Entity}(...)       → return type must be Integer
❌ Integer remove{Entity}(...)    → prefix must be "delete"
❌ Integer erase{Entity}(...)     → prefix must be "delete"
```
