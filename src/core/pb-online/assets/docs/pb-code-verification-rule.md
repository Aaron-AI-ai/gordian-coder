# Code Verification - Technical Rules

## Post-Generation Verification

1. Only files modified or created during this operation will be verified.

2. **CRITICAL - Post-Generation Existing Code Verification:**
   - All original methods, `@Autowired` fields, import statements, and class-level annotations must be preserved.
   - No duplicate import statements. No fully qualified class names in code (use import + simple name).

3. **Indentation**: 4 spaces (not tabs).

4. **Swagger/OpenAPI annotations:**
   - Controller class: `@Tag(name = "...")`
   - Controller methods: `@Operation(summary = "...", description = "...")`

5. **Controller method signature for Fixed-length:**
   - Parameter: `@RequestBody PBRequest<{ServiceId}In> param`
   - Return type: `PBResponse<{ServiceId}Out>`
   - Response: `PBResponse.success(param.getCommonHeader(), result)`

6. **Service layer patterns:**
   - `@Transactional` on main method:
     - `qry/service/` directory: MUST use `@Transactional(readOnly = true)`
     - `upd/service/` directory: MUST use `@Transactional` (without readOnly)
   - Three helper methods: `preprocess()`, `checkParameter()`, `postprocess()` called in order
   - Method call order: `preprocess()` → `checkParameter()` → Business logic → `PBCommonUtils.setResponseMessage()` → `postprocess()`
   - Input read via `param.getInner().getXxx()`; output built as `new {ServiceId}Out()` + `setInner({ServiceId}Out.Inner.builder()...build())`
   - Exception via `PBOnlineException.create()`

7. **HTTP method and annotations:**
   - `@PostMapping` only
   - `@RestController` and `@Slf4j` on controller class

8. **JavaDoc structure:**
   - Controller class: Title + `@author` + `@since` + Service ID/Korean Name/Description + API endpoint + Change history table
   - Controller method: API Name + Service ID/Korean Name/Description + `@param` + `@return`
   - Service class: Title + `@author` + `@since` + Service ID/Korean Name/Description + Change history table
   - Service method: Description + `@param` + `@return`
   - VO class: Title + `@author FICO AI` + `@since`

9. **VO Data Type Mapping:** Verify against Data Type Mapping table in `docs/pb-fixed-vo-rule.md`.

10. **CRITICAL - VO `Inner` Wrapper:**
    - Outer VO class: `@Data`, `@NoArgsConstructor`, `@Schema` only; single field `@FixedVo private Inner inner;`
    - `public static class Inner` with `@Data`, `@Builder`, `@AllArgsConstructor`, `@NoArgsConstructor` holds ALL spec fields.
    - No business field may be declared directly on the outer class.

11. **CRITICAL - VO Nested Class Structure:**
    - All OBJECT types MUST be generated as static inner classes within the parent VO class.
    - DO NOT create separate `.java` files for nested object types.
    - Inner classes: `public static class {ServiceId}{FieldName}` with `@Data`, `@Builder`, `@AllArgsConstructor`, `@NoArgsConstructor`.
    - Inner classes must NOT have `@Schema` at class level (only on fields).
    - Nested OBJECT/LIST inside inner class must be recursively generated as nested inner classes.

12. **CRITICAL - Fixed Data Format Annotations by Field Type:**
    - **PLAIN fields**: `@Schema(description)` + `@FixedData(length, padType, padChar)` — all three attributes mandatory.
    - **OBJECT fields**: `@Schema(description)` + `@FixedVo` (NOT `@FixedData`), no length/padType/padChar.
    - **LIST fields**: `@Schema(description)` + `@FixedList(size = {value})` — size mandatory.
    - `padType` conversion: `"RIGHT"` → `PAD_TYPE.RIGHT`, `"LEFT"` → `PAD_TYPE.LEFT`
    - `padChar` conversion: String to char (`"0"` → `'0'`)

13. **Fixed Data Format Required Imports:**
    - `kr.co.openlabs.fico.framework.internal.annotations.FixedData`
    - `kr.co.openlabs.fico.framework.internal.annotations.FixedData.PAD_TYPE`
    - `kr.co.openlabs.fico.framework.internal.annotations.FixedVo` (always, for the `Inner` wrapper)
    - `kr.co.openlabs.fico.framework.internal.annotations.FixedList` (if LIST type exists)

## Placeholder Replacements

**CRITICAL: All placeholders in template code must be replaced with actual values.**

### Template Placeholder Replacements

| Placeholder | Replace With | Source |
|-------------|--------------|--------|
| `{PackagePath}` | Project package path **including the `qry`/`upd` segment** (e.g. `kr.co.koscom.pb.on.stk.ord.online.qry`) | Project structure |
| `{CurrentDate}` | Code generation date (YYYY.MM.DD) | Current date |
| `{AuthorName}` | Author name | User input or `FICO AI` |
| `{ServiceId}` | Service ID (uppercase) | fico-mcp |
| `{serviceId}` | Service ID (lowercase, for variable/method names) | fico-mcp |
| `{ServiceKoreanName}` | Service Korean name | fico-mcp |
| `{ServiceDescription}` | Service description | fico-mcp |
| `{ChangeDescription}` | Change description | User input or `프로그램 신규 작성` |
| `{Collection}` | URL collection path | fico-mcp |
| `{DependencyType}` | Injected dependency type | Project analysis |
| `{dependencyName}` | Injected dependency variable name | Project analysis |
| `{ResponseMessageCode}` | Response message code | fico-mcp |
| `{FieldName}` | Field name (from I/O spec) | fico-mcp |
| `{Description}` | Field description in Korean | fico-mcp |
| `{Length}` | Fixed-length value | fico-mcp |
| `{PadType}` | Padding direction (RIGHT/LEFT) | fico-mcp |
| `{PadChar}` | Padding character | fico-mcp |
| `{Size}` | List max count | fico-mcp |

