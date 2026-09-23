# f-log 평가 테스트베드 — 100 케이스 카탈로그

날짜: 2026-09-18 · 상태: 승인 대기 · 상위 스펙: `2026-09-17-f-log-eval-testbed-design.md`
근거: `.superpowers/sdd/2026-09-18-f-log-eval-100-cases/framework-misuse-survey-{1,2}.md` (프레임워크 throw 지점 file:line)

원칙은 상위 스펙과 같다. Spring Boot 부팅 없음(순수 Java 또는 최소 `AnnotationConfigApplicationContext`/H2/로컬 소켓), JUnit이 `CaseLog`로 fico 프리픽스 로그 생성, 케이스당 정답 YAML 1개, 채점기·러너 수정 없음. 케이스 ID는 `case-NN-<slug>`. 01~03은 기존.

범례 — 환경: P=순수 Java, C=최소 컨텍스트/H2/로컬 소켓. 난도: ★ 스택 첫 줄로 충분, ★★ 체인·프레임 추적 필요, ★★★ 로그에 없는 코드까지 읽어야 함. 룰 `—`는 매칭되는 번들 룰 없음(정답 YAML에서 `rule` 생략).

골든 YAML의 `exception`은 항상 로그에 실제로 먼저(맨 위) 찍히는 예외를 적는다 — 프레임워크가 감싼 경우 바깥쪽 타입이다(예: MyBatis는 대부분 `PersistenceException`으로 감싼다, 사례: 02·35·38·39; Spring 생성자 주입 실패는 `UnsatisfiedDependencyException`으로 감싼다, 사례: 15·19·49·50). 안쪽 원인은 카탈로그 설명 칸에 참고로만 남긴다. (2026-09-23 실측 반영, 04~10·34는 `rule` 생략 대신 실제 매칭되는 룰을 적는다: `CommonException`은 `fico_exception_flow`, `IllegalStateException`은 `fico_request_scope`.)

## A. 프레임워크 코드 위반 (31)

| # | ID | 오사용 | 루트 예외 | 룰 | 환경 | 난도 |
|---|---|---|---|---|---|---|
| 04 | fw-fixed-string-length-overflow | `@FixedString(length=5)`에 14자 직렬화 (FormatterUtils:1018/1064) | CommonException "invalid fixed value(length error)" | fico_exception_flow(범용 CommonException, fixed_message는 이 타입 미매칭) | P | ★ |
| 05 | fw-fixed-list-size-exceeded | `@FixedList(size=2)`에 3건 (FormatterUtils:255) | CommonException "invalid data(list field)" | fico_exception_flow | P | ★ |
| 06 | fw-fixed-list-missing-size-not-last | size 없는 `@FixedList`가 마지막 필드 아님 (FormatterUtils:338) | CommonException | fico_exception_flow | P | ★★ |
| 07 | fw-fixed-parse-no-noarg-ctor | 기본 생성자 없는 VO로 전문 파싱 (FormatterUtils:862) | CommonException(msg null, cause InstantiationException) | fico_exception_flow | P | ★★ |
| 08 | fw-fixed-parse-oversize-input | 전문이 VO 길이 초과 (FormatterUtils:726) | CommonException "invalid fixed data(byte length)…" | fico_exception_flow | P | ★ |
| 09 | fw-fixed-long-invalid-sign-byte | `@FixedLong(signed)` 부호 바이트 'A' (FormatterUtils:828) | CommonException "invalid signed byte" | fico_exception_flow | P | ★ |
| 10 | fw-fixed-nested-vo-block-count | 중첩 `@FixedVo` VO에 기본 생성자 없음 → 블록 길이 0 캐시 → 뒤늦게 무관한 파싱 오류 (PBFixedDataConverter:721) | CommonException(원인과 무관한 메시지) | fico_exception_flow | C | ★★★ |
| 11 | fw-pbresponse-null-header | `PBResponse.success(null, data)` (PBResponse:67) | NullPointerException(getContYn) | fico_fixed_message | P | ★ |
| 12 | fw-controller-aspect-missing-header | commonHeader null 요청으로 `ControllerAspect.onBeforeHandler` (ControllerAspect:117) | CommonException FWKE0002 | fico_error_code | P | ★★ |
| 13 | fw-request-scope-outside-thread | 요청 스레드 밖 `RequestScopeUtils` (RequestScopeUtils:106) | IllegalStateException "RequestAttributes is null" | fico_request_scope | P | ★ |
| 14 | fw-paging-conttrkey-index | `setContTrKeyFields` 2개, values 1개 → catch가 잡지 못하는 IndexOutOfBounds (MyBatisQueryInterceptor:86/91) | IndexOutOfBoundsException | — | P | ★★★ |
| 15 | fw-ext-transactional-missing-manager | `@ExtTransactional`인데 `extTransactionManager` 빈 없음 (ExtTransactional:18) | NoSuchBeanDefinitionException(TransactionAspectSupport 프레임) | fico_transaction | C | ★★ |
| 16 | fw-encrypt-utils-null-key | `EncryptUtils.setKey(null)` — null 미검증 후 `.getBytes()` (EncryptUtils:53) | NullPointerException | npe | P | ★ |
| 17 | fw-cubeone-missing-cryptoid | `CubeOneCryptoService.encrypt(text, null)` (CubeOneCryptoService:64) | CubeOneCryptoException errorCode 20008 | fico_fixed_message | P | ★ |
| 18 | fw-jwt-blank-secret | `JwtUtils.setKey("  ")` (JwtUtils:55) | IllegalArgumentException | — | P | ★ |
| 19 | fw-ext-mapper-required-injection | `mapper/ext` 매퍼는 선택 빈(fico 규약: `extLogMapper != null` 체크)인데 생성자 필수 주입 → ext 설정 없는 컨텍스트에서 기동 실패 (fico_wiring.md 규약 2번) | UnsatisfiedDependencyException→NoSuchBeanDefinitionException | fico_wiring | C | ★★ |
| 20 | fw-bean-utils-missing-bean | `BeanUtils.getBean(PBEnvProperties.class)` 미등록 (BeanUtils:33) | NoSuchBeanDefinitionException | fico_wiring | C | ★★ |
| 21 | fw-pb-env-properties-missing | `PBCommonUtils.getFirmNo()`인데 PBEnvProperties 미스캔 (PBCommonUtils:640) | NoSuchBeanDefinitionException | fico_wiring | C | ★★ |
| 22 | fw-dbmessagesource-unknown-code | 없는 메시지 코드 해석 (DBMessageSource:83) | NoSuchMessageException | — | P | ★★ |
| 23 | fw-number-decimal-string-overflow | `getDecimalFromString("123", 10)` (NumberUtils:44) | CommonException(substring 메시지) | fico_exception_flow | P | ★ |
| 24 | fw-number-long-to-kor-overflow | `longToKor(Long.MAX_VALUE)` (NumberUtils:104) | CommonException "입력값을 확인하십시오" | fico_exception_flow | P | ★ |
| 25 | fw-number-invalid-rounding-mode | `setScalePrc(n, 2, 99)` (NumberUtils:149) | IllegalArgumentException(enum) | — | P | ★ |
| 26 | fw-string-invalid-padding-direction | `stringPadding(10,"abc",2,'#')` (StringUtils:1334) | CommonException "패딩구분코드를 확인하십시오." | fico_exception_flow | P | ★ |
| 27 | fw-string-masking-invalid-type | `masking(str, "9")` (StringUtils:1564) | CommonException | fico_exception_flow | P | ★ |
| 28 | fw-date-days-in-month-invalid-year | `getDaysInMonth("abcd","05")` (DateUtils:506) | CommonException | fico_exception_flow | P | ★ |
| 29 | fw-date-compare-both-invalid | `compareDate("bad1","bad2")` — 한쪽만 불량이면 통과하는 프레임워크 버그 동반 (DateUtils:465) | CommonException | fico_exception_flow | P | ★★ |
| 30 | fw-encrypt-blake2b-digest-range | `encryptNumberByBlake2b(123L, 20, '0')` (EncryptUtils:125) | CommonException "illegal argument." | fico_exception_flow | P | ★ |
| 31 | fw-encrypt-aes-bad-base64 | `decryptAES("not-base64!!")` — catch가 checked만 잡아 래핑 안 됨 (EncryptUtils:218) | IllegalArgumentException(Base64) | — | P | ★★ |
| 32 | fw-compression-corrupt-lzo | `decompressLzo("hello".getBytes(),100)` (CompressionUtils:99) | io.airlift.compress.MalformedInputException | fico_fixed_message | P | ★ |
| 33 | fw-retry-template-zero-attempts | `retry-template.max-count=0` (RetryableRestTemplate:58) | IllegalArgumentException "Number of attempts should be positive" | — | C | ★★ |
| 34 | fw-crypto-field-processor-propagation | `@EncryptData("bad-id")` 필드, CryptoService가 throw (CryptoFieldProcessor:178) | IllegalStateException(구현체가 실제로 던진 타입) | fico_request_scope(범용 IllegalStateException 패턴, 내용상 무관) | P | ★★ |

## B. MyBatis · SQL · DataSource (15)

| # | ID | 유발 | 루트 예외 | 룰 | 환경 | 난도 |
|---|---|---|---|---|---|---|
| 02 | mybatis-binding (기존) | `#{acntNo}` vs 필드 accountNo | ReflectionException | fico_mybatis | C | ★★ |
| 35 | mybatis-result-mapping | VARCHAR 컬럼 → Integer 필드 | PersistenceException(outer, cause ResultMapException) | fico_mybatis | C | ★ |
| 36 | mybatis-too-many-results | selectOne이 2행 | TooManyResultsException | fico_mybatis | C | ★ |
| 37 | mybatis-unknown-statement | 매퍼 메서드에 XML statement 없음 | BindingException "Invalid bound statement" | fico_mybatis | C | ★ |
| 38 | mybatis-no-constructor | 불변 결과 클래스에 맞는 생성자 없음 | PersistenceException(outer, cause ExecutorException "No constructor found") | fico_mybatis | C | ★★ |
| 39 | mybatis-foreach-empty-list | `IN <foreach>`에 빈 리스트 → `IN ()` | PersistenceException(outer, cause JdbcSQLSyntaxErrorException) | fico_mybatis | C | ★★ |
| 40 | mybatis-xml-parse-error | 닫히지 않은 태그 | BuilderException | fico_mybatis | C | ★ |
| 41 | sql-syntax | `SELEC` 오타 | JdbcSQLSyntaxErrorException | fico_datasource | C | ★ |
| 42 | sql-unknown-column | 없는 컬럼 참조 | JdbcSQLSyntaxErrorException "Column not found" | fico_datasource | C | ★ |
| 43 | sql-duplicate-key | 같은 PK INSERT 2회 | JdbcSQLIntegrityConstraintViolationException | fico_datasource | C | ★ |
| 44 | sql-not-null-violation | NOT NULL 컬럼에 null | JdbcSQLIntegrityConstraintViolationException | fico_datasource | C | ★ |
| 45 | sql-data-too-long | VARCHAR(20)에 30자 | JdbcSQLDataException "Value too long" | fico_datasource | C | ★ |
| 46 | datasource-bad-url | HikariCP 잘못된 URL + JdbcTemplate | CannotGetJdbcConnectionException | fico_datasource | C | ★ |
| 47 | datasource-pool-exhausted | maxPool 1, timeout 500ms, 커넥션 점유 후 재요청 | SQLTransientConnectionException | fico_datasource | C | ★★ |
| 48 | jdbc-empty-result | `queryForObject` 0행 | EmptyResultDataAccessException | fico_mybatis | C | ★ |

## C. Spring 와이어링 · 설정 (12)

| # | ID | 유발 | 루트 예외 | 룰 | 환경 | 난도 |
|---|---|---|---|---|---|---|
| 03 | bean-conflict (기존) | 동명 빈 2개 | ConflictingBeanDefinitionException | fico_wiring | C | ★ |
| 49 | wiring-no-such-bean | 스캔 밖 @Repository 생성자 주입 | UnsatisfiedDependency→NoSuchBeanDefinition | fico_wiring | C | ★ |
| 50 | wiring-no-unique | 인터페이스 구현체 2개 타입 주입 | UnsatisfiedDependencyException(outer, cause NoUniqueBeanDefinitionException) | fico_wiring | C | ★ |
| 51 | wiring-circular | A→B→A 생성자 순환 | BeanCurrentlyInCreationException | fico_wiring | C | ★★ |
| 52 | wiring-placeholder | `@Value("${tlab.missing}")` | BeanCreationException→IllegalArgument "Could not resolve placeholder" | fico_wiring | C | ★ |
| 53 | wiring-init-method-failed | `@PostConstruct`가 throw | BeanCreationException "Invocation of init method failed" | fico_wiring | C | ★★ |
| 54 | wiring-value-type-mismatch | `@Value("${tlab.port}") int`에 "abc" | BeanCreationException→ConversionFailed/NumberFormat | fico_wiring | C | ★★ |
| 55 | wiring-constructor-ambiguity | 생성자 2개, @Autowired 없음 | BeanInstantiationException "No default constructor" | fico_wiring | C | ★ |
| 56 | wiring-bean-override | 두 @Configuration에 같은 @Bean 이름, override 금지 | BeanDefinitionOverrideException | fico_wiring | C | ★ |
| 57 | wiring-mapper-scan-wrong-package | `@MapperScan` 패키지 오타 → 매퍼 빈 없음 (SqlSessionFactoryBean+H2) | NoSuchBeanDefinitionException | fico_wiring | C | ★★ |
| 58 | wiring-final-class-proxy | final 클래스에 @Transactional | AopConfigException "Cannot subclass final class" | — | C | ★★ |
| 59 | wiring-profile-inactive | `@Profile("prod")` 빈 필요 | NoSuchBeanDefinitionException(프로파일 힌트) | fico_wiring | C | ★★ |

## D. 트랜잭션 · 동시성 (10)

| # | ID | 유발 | 루트 예외 | 룰 | 환경 | 난도 |
|---|---|---|---|---|---|---|
| 60 | tx-mandatory | 트랜잭션 없이 MANDATORY | IllegalTransactionStateException | fico_transaction | C | ★ |
| 61 | tx-unexpected-rollback | 내부 REQUIRED rollback-only, 외부 커밋 | UnexpectedRollbackException | fico_transaction | C | ★★★ |
| 62 | tx-nested-not-supported | NESTED, nestedTransactionAllowed=false | NestedTransactionNotSupportedException | fico_transaction | C | ★ |
| 63 | tx-timeout | timeout 1s 후 JDBC 실행 | TransactionTimedOutException | fico_transaction | C | ★★ |
| 64 | tx-no-manager | TransactionTemplate에 manager 미설정 | IllegalArgumentException "Property 'transactionManager' is required" | — | C | ★ |
| 65 | tx-optimistic-lock | version 불일치로 update 0행 → 앱이 throw | OptimisticLockingFailureException | fico_mybatis(DataAccessException) | C | ★★ |
| 66 | db-deadlock | 두 스레드가 두 행을 반대 순서로 갱신 (H2 deadlock 감지) | JdbcSQLException 40001 "Deadlock detected" | fico_datasource | C | ★★★ |
| 67 | db-lock-timeout | 미커밋 행에 다른 스레드 update, LOCK_TIMEOUT 500 | JdbcSQLTimeoutException | fico_datasource | C | ★★ |
| 68 | async-exception-boundary | `CompletableFuture.supplyAsync` 안에서 throw → `join` | CompletionException→원인(ForkJoinPool 프레임 경계) | — | P | ★★ |
| 69 | executor-rejected | 큐 1, 스레드 1에 3건 submit | RejectedExecutionException | — | P | ★ |

## E. 직렬화 · 전문 · 문자셋 · Jackson (8)

| # | ID | 유발 | 루트 예외 | 룰 | 환경 | 난도 |
|---|---|---|---|---|---|---|
| 70 | charset-malformed-euckr | EUC-KR 엄격 디코딩에 깨진 바이트 | MalformedInputException | fico_fixed_message | P | ★ |
| 71 | charset-unmappable-latin1 | 한글을 ISO-8859-1로 엄격 인코딩 | UnmappableCharacterException | fico_fixed_message | P | ★ |
| 72 | fixed-field-number-format | 고정길이 숫자 필드 " 12A" → parseLong | NumberFormatException | — | P | ★ |
| 73 | jackson-unknown-property | FAIL_ON_UNKNOWN_PROPERTIES | UnrecognizedPropertyException | — | P | ★ |
| 74 | jackson-invalid-format | "abc" → int | InvalidFormatException | — | P | ★ |
| 75 | jackson-missing-creator | 기본 생성자 없는 클래스 역직렬화 | InvalidDefinitionException | — | P | ★★ |
| 76 | jackson-mismatched-input | 배열을 객체로 | MismatchedInputException | — | P | ★ |
| 77 | jackson-infinite-recursion | 양방향 참조 직렬화 | JsonMappingException "Infinite recursion" | — | P | ★★ |

## F. 외부 연동: Redis · HTTP · 서킷 (8)

| # | ID | 유발 | 루트 예외 | 룰 | 환경 | 난도 |
|---|---|---|---|---|---|---|
| 78 | redis-connection-refused | Lettuce localhost:1 GET | RedisConnectionFailureException | fico_redis | C | ★ |
| 79 | redis-command-timeout | 응답 없는 로컬 소켓, commandTimeout 100ms | RedisCommandTimeoutException(검증 필요) | fico_redis | C | ★★★ |
| 80 | outbound-connect-refused | RestClient 127.0.0.1:1 | ResourceAccessException→ConnectException | fico_outbound | C | ★ |
| 81 | outbound-unknown-host | `http://no-such-host.invalid` | ResourceAccessException→UnknownHostException | fico_outbound | C | ★ |
| 82 | outbound-read-timeout | accept 후 무응답 소켓, readTimeout 300ms | ResourceAccessException→SocketTimeoutException | fico_outbound | C | ★★ |
| 83 | outbound-4xx | 로컬 HttpServer 404 | HttpClientErrorException.NotFound | fico_outbound | C | ★ |
| 84 | outbound-5xx | 로컬 HttpServer 500 | HttpServerErrorException.InternalServerError | fico_outbound | C | ★ |
| 85 | circuit-breaker-open | resilience4j 강제 OPEN 후 호출 | CallNotPermittedException | fico_outbound | P | ★★ |

## G. Java 언어 수준 (8)

| # | ID | 유발 | 루트 예외 | 룰 | 환경 | 난도 |
|---|---|---|---|---|---|---|
| 01 | npe (기존) | 매퍼 결과 null 역참조 | NullPointerException | npe | P | ★ |
| 86 | npe-unboxing | Integer null → int | NullPointerException(intValue) | npe | P | ★ |
| 87 | npe-map-chain | `map.get(k).trim()` | NullPointerException(체인) | npe | P | ★★ |
| 88 | class-cast | `List<Map>` 원소를 VO로 캐스팅 | ClassCastException | — | P | ★ |
| 89 | concurrent-modification | 순회 중 remove | ConcurrentModificationException | — | P | ★ |
| 90 | index-out-of-bounds | 전문 split 후 `get(size)` | IndexOutOfBoundsException | — | P | ★ |
| 91 | stack-overflow | 종료 조건 없는 재귀 (1024 프레임 절단) | StackOverflowError | — | P | ★★ |
| 92 | arithmetic-divide-by-zero | 수수료율 정수 나눗셈 | ArithmeticException | — | P | ★ |

## H. 복합 · 추적 난도 (8)

| # | ID | 유발 | 루트 예외 | 룰 | 환경 | 난도 |
|---|---|---|---|---|---|---|
| 93 | swallowed-cause | NPE를 잡아 `PBOnlineException.create("9999")`로 바꾸며 cause 폐기 | PBOnlineException(원인 없음) | fico_exception_flow | P | ★★★ |
| 94 | chain-wrapped-sql | RuntimeException→PersistenceException→SQL 문법 3단, `... N more` | JdbcSQLSyntaxErrorException | fico_datasource | C | ★★ |
| 95 | finally-masks-cause | finally에서 throw → 원 예외 가려짐 | finally의 예외만 로그 | — | P | ★★★ |
| 96 | retry-exhausted | resilience4j Retry 3회 후 실패 | MaxRetriesExceededException(재시도 프레임) | fico_outbound | P | ★★ |
| 97 | suppressed-close-failure | try-with-resources close()도 throw | 본 예외 + `Suppressed:` | — | P | ★★ |
| 98 | lambda-stream-deep | `stream().map` 람다 내부 throw | 원인 + lambda$/스트림 내부 프레임 | — | P | ★★ |
| 99 | stackless-handler-line | 스택 없는 PB 핸들러 라인만 (`errorCode= URI=`) | (스택 없음) | fico_exception_flow | P | ★★★ |
| 100 | multi-trace-log | WARN 트레이스 뒤에 ERROR 트레이스 2건 한 파일 | 첫 트레이스 대상 판별 | — | P | ★★★ |

## 분포 요약

| 카테고리 | 개수 | 비율 |
|---|---|---|
| A 프레임워크 코드 위반 | 31 | 31% |
| B MyBatis·SQL·DataSource | 15 | 15% |
| C Spring 와이어링·설정 | 12 | 12% |
| D 트랜잭션·동시성 | 10 | 10% |
| E 직렬화·전문·문자셋·Jackson | 8 | 8% |
| F 외부 연동 | 8 | 8% |
| G Java 언어 수준 | 8 | 8% |
| H 복합·추적 난도 | 8 | 8% |

| 축 | 분포 |
|---|---|
| 난도 | ★ 52 · ★★ 36 · ★★★ 12 |
| 환경 | 순수 Java 55 · 최소 컨텍스트/H2/로컬 소켓 45 |
| 기대 룰 | fico_fixed_message 12 · fico_mybatis 11 · fico_wiring 13 · fico_datasource 8 · fico_exception_flow 10 · fico_transaction 5 · fico_outbound 7 · npe 4 · fico_redis 2 · fico_request_scope 1 · fico_error_code 1 · 없음 27 |

## 케이스 설명 요약

**A 프레임워크 코드 위반**은 두 조사에서 실제 throw 지점을 확인한 31건이다(데몬·배치 관련은 제외). 19번은 ext 매퍼를 선택 빈으로 다루는 fico 규약 위반이다. 고정길이 전문 코덱(FormatterUtils·PBFixedDataConverter) 7건은 fico 온라인의 핵심 경로라 가장 많이 두었고, 10번은 프레임워크가 오류를 삼킨 뒤 무관한 메시지로 늦게 실패하는 ★★★ 케이스다. 요청/응답 모델·어스펙트·요청 스코프(11~13)와 Spring 조회 헬퍼(15, 20, 21)는 컨텍스트 경계를 잘못 넘는 오사용이며, 유틸리티 12건(23~34)은 CommonException으로 감싸지거나 감싸지지 않고 새는 두 부류를 섞어 f-log가 `fico_exception_flow` 룰과 원인 프레임을 함께 짚는지 본다. 14·29·31은 프레임워크 자체 버그(잡히지 않는 catch, 드모르간 오류, checked만 잡는 catch)가 동반되어 해결 방안이 앱 코드와 프레임워크 양쪽을 언급해야 한다.

**B MyBatis·SQL·DataSource**는 XML·매퍼 인터페이스·DDL·커넥션 풀 네 층에 원인을 분산했다. 스택에는 MyBatis/H2 프레임만 남고 원인 파일은 XML이나 DDL이므로 비-Java 용의 파일 탐색을 검증한다. 47(풀 고갈)은 설정값이 원인이다.

**C 와이어링**은 기동 실패 유형을 망라한다. 현재 03이 보여준 룰 미매칭(`context.annotation` 패키지) 같은 빈틈을 51(순환)·56(override)·58(AopConfigException)에서 더 찾을 것으로 예상한다.

**D 트랜잭션·동시성**은 전파 속성 오용(60~62), 시간 제한(63, 67), 실제 교착(66), 스레드 경계(68)를 다룬다. 61과 66은 로그의 마지막 프레임이 원인이 아닌 대표 케이스다.

**E 직렬화**는 전문 문자셋(70~72)과 Jackson(73~77)이다. 대부분 ★이지만 메시지 안의 필드 경로·라인/컬럼을 해결 방안에 반영하는지 본다.

**F 외부 연동**은 전부 로컬 소켓·서버로 재현해 네트워크 의존이 없다. 79는 Lettuce 핸드셰이크 동작에 따라 예외 타입이 달라질 수 있어 구현 시 검증 후 정답을 확정한다.

**G Java 수준**은 헬프풀 NPE 메시지 변형과 흔한 런타임 예외다. 91(StackOverflowError)은 1024 프레임 절단·반복 프레임을 파서가 견디는지 본다.

**H 복합**은 f-log의 한계를 겨냥한다. 93·95는 로그에 원인이 없어 코드를 읽어야 하고, 97·98·100은 파서의 `Suppressed:`·람다 정규화·다중 트레이스 처리를, 99는 스택 없는 핸들러 라인 합성(스펙 §5.8)을 검증한다.

## 구현 단위(예정)

도메인별 10~12개씩 태스크 9개(A를 3개로 분할). 각 태스크 = 프로덕션 코드 경로 + `CaseNN…Test` + YAML. 99·100은 `CaseLog`에 라인 기록 메서드 1개 추가 필요. 전체 실환경 평가는 8시간 이상이므로 `--case`/카테고리 단위 실행을 기본 운용으로 한다.
