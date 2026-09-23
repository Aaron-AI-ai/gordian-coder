---
exceptions: "org.springframework.data.redis.*", "io.lettuce.*", "*RedisConnectionFailureException", "*RedisCommandTimeoutException", "*QueryTimeoutException", "*JedisConnectionException"
---
#### Redis: 연결 모드·풀·연속조회 키
- `RedisConfig`는 `redis.mode`(standalone/cluster/sentinel)로 커넥션 팩토리를 고르고, `redis.pool.*`, `command-timeout-sec`, `eager-initialization`(풀 워밍업)을 읽는다. 기동 직후 실패는 워밍업 단계(`redisConnectionWarmup`)다.
- `redis.enabled=false`면 Redis 빈이 없다 → `ContKeyService`는 `InMemoryContKeyServiceImpl`로 대체. 다중 인스턴스에서 연속조회(`contYn='Y'`)가 실패하면 이 대체가 원인이다.
- 연속조회 키는 `CONT_KEY:` prefix(`fico.contkey.redis-prefix`), TTL `redis.ttl-sec`. TTL 만료 후 다음 페이지 요청이 실패한다.
- `RedisLogLevelStore`는 로그 레벨 저장용 — 업무와 무관한 Redis 오류일 수 있다.
- **환경 원인 가능성**이 높다. `envCause`를 검토한다.

확인 절차
1. `f_log_search`로 `redis:`를 `*.yml`에서 찾아 mode/enabled/timeout을 확인한다.
2. 원인 프레임이 `ContKeyService` 계열이면 `f_log_search` `contYn`으로 연속조회 흐름을 연다.
3. `redis.enabled`가 `false`인지 확인하고, 그렇다면 `InMemoryContKeyServiceImpl` 대체 로직을 `f_log_read`로 본다.
4. TTL 만료가 의심되면 `redis.ttl-sec` 값을 `f_log_search`로 확인한다.
