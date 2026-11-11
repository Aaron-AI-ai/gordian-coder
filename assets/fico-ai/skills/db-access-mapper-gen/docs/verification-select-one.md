# SELECT ONE Verification

- [ ] Return type is a single result object (e.g., `{MethodName}Result`)
- [ ] Return type is NOT `List<...>`
- [ ] Method name uses singular form + `One`/`ById`/`By{Condition}` suffix
- [ ] Method name does NOT use plural form (to avoid confusion with List return)
- [ ] XML uses `<select>` tag
- [ ] XML has both `parameterType` and `resultType` attributes

```
✅ select{Entity}By{Key}({MethodName}Parameter param)       → singular + By{Key} suffix
✅ select{Entity}One({MethodName}Parameter param)            → singular + One suffix

❌ List<{MethodName}Result> select{Entity}By{Key}(...)       → must NOT return List
❌ {MethodName}Result select{Entity}s(...)                   → plural form suggests List, misleading
```
