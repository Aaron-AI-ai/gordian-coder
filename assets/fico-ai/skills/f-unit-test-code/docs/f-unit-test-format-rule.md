# 단위 테스트 형식 규칙

모든 테스트 클래스가 따르는 형식이다. 예제는 `templates/ServiceTestTemplate.java`, `templates/ControllerTestTemplate.java`.

## 필수 구성

- 클래스에 `@SpringBootTest`와 `@Transactional`.
- `@BeforeEach`(mock 초기화, 공통 입력 준비)와 `@AfterEach`(mock reset, 정리)가 모두 있어야 한다. 테스트끼리 상태를 공유하지 않는다(필드 `static` 금지).
- mock 어노테이션은 `@MockitoBean`. **Spring Boot 버전 확인:** 루트 `build.gradle`의 `spring-boot-gradle-plugin` 버전(예: `3.4.12`)을 본다. 3.4 미만이면 `@MockBean`
  (`org.springframework.boot.test.mock.mockito.MockBean`)을 쓴다. 한 프로젝트 안에서 섞지 않는다.
- 대상 클래스는 `@Autowired`로 주입한 실제 빈이다. 직접 `new`하지 않는다.
- 위치: 소스와 같은 패키지 구조로 `<모듈>/src/test/java`. 이름: `<클래스명>Test`(예: `SONAQ001ServiceTest`). 이미 있으면 덮어쓰지 않고 변경분만 추가한다.
- 메서드 이름: `<대상메서드>_normal1`, `_normal2`, `_boundary`, `_exception`. 한 케이스가 여러 개면 `_boundary2`처럼 번호를 붙인다.

## mock 대상 (외부 모듈이나 외부 자원에 닿는 것은 전부 mock)

**예외: Mapper 테스트.** 테스트 대상이 MyBatis Mapper(`org.apache.ibatis`의 `@Mapper`가 붙은 인터페이스, 또는 MapStruct를 쓰지 않고 `mapper`/`mappers`/`repo`/`repository`/`dao`/`persistence` 패키지에 있는 `*Mapper.java` 인터페이스) 자체일 때만 그 Mapper는 mock하지 않고 `@Autowired`로 받은 실제 빈으로 프로필 DB를 조회한다(아래 "Mapper 테스트"). Controller·Service 테스트에서는 Mapper가 여전히 아래 표대로 mock이다.

| mock으로 둔다 | 예 |
|---|---|
| 외부 모듈 클래스 (다른 Gradle 모듈, common-*, 프레임워크 jar의 서비스·유틸 중 외부 자원에 닿는 것) | `AccountBSM` (on-stk-ord-bsm) |
| MyBatis Mapper (DB) | `AccountMapper` |
| fico Redis 모듈 | `kr.co.openlabs.fico.framework.extension.module.RedisModule` (`get/set/delete`; 예: SONAU006Service에서 `@Autowired` 필드) |
| 외부 API·외부 서비스 클라이언트 | `RestTemplate`, `WebClient`, Feign 등 |

- Redis: fico 프레임워크는 `RedisModule`을 쓴다(on-stk-ord의 SONAU006Service에서 확인). 이 클래스가 없는 프로젝트라면 대상 코드의 import를 보고
  `kr.co.koscom` 아래 또는 `org.springframework.data.redis` 패키지의 Redis 클래스를 찾아 같은 방식으로 mock한다.
- 외부 API 클라이언트는 고정된 이름이 없다. 대상 클래스의 필드 타입과 import로 식별한다(HTTP 클라이언트, 이름이 `*Client`·`*Api`인 것).

**실제 객체로 두는 것:** 같은 모듈의 협력 클래스 중 외부 자원에 닿지 않는 것(Controller가 부르는 같은 모듈 Service, 순수 변환·검증 유틸, VO).
따라서 Controller 테스트는 Controller + Service가 실제로 돌고, 그 아래 BSM·Mapper·Redis만 mock이다.

- 생성자 주입(`@RequiredArgsConstructor`)이어도 `@MockitoBean`이 빈을 교체하므로 대상은 `@Autowired`로 받으면 된다.
- mock의 반환값은 스텁한다. 스텁 없는 mock은 `null`/`0`을 돌려주므로 NPE를 점검한다.

## 테스트 프로필

위에서부터 처음 해당하는 것 하나만 쓴다.

1. 프로젝트에 이미 테스트 프로필(`src/test/resources/application-test.*`, 또는 `@ActiveProfiles`를 쓰는 기존 테스트)이 있으면 그걸 쓴다. 새로 만들지 않는다.
2. 없고 H2가 클래스패스에 있으면(대상 모듈 또는 의존 모듈의 `build.gradle`에 `h2`) `src/test/resources/application-test.yml`을 만든다: H2 인메모리 DataSource
   (`jdbc:h2:mem:testdb;MODE=...`), `@ActiveProfiles("test")`를 테스트 클래스에 붙인다. H2 jar는 추가하지 않는다.
3. H2도 없으면 `application-test.yml`에서 DataSource 자동 설정을 제외하고(`spring.autoconfigure.exclude`에 `DataSourceAutoConfiguration`,
   `DataSourceTransactionManagerAutoConfiguration`, `MybatisAutoConfiguration` 등 해당되는 것), `PlatformTransactionManager`를 `@MockitoBean`으로 둔다
   (`@Transactional` 때문에 필요).

사용자 프로젝트의 `build.gradle` 등 빌드 파일은 수정하지 않는다. 의존성이 모자라 컴파일이 안 되면 수정하지 말고 보고한다.

**프로젝트 밖은 읽지 않는다.** `~/.gradle/caches`, `~/.m2`, jar 내부 등 프로젝트 밖을 검색·읽으면 권한이 자동 거부되어 실행이 멈춘다. 로깅 구현체(logback/log4j2)나 사용 라이브러리는 `build.gradle`과 프로젝트 소스(import, `logback*.xml`, `log4j2*.xml`, `application*.yml`)에서만 확인한다. 그래도 확정할 수 없으면 로그 출력을 단언하지 말고 반환값·예외·mock 호출 등 관찰 가능한 동작으로 테스트하며, 그 사실을 계획의 `note`에 적는다.

## Mapper 테스트 (실제 DB)

예제는 `templates/MapperTestTemplate.java`. 위치/이름은 소스와 같은 패키지의 `<MapperName>Test`(Mapper가 다른 모듈이면 그 모듈의 `src/test`).

- 클래스에 `@SpringBootTest`, `@ActiveProfiles("<프로필>")`, `@Transactional`, `@BeforeEach`, `@AfterEach`. Mapper는 `@Autowired` 실제 빈이고 `@MockitoBean`/`@MockBean`을 쓰지 않는다.
- **프로필:** 프로젝트에 테스트 프로필이 하나면 그것을, 여럿이면(예: `test`, `test-oracle`, `test-postgres`) 계획 단계에서 사용자에게 묻고, 하나도 없으면 사용자에게 묻는다. Mapper 테스트용 H2 프로필을 임의로 만들지 않는다(스키마·Oracle SQL 호환성을 알 수 없다). 고른 프로필은 계획의 `note`에 적는다. 위 "테스트 프로필"의 2·3번(프로필 새로 만들기, 데이터소스 제외)은 Mapper 테스트에 적용하지 않는다.
- **트랜잭션 안전(정적 점검 결함):** `@Transactional`이 있어야 하고, `@Commit`, `@Rollback(false)`, `@Rollback(value = false)`, `Propagation.NOT_SUPPORTED`/`REQUIRES_NEW`/`NEVER`/`SUPPORTS`는 모든 테스트에서 금지다. 한 테스트에서 쓰기가 여러 번이어도 하나의 `@Transactional` 안에서 처리하고 `REQUIRES_NEW`로 쪼개지 않는다. `@Sql`로 DDL을 실행하지 않는다(문서 규칙). `@org.springframework.test.annotation.Commit` 같은 FQCN 형태, `@Rollback(Boolean.FALSE)`, `TestTransaction.flagForCommit()`/`TestTransaction.end()`, `import static ...Propagation.*` 뒤의 맨 `REQUIRES_NEW` 등도 같은 결함이다. 대상 Mapper 자신을 `@MockitoBean`/`@MockBean`으로 바꾸는 것도 결함이다(대상 Mapper는 실제 빈). Mapper 테스트는 기존 파일을 보완할 때도 `@Transactional`과 `@ActiveProfiles`가 있어야 한다.
- **기본이 아닌 데이터소스(트랜잭션 매니저):** 클래스의 `@Transactional`은 기본 트랜잭션 매니저만 롤백한다. 대상 Mapper가 두 번째 데이터소스(예: `secondary`, `ext`)에 붙어 있으면 그 쓰기는 따로 커밋되고, `@AfterEach` 정리가 실제 데이터를 지울 수 있다. 그런 Mapper의 테스트는 `@Transactional("<트랜잭션 매니저 빈 이름>")`(또는 `@Transactional(transactionManager = "...")`)을 쓰고, 그 이름을 계획의 `note`에 적는다. 이름은 프로젝트의 데이터소스 설정 클래스(`@MapperScan(sqlSessionFactoryRef = ...)`, `@Bean ...TransactionManager`)에서 읽고, 읽을 수 없으면 계획 단계에서 사용자에게 묻는다.
- **시드·정리:** `@BeforeEach`는 테스트 데이터를 Mapper(또는 테스트 트랜잭션 안의 `@Sql`)로 넣고, 키는 충돌을 피하도록 `UT_` 접두어 + 유일 값을 쓴다. `@AfterEach`는 트랜잭션 안에서 만든 행을 지우고 사라졌는지 단언한다(어차피 롤백되지만 필수).
- 쓰기 케이스(insert/update/delete)는 같은 테스트 안에서 Mapper로 다시 조회해 결과를 단언한다.
- **MyBatis 1차 캐시:** `@Transactional` 테스트는 한 SqlSession을 끝까지 쓰므로, 같은 SELECT(같은 파라미터)를 다시 부르면 DB가 아니라 캐시 값이 돌아온다. `@Autowired SqlSessionTemplate sqlSession`을 받아 다음 두 곳에서 `sqlSession.clearCache()`를 호출한다. 운영 코드(XML의 `flushCache`)나 설정 yml은 바꾸지 않는다. Mapper의 insert/update/delete는 캐시를 자동으로 비우므로 그 뒤에는 필요 없다.
  - 같은 SELECT를 한 테스트 안에서 반복 호출할 때 호출 사이. 특히 파라미터 없는 시퀀스·현재시각 조회는 비우지 않으면 두 번째도 첫 값이 나온다.
  - `JdbcTemplate`·`@Sql` 등 MyBatis 밖에서 데이터를 바꾼 직후, Mapper로 다시 확인하기 전. 예: `@AfterEach`에서 JdbcTemplate으로 지운 뒤 `assertNull(mapper.select...)` 앞.

## 금지

- Mapper 테스트가 아닌 곳에서 실제 DB·Redis·외부 서비스에 붙는 테스트. (Mapper 테스트의 프로필 DB 조회는 허용)
- 단언 없는 테스트, `assertNotNull`만 있는 테스트.
- 테스트를 통과시키려고 대상(운영) 코드를 고치는 것.
