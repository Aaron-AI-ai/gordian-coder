# PB Online Service Development Guide - Fixed-Length Controller Layer

## Core Principles

**ABSOLUTE RULES - MUST COMPLY**

### Controller Rules
- **Use POST method ONLY** (GET/PUT/DELETE/PATCH prohibited)
- **URL convention**: `POST /{Collection}/{ServiceId}` (e.g., `/ON/SONAQ001`)
- **Request MUST use `@RequestBody PBRequest<{ServiceId}In>`** (wrapped in PBRequest)
- **Response MUST use `PBResponse<{ServiceId}Out>`** (NOT ResponseEntity)
- **DI via `@RequiredArgsConstructor`** with `private final` fields (NOT `@Autowired`)
- **Class JavaDoc REQUIRED** (with change history table)
- **`@Tag(name, description)` REQUIRED on Controller class** (class-level API grouping)
- **`@Operation(summary, description)` REQUIRED on each Controller method** (method-level API documentation)
- **Exception handling PROHIBITED** (try-catch not allowed, handled by AOP)

---

## Rules Summary

| Rule | Requirement | Prohibition |
|------|-------------|-------------|
| HTTP Method | `@PostMapping` only | `@GetMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping` |
| URL Convention | `POST /{Collection}/{ServiceId}` (e.g., `/ON/SONAQ001`) | Non-standard URL patterns |
| Request Type | `@RequestBody PBRequest<{ServiceId}In>` | Direct VO without wrapper, `@RequestParam`, `@PathVariable` |
| Response Type | `PBResponse<{ServiceId}Out>` | `ResponseEntity`, direct VO without wrapper |
| Response Creation | `PBResponse.success(param.getCommonHeader(), result)` | `ResponseEntity.ok()`, `CommonUtils.createCommonResponse()` |
| DI Method | `@RequiredArgsConstructor` + `private final` | `@Autowired` |
| Exception Handling | None (handled by AOP) | `try-catch` blocks |

---

## JavaDoc Format

| Element | Controller |
|---------|------------|
| **Class JavaDoc** | 제목 + @author + @since + 서비스아이디/서비스한글명/설명 + API 엔드포인트 + 변경 정보 테이블 |
| **Method JavaDoc** | API명 + 서비스아이디/서비스한글명/설명 + @param + @return |
| **Class Annotations** | @Slf4j → @RestController → @RequiredArgsConstructor → @Tag(name, description) |

---

**Document Version**: 2.3
**Last Updated**: 2026.09.14
