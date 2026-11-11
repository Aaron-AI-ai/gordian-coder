# UPDATE Verification

- [ ] Return type is `Integer` (NOT `void`, NOT `int`, NOT any other type)
- [ ] Method name uses `update` prefix (NOT `modify`, `change`, `edit`)
- [ ] When WHERE clause has specific condition (non-PK), `By{Condition}` suffix is applied
- [ ] Parameter DTO name follows `Update{Entity}Parameter` or `Update{Entity}By{Condition}Parameter` pattern
- [ ] XML uses `<update>` tag (NOT `<select>`, `<insert>`, `<delete>`)
- [ ] XML has `parameterType` attribute (NOT `resultType`)
- [ ] WHERE clause exists in SQL (to prevent mass updates)
- [ ] UPDATE SQL has proper SET clause with column assignments

```
✅ Integer update{Entity}(Update{Entity}Parameter param)
✅ Integer update{Entity}By{Condition}(Update{Entity}By{Condition}Parameter param)

❌ void update{Entity}(...)       → return type must be Integer
❌ Integer modify{Entity}(...)    → prefix must be "update"
❌ Integer change{Entity}(...)    → prefix must be "update"
```
