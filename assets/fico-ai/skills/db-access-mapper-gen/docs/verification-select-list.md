# SELECT LIST Verification

- [ ] Return type is `List<{MethodName}Result>`
- [ ] Return type is NOT a single object
- [ ] Method name uses plural form or `List` suffix
- [ ] When WHERE clause exists, `By{Condition}` suffix is applied
- [ ] XML uses `<select>` tag
- [ ] XML has both `parameterType` and `resultType` attributes
- [ ] `java.util.List` is imported

```
✅ List<{MethodName}Result> select{Entity}s(...)             → plural form
✅ List<{MethodName}Result> select{Entity}sBy{Condition}(...)→ plural + By{Condition}

❌ List<{MethodName}Result> select{Entity}(...)              → singular form is ambiguous
```
