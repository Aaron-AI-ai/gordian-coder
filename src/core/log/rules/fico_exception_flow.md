---
exceptions: "*CommonException", "*PBBaseException", "*PBOnlineException", "*PBModuleException", "*PBBatchException", "*PBDaemonException"
---
#### 어느 핸들러가 잡았는가 = 어느 층에서 났는가
관측 목록의 핸들러 로그 줄로 발생 층을 먼저 확정한다.
- `고정길이 전문 CommonException: errorCode=` → `PBExceptionHandlerAspect` (`@Around @RestController`, 첫 인자 `PBRequest`). **컨트롤러 메서드 안**(Service 포함)에서 났다.
- `PB CommonException: URI=, code=` (warn, 스택 없음) → `PBGlobalExceptionAdvice`(디스패처 레벨). 컨트롤러 **밖** — 바인딩·필터·AOP 순서·첫 인자가 PBRequest가 아닌 메서드.
- `CommonException:[…]` / `Exception:[…]` → `CommonControllerAdvice`(JSON 경로, 비-PB 요청).
- `PB 404/405/415` → 매핑 없음/메서드/Content-Type. `PB 9604` → 전문 파싱(`PBFixedDataConverter`).
- 앱 컨트롤러는 try-catch가 금지돼 있다(AOP가 처리). 컨트롤러에 catch가 있으면 예외가 삼켜지거나 다른 타입으로 재포장된 것이 원인 후보다.

확인 절차
1. URI가 있으면 `f_log_search`로 `@PostMapping(value = "<URI>"` → `{svcId}Controller` → 같은 이름의 `{svcId}Service`를 `f_log_find`로 연다.
2. 컨트롤러 메서드의 첫 파라미터가 `PBRequest<…>`인지 `f_log_read`로 확인한다 — 아니면 `PBExceptionHandlerAspect`·`DynamicDataSourceAspect` 둘 다 적용되지 않는다.
3. 컨트롤러에 try-catch가 있는지 `f_log_search`로 `catch (`를 그 파일 안에서 찾는다 — 있으면 예외가 재포장됐을 가능성이 크다.
