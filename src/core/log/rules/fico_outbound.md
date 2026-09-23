---
exceptions: "*RestClientException", "*ResourceAccessException", "*HttpClientErrorException*", "*HttpServerErrorException*", "*WebClientResponseException*", "*WebClientRequestException", "*CallNotPermittedException", "*SocketTimeoutException", "*ConnectException", "*UnknownHostException"
---
#### 외부 호출: 서킷브레이커·재시도·타임아웃
- `RestCallModule`은 resilience4j `CircuitBreaker` + `RetryableRestTemplate`(spring-retry)로 감싼다. `CallNotPermittedException`은 **서킷이 열린 상태**라는 뜻 — 이 로그의 원인은 그 이전에 누적된 실패다. 이 로그만으로 코드 원인을 단정하지 마라.
- 재시도 횟수·간격은 `RetryTemplateProperties`, 서킷 임계값은 `CircuitBreakerProperties`(`application*.yml`)에 있다.
- `WebClientConfig`/`WebClientProperties`의 connect/read 타임아웃이 `SocketTimeoutException`의 실제 원인일 수 있다.
- `TrControlModule.check…`는 거래통제 대상이면 `FWKE0001`을 던진다 — 코드 오류가 아니라 운영 통제 설정이다.
- 이 계열은 **환경 원인 가능성**이 높다. 제출 시 `envCause: true`를 검토하고, 해결안에 설정값 확인을 먼저 적는다.

확인 절차
1. `f_log_search`로 호출 URL 상수·프로퍼티 키를 찾아 어느 외부 시스템인지 확정한다.
2. `f_log_search`로 `resilience4j`/`retry` 설정 키를 `*.yml`에서 찾는다.
3. `f_log_history`로 최근 설정/URL 변경 커밋을 본다.
4. `TrControlModule` 대상이면 `f_log_search`로 관련 통제 프로퍼티(`FWKE0001` 발생 조건)를 확인한다.
