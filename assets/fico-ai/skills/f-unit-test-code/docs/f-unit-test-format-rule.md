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

## 금지

- 실제 DB·Redis·외부 서비스에 붙는 테스트.
- 단언 없는 테스트, `assertNotNull`만 있는 테스트.
- 테스트를 통과시키려고 대상(운영) 코드를 고치는 것.
