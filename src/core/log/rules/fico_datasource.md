---
exceptions: "*BadSqlGrammarException", "*CannotGetJdbcConnectionException", "*DataSourceLookupFailureException", "*SQLSyntaxErrorException", "*PSQLException", "*SQLException"
---
#### 데이터소스가 바뀌었을 수 있다
- `DynamicDataSourceAspect`(`@Before` `kr.co..*Controller.*` / `*Module.*`, `args(commonRequest,..)`): `commonHeader.even` `'1'`→`PRIMARY`, `'2'`→`SECONDARY`, 그 외·null→`PRIMARY`. **첫 인자가 `CommonRequest`가 아니면(예: `PBRequest`) 스위칭이 일어나지 않는다.**
- 키는 ThreadLocal(`DynamicDataSourceContextHolder`) — `@Async`·스케줄러·배치·Kafka 스레드에는 없다 → 기본 DS.
- Mapper XML은 벤더별로 나뉜다: `mybatis.mapper-locations: classpath*:mapper/postgres/**/*.xml` 또는 `mapper/oracle/**`. **활성 프로파일의 `application-*.yml`이 어느 쪽인지 먼저 본다** — 다른 벤더 XML을 고치는 실수가 흔하다.
- `RefreshableSqlSessionFactoryBean`이 5초마다 XML을 다시 읽는다 — 수정 직후의 오류는 리로드 타이밍일 수 있다.
- "table or view does not exist" / "relation … does not exist"는 SQL이 아니라 **잘못된 DS/스키마**일 수 있다.

확인 절차
1. `f_log_search`로 `mapper-locations`를 `*.yml`에서 찾아 활성 벤더 디렉터리를 확정한다.
2. 컨트롤러 메서드의 첫 파라미터 타입을 `f_log_read`로 확인한다(`CommonRequest` vs `PBRequest`).
3. `f_log_search`로 `even`이 세팅되는 곳(`getEven`, `setEven`)을 찾는다.
4. 수정 직후 오류라면 `RefreshableSqlSessionFactoryBean`의 리로드 주기 설정을 `f_log_search`로 확인해 타이밍 문제를 배제한다.
