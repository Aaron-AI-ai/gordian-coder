---
exceptions: "org.springframework.batch.*", "*PBBatchException", "*JobExecutionException", "*SkipLimitExceededException", "*RetryException", "*JobInstanceAlreadyCompleteException", "*JobParametersInvalidException"
---
#### 배치: skip/retry는 예외 속성이 결정한다
- `PBBatchException.create(code).withSkipable(true)/.withRetryable(true)` — `SkipPolicy`/`RetryPolicy`가 이 두 플래그를 본다. 플래그 없는 예외 하나가 Step 전체를 FAILED로 만든다.
- 프레임워크 기반 클래스: `BaseJob`, `BaseTasklet`(`afterStep`이 `ExitStatus`를 그대로 반환), `DefaultStepListener`, `DefaultJobExecutionListener`, `DefaultCenterCutJob`(센터컷).
- 배치 스레드에는 요청 스코프·svcId·DS 키가 없다 → `PBTransactionAspect`는 스킵, `@Transactional`만 적용.
- `JobInstanceAlreadyCompleteException`은 같은 JobParameters로 재실행한 것 — 코드가 아니라 실행 파라미터 문제.

확인 절차
1. 원인 Tasklet/Job을 `f_log_read`로 열어 던지는 예외가 `PBBatchException`인지, skipable/retryable을 지정했는지 본다.
2. `f_log_search`로 `SkipPolicy`/`skipLimit`/`retryLimit` 설정을 찾는다.
3. `f_log_history`로 최근 Job 변경을 본다.
4. `DefaultStepListener`/`DefaultJobExecutionListener`의 `afterStep`/`afterJob`을 `f_log_read`로 읽어 `ExitStatus`가 어떻게 결정되는지 본다.
5. `JobParameters`가 어디서 만들어지는지 `f_log_search`로 찾아 재실행 파라미터가 이전 실행과 같은지 확인한다.
