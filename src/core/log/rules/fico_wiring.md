---
exceptions: "org.springframework.beans.factory.*", "*BeanCreationException", "*UnsatisfiedDependencyException", "*NoSuchBeanDefinitionException", "*NoUniqueBeanDefinitionException", "*ApplicationContextException", "*BeanDefinitionStoreException", "*ConflictingBeanDefinitionException", "*BeanDefinitionOverrideException"
---
#### 기동 실패: 프레임워크 AutoConfiguration과 조건부 빈
- 프레임워크가 켜는 자동 설정: `PBDaemonAutoConfiguration`, `PBWarmupAutoConfiguration`, `LogLevelStoreAutoConfiguration`. 프로퍼티(`redis.enabled`, `pb.daemon.*`, `pb.warmup.*`)로 조건부 활성화된다.
- ext Mapper(`mapper/ext`)는 optional 빈 — 앱 코드에 `extLogMapper != null` 체크가 있다. `@Autowired(required=true)`로 받으면 기동 실패.
- `NoSuchBeanDefinitionException`: 컴포넌트 스캔 범위(`@SpringBootApplication` 패키지 vs 빈 패키지), `@Profile`, `@ConditionalOn*`.
- `NoUniqueBeanDefinitionException`: 벤더별 Mapper XML이 둘 다 스캔되거나 Service 이름 충돌.
- 실 로그 사례: `InstanceAlreadyExistsException: MXBean already registered … GenericObjectPool,name=pool` — 풀 빈 두 개가 같은 JMX 이름. `spring.jmx.enabled` 또는 풀 이름 설정.

확인 절차
1. 스택의 마지막 `Caused by`에서 빈 이름을 뽑아 `f_log_search`로 정의 위치(`@Bean`, `@Component`, XML)를 찾는다.
2. 그 빈의 생성자/필드 주입 타입을 `f_log_read`로 확인하고 `@Conditional*`/`@Profile`을 본다.
3. 컴포넌트 스캔 범위가 원인이면 `f_log_search`로 `@SpringBootApplication` 선언 위치와 빈 패키지를 비교한다.
4. JMX 이름 충돌이 의심되면 `f_log_search`로 `GenericObjectPool` 빈 정의를 찾아 이름 설정 여부를 본다.
