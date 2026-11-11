# INSERT Verification

- [ ] Return type is `Integer` (NOT `void`, NOT `int`, NOT any other type)
- [ ] Method name uses `insert` prefix (NOT `add`, `create`, `save`)
- [ ] Parameter DTO name follows `Insert{Entity}Parameter` pattern
- [ ] XML uses `<insert>` tag (NOT `<select>`, `<update>`, `<delete>`)
- [ ] XML has `parameterType` attribute (NOT `resultType`)
- [ ] INSERT SQL has proper column names and VALUES clause
- [ ] Column count matches values count

```
✅ Integer insert{Entity}(Insert{Entity}Parameter param)

❌ void insert{Entity}(...)      → return type must be Integer
❌ int insert{Entity}(...)       → must use Integer wrapper type
❌ Integer add{Entity}(...)      → prefix must be "insert"
❌ Integer create{Entity}(...)   → prefix must be "insert"
❌ Integer save{Entity}(...)     → prefix must be "insert"
```
