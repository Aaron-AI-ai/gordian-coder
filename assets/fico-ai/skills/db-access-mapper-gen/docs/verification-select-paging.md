# SELECT PAGING Verification

- [ ] Return type is `List<{MethodName}Result>`
- [ ] Method name uses plural form + `Paging` suffix
- [ ] When WHERE clause exists, `By{Condition}` suffix is before `Paging`
- [ ] Method signature includes `PagingInfo pagingInfo` as the second parameter
- [ ] `kr.co.openlabs.fico.framework.model.PagingInfo` is imported
- [ ] XML SQL does NOT include LIMIT/OFFSET clauses
- [ ] Parameter DTO does NOT include pagination fields (limit, offset, page, size)
- [ ] PagingInfo parameter name is exactly `pagingInfo` (not `paging` or `pageInfo`)

```
✅ List<{MethodName}Result> select{Entity}sPaging({MethodName}Parameter param, PagingInfo pagingInfo)
✅ List<{MethodName}Result> select{Entity}sBy{Condition}Paging({MethodName}Parameter param, PagingInfo pagingInfo)

❌ select{Entity}sPaging({MethodName}Parameter param)                → missing PagingInfo parameter
❌ select{Entity}s({MethodName}Parameter param, PagingInfo pagingInfo)→ missing Paging suffix
❌ select{Entity}Paging(...)                                         → singular form is ambiguous
```

### XML Rules

```
✅ SQL must NOT contain LIMIT/OFFSET clauses (framework handles pagination)
❌ LIMIT #{limit} OFFSET #{offset} in SQL → prohibited
```
