---
exceptions: "java.lang.IllegalStateException", "*NullPointerException", "*ScopeNotActiveException", "*BeanCreationException"
---
#### 요청 상태는 전부 ThreadLocal이다
- 네 가지가 요청 스레드에만 있다: `CommonRequest`(`RequestScopeUtils`, `RequestContextHolder`), svcId(`PBHeaderUtils.getSvcId()`), 데이터소스 키(`DynamicDataSourceContextHolder`), `TX_ACTIVE`(`PBTransactionAspect`).
- `@Async`, `@Scheduled`, 배치 Step, Kafka consumer, `CompletableFuture.supplyAsync`에서 Service를 부르면 이 값들이 null이다 → `IllegalStateException: No thread-bound request found` 또는 헤더 접근 NPE.
- `ControllerAspect`는 `commonHeader`가 null이면 `FWKE0002`를 던진다 — 요청 본문에 헤더가 빠진 것이다.
- `commonHeader.timeout`이 있으면 `ControllerAspect`가 시작 시각과 비교한다 — 타임아웃 예외는 업무 로직이 아니라 여기서 날 수 있다.
- 이 룰은 `IllegalStateException`·NPE 전체에 걸린다. 스택에 `RequestScopeUtils`/`PBHeaderUtils`/`ControllerAspect`/`RequestContextHolder` 프레임이 **없으면 이 룰은 해당 없음**으로 보고 넘어간다.

확인 절차
1. 스택의 스레드명(관측)과 진입점 프레임으로 요청 스레드인지 판단한다.
2. `f_log_callers`로 원인 메서드의 호출자를 거슬러 `@Async`/`@Scheduled`/`Runnable`이 있는지 본다.
3. `commonHeader`가 원인이면 `ControllerAspect`의 null 체크를 `f_log_read`로 확인한다.
4. 최근 호출부가 `@Async`/`@Scheduled`로 바뀌었는지 `f_log_blame`으로 확인한다.
