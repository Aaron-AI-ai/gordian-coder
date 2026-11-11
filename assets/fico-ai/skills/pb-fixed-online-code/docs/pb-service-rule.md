# FICO Framework Online Service Development Guide - Service Layer

## Core Principles

**ABSOLUTE RULES - MUST COMPLY**

### Service Rules
- **Class JavaDoc REQUIRED** (including change history)
- **Class annotations**: `@Slf4j` → `@Service`
- **DI via `@Autowired`** on `private` fields (if the service needs no dependency yet, remove the placeholder field and its import)
- **3 helper methods REQUIRED**: `preprocess()`, `checkParameter()`, `postprocess()`
- **@Transactional REQUIRED on main method** — `qry/service/`: `@Transactional(readOnly = true)`, `upd/service/`: `@Transactional`
- **Input access via `param.getInner().getXxx()`** (all spec fields live in the VO's `Inner` class)
- **Output built via `new {ServiceId}Out()` + `result.setInner({ServiceId}Out.Inner.builder()...build())`** (business fields only, no msgCode/userMsg)
- **Response message via `PBCommonUtils.setResponseMessage()`**
- **Exception via `PBOnlineException.create()`** (NOT `CommonException`)
- **Method Call Order**: `preprocess()` → `checkParameter()` → Business logic → `PBCommonUtils.setResponseMessage()` → `postprocess()`

---

**Document Version**: 2.1
**Last Updated**: 2026.09.14
