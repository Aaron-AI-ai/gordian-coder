# f-log 100케이스 확장 — Phase 3 (Category C 나머지 + D + E 첫 1개) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카탈로그의 케이스 51~70(20개 — Category C 나머지 9개 + Category D 전체 10개 + Category E 첫 1개)을 on-test-lab-online에 JUnit 케이스로 만들고 정답 YAML을 붙인다. 지금까지 50개(01~50) 완료됨. 이 계획이 끝나면 70개.

**Architecture:** 와이어링 케이스(51~59)는 Phase 1·2에서 검증된 `AnnotationConfigApplicationContext` 패턴 재사용. 트랜잭션 케이스(60~64)는 Spring `DataSourceTransactionManager` + `TransactionTemplate` + H2, Spring 컨텍스트 없이 순수 객체 조합으로(주석·AOP 불필요 — `TransactionTemplate.execute()`가 트랜잭션 경계를 코드로 표현). 동시성 케이스(65~69)는 순수 Java(`ExecutorService`, `CompletableFuture`) + 필요시 H2 멀티스레드. `cause_files`는 전부 해당 테스트 파일 자신.

**Tech Stack:** Java 21, Gradle(offline), JUnit 5.11, Spring 6.2(`spring-tx`, `spring-jdbc`, `spring-aop` — 전부 기존 의존성), H2 2.3.232, MyBatis 3.5.19(65만). 추가 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-09-18-f-log-eval-100-cases-catalog.md` §C(51~59), §D(60~69), §E 첫 행(70) · 상위 스펙 `docs/superpowers/specs/2026-09-17-f-log-eval-testbed-design.md`

## Global Constraints

- `target` = `/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online`. Gradle: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:<task> --offline`. `--tests`는 `*` 와일드카드만, 대괄호 구간 미지원. macOS엔 `timeout` 없음.
- **target은 절대 커밋하지 않는다. target 안에서는 git 명령을 단 하나도 실행하지 않는다 — 읽기 전용 `git status`/`git diff`조차 금지.** 파일 확인은 `ls`/`cat`/`find`로만. (Phase 1·2에서 여러 번 반복된 지적 — 이번엔 예외 없이 지킨다.)
- 패키지 `kr.co.koscom.pb.on.test.lab.online.flogcase`, 파일 `CaseNN....Test.java`(NN 두 자리). 헬퍼는 같은 파일의 `private static` 중첩 클래스로 — 새 파일을 늘리지 않는다.
- 로그 파일 `logs/f-log-cases/case-NN-<slug>.log`. `CaseLog.write(caseId, loggerClass, msg, throwable)`(Task 1)는 그대로 재사용, 수정 금지.
- 골든 YAML `f-log-cases/case-NN-<slug>.yaml`, 필드는 정확히 `log, exception, cause_files, cause_symbol, fix_keywords_any, rule(선택)` 6개. **`exception`은 항상 실제로 던져진/로그에 먼저 찍히는 타입을 적는다 — 프레임워크가 감싸면 바깥쪽 타입**(Phase 2에서 확립된 관례: MyBatis는 `PersistenceException`, Spring 생성자 주입 실패는 `UnsatisfiedDependencyException`으로 감싼다). `rule:` 필드를 적기 전에 해당 룰 파일(`src/core/log/rules/fico_*.md`)의 `exceptions:` 줄을 `grep`으로 직접 읽어 그 예외 타입이 실제로 매칭되는지 확인한다 — 안 맞으면 생략하지 말고 **실제로 매칭되는 다른 룰이 있는지 먼저 확인**한다(Phase 2 최종 리뷰의 교훈: "매칭되는 게 있는데 생략"은 결함이다. 정말 어느 룰도 안 맞을 때만 생략).
- 각 테스트는 `assertThrows`(또는 동시성 케이스는 `Future`/`ExecutionException` 언래핑)로 예외 발생을 확인한 뒤 `CaseLog.write`로 기록하고, 로그 내용에 대한 구체적 assertion을 최소 2개 넣는다(서로 다른 사실 — 한쪽이 상시 참인 `||` 조합 금지). `gradle test`는 항상 green.
- 케이스마다 독립된 H2 인메모리 DB 이름(`jdbc:h2:mem:flogNN`).
- 커밋 메시지에 `Co-Authored-By` 줄을 넣지 않는다.

## 실측 검증 근거(구현 전 소스 코드 직접 확인)

- spring-tx 6.2.14(`AbstractPlatformTransactionManager`): `PROPAGATION_MANDATORY`로 기존 트랜잭션이 없으면 `IllegalTransactionStateException`("No existing transaction found for transaction marked with propagation 'mandatory'"). 전역 rollback-only 마킹 후 커밋 시도 시 `UnexpectedRollbackException`(코드 2곳, 메시지 "silently rolled back" 또는 "rolled back because it has been marked as rollback-only"). `NESTED`인데 `isNestedTransactionAllowed()==false`면 `NestedTransactionNotSupportedException`.
- spring-jdbc 6.2.14: **`DataSourceTransactionManager`는 생성자에서 `setNestedTransactionAllowed(true)`를 호출** — 기본값이 `AbstractPlatformTransactionManager`의 기본(false)과 다르다. 케이스 62는 `setNestedTransactionAllowed(false)`를 명시적으로 다시 꺼야 재현된다. `ResourceHolderSupport.checkTransactionTimeout`은 데드라인 초과 시 `TransactionTimedOutException`을 던지며, `DataSourceUtils.applyTransactionTimeout(Statement, DataSource)`가 `JdbcTemplate`이 매 실행 전에 호출하는 경로라 트랜잭션 타임아웃 안에서 지연 후 아무 JDBC 호출이나 하면 걸린다.
- spring-beans 6.2.14: `DefaultListableBeanFactory.isAllowBeanDefinitionOverriding()`는 필드가 `null`이면(기본값) `true`를 반환 — **평범한(Boot 아닌) Spring 컨테이너는 기본적으로 빈 재정의를 허용한다.** 케이스 56은 `setAllowBeanDefinitionOverriding(false)`를 명시적으로 꺼야 재현된다. 순환 생성자 의존은 `DefaultSingletonBeanRegistry`가 `BeanCurrentlyInCreationException(beanName)`을 던진다(표준, 잘 알려진 동작).
- spring-aop 6.2.14: `CglibAopProxy`가 CGLIB 서브클래싱 실패 시 `AopConfigException`("Could not generate CGLIB subclass of ...: Common causes of this problem include using a final class or a non-visible class")을 던진다. 대상 클래스가 인터페이스를 구현하지 않는 `final` 클래스면 JDK 동적 프록시를 쓸 수 없어 CGLIB가 강제되고, `final`이라 서브클래싱 자체가 실패한다 — `proxyTargetClass` 설정 불필요.
- H2 2.3.232(`DbException.getJdbcSQLException`): 에러코드 `/1000`으로 분기 — `40001`(DEADLOCK_1) → `JdbcSQLTransactionRollbackException`(카탈로그의 "40001 Deadlock"과 일치, 정확한 타입은 이것). `50200`(LOCK_TIMEOUT_1) → `JdbcSQLTimeoutException`.

---

## 파일 구조

| 파일(모두 target 안, 미커밋) | 케이스 |
|---|---|
| `flogcase/Case51...Test.java` ~ `Case55...Test.java` | 51~55 (Task C2, 와이어링) |
| `flogcase/Case56...Test.java` ~ `Case59...Test.java`, `Case70...Test.java` | 56~59, 70 (Task C3, 와이어링+문자셋) |
| `flogcase/Case60...Test.java` ~ `Case64...Test.java` | 60~64 (Task D1, 트랜잭션) |
| `flogcase/Case65...Test.java` ~ `Case69...Test.java` | 65~69 (Task D2, 트랜잭션+동시성) |
| `f-log-cases/case-51-...yaml` ~ `case-70-...yaml`(70 제외 19개 + 70) | 20개 |

---

### Task C2: 와이어링 — 순환·플레이스홀더·init·타입·생성자 (케이스 51~55, 5개)

**Files:**
- Create (target): `flogcase/Case51WiringCircularTest.java`
- Create (target): `flogcase/Case52WiringPlaceholderTest.java`
- Create (target): `flogcase/Case53WiringInitMethodFailedTest.java`
- Create (target): `flogcase/Case54WiringValueTypeMismatchTest.java`
- Create (target): `flogcase/Case55WiringConstructorAmbiguityTest.java`
- Create (target): `f-log-cases/case-51-wiring-circular.yaml` ~ `case-55-wiring-constructor-ambiguity.yaml` (5개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1). Category A의 `AnnotationConfigApplicationContext` 패턴(예: `Case15ExtTransactionalMissingManagerTest.java`) 참고.

- [ ] **Step 1: Case51 — 생성자 순환 의존**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.UnsatisfiedDependencyException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** f-log case-51: A가 생성자로 B를, B가 생성자로 A를 요구 — 순환 의존은 생성자 주입으로는 풀 수 없다. */
class Case51WiringCircularTest {

    static class A51 {
        A51(B51 b) {}
    }

    static class B51 {
        B51(A51 a) {}
    }

    @Configuration
    static class Cfg {
        @Bean
        A51 a51(B51 b) {
            return new A51(b);
        }

        @Bean
        B51 b51(A51 a) {
            return new B51(a);
        }
    }

    @Test
    void wiringCircular() throws Exception {
        UnsatisfiedDependencyException e = assertThrows(UnsatisfiedDependencyException.class,
                () -> new AnnotationConfigApplicationContext(Cfg.class));

        CaseLog.write("case-51-wiring-circular", A51.class, "빈 생성 실패 순환 의존 A51<->B51", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-51-wiring-circular.log"));
        assertTrue(log.contains("UnsatisfiedDependencyException") || log.contains("BeanCurrentlyInCreationException"), log);
        assertTrue(log.contains("Case51WiringCircularTest"), log);
    }
}
```
주의: `@Bean` 팩토리 메서드 방식(우리가 직접 `new A51(b)`를 호출)은 Spring이 생성자 리졸빙을 하지 않으므로 순환 자체가 "빈 메서드 호출 순서" 문제로 감지된다 — `BeanCurrentlyInCreationException`이 실제로 던져지는지 로그로 확인하고, 만약 예외가 안 나면(즉 Spring이 지연 초기화 등으로 우회하면) `@Bean` 대신 `ctx.register(A51.class, B51.class)`로 클래스를 직접 등록해 Spring 자신이 생성자 오토와이어링을 하게 만드는 방식으로 바꾼다(A51/B51 생성자에 `@org.springframework.beans.factory.annotation.Autowired` 없이도 단일 생성자면 자동 후보가 된다 — 필요하면 `@Autowired` 명시).

- [ ] **Step 2: Case52 — 플레이스홀더 해석 실패**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.BeanCreationException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.support.PropertySourcesPlaceholderConfigurer;

/** f-log case-52: @Value("${tlab.missing}")를 해석할 프로퍼티가 어디에도 없다. */
class Case52WiringPlaceholderTest {

    static class Svc52 {
        @Value("${tlab.missing}")
        String missing;
    }

    @Configuration
    static class Cfg {
        @Bean
        static PropertySourcesPlaceholderConfigurer placeholderConfigurer() {
            return new PropertySourcesPlaceholderConfigurer();
        }

        @Bean
        Svc52 svc52() {
            return new Svc52();
        }
    }

    @Test
    void wiringPlaceholder() throws Exception {
        BeanCreationException e = assertThrows(BeanCreationException.class,
                () -> new AnnotationConfigApplicationContext(Cfg.class));

        CaseLog.write("case-52-wiring-placeholder", Svc52.class, "빈 생성 실패 property=tlab.missing", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-52-wiring-placeholder.log"));
        assertTrue(log.contains("Could not resolve placeholder") || log.contains("tlab.missing"), log);
        assertTrue(log.contains("Case52WiringPlaceholderTest"), log);
    }
}
```

- [ ] **Step 3: Case53 — @PostConstruct에서 예외**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import jakarta.annotation.PostConstruct;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.BeanCreationException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** f-log case-53: @PostConstruct 초기화 메서드가 예외를 던진다. */
class Case53WiringInitMethodFailedTest {

    static class Svc53 {
        @PostConstruct
        void init() {
            throw new IllegalStateException("초기화 리소스 없음");
        }
    }

    @Configuration
    static class Cfg {
        @Bean
        Svc53 svc53() {
            return new Svc53();
        }
    }

    @Test
    void wiringInitMethodFailed() throws Exception {
        BeanCreationException e = assertThrows(BeanCreationException.class,
                () -> new AnnotationConfigApplicationContext(Cfg.class));

        CaseLog.write("case-53-wiring-init-method-failed", Svc53.class, "빈 초기화 실패 @PostConstruct", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-53-wiring-init-method-failed.log"));
        assertTrue(log.contains("Invocation of init method failed") || log.contains("초기화 리소스 없음"), log);
        assertTrue(log.contains("Case53WiringInitMethodFailedTest"), log);
    }
}
```
`jakarta.annotation.PostConstruct`가 클래스패스에 없으면(구버전 `javax.annotation.PostConstruct`) import를 그것으로 바꾼다 — 실제로 컴파일되는 쪽을 쓴다.

- [ ] **Step 4: Case54 — @Value 타입 변환 실패**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.BeanCreationException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.support.PropertySourcesPlaceholderConfigurer;
import org.springframework.core.env.PropertiesPropertySource;

/** f-log case-54: @Value("${tlab.port}") int에 숫자가 아닌 값을 주입한다. */
class Case54WiringValueTypeMismatchTest {

    static class Svc54 {
        @Value("${tlab.port}")
        int port;
    }

    @Configuration
    static class Cfg {
        @Bean
        static PropertySourcesPlaceholderConfigurer placeholderConfigurer(
                org.springframework.core.env.ConfigurableEnvironment env) {
            Properties props = new Properties();
            props.setProperty("tlab.port", "abc"); // 숫자가 아님 — 고의
            env.getPropertySources().addFirst(new PropertiesPropertySource("tlabProps", props));
            return new PropertySourcesPlaceholderConfigurer();
        }

        @Bean
        Svc54 svc54() {
            return new Svc54();
        }
    }

    @Test
    void wiringValueTypeMismatch() throws Exception {
        BeanCreationException e = assertThrows(BeanCreationException.class,
                () -> new AnnotationConfigApplicationContext(Cfg.class));

        CaseLog.write("case-54-wiring-value-type-mismatch", Svc54.class, "빈 생성 실패 tlab.port=abc int 변환", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-54-wiring-value-type-mismatch.log"));
        assertTrue(log.contains("tlab.port") || log.contains("TypeMismatch") || log.contains("NumberFormat"), log);
        assertTrue(log.contains("Case54WiringValueTypeMismatchTest"), log);
    }
}
```
주의: `PropertySourcesPlaceholderConfigurer`는 `@Bean static` 팩토리 메서드라 컨텍스트의 `Environment`를 파라미터로 못 받을 수도 있다(정적 `@Bean` 메서드가 `ConfigurableEnvironment`를 자동주입받을 수 있는지는 Spring 버전에 따라 제한적) — 컴파일/실행이 안 되면, 대신 `AnnotationConfigApplicationContext`를 만들기 전에 `ctx.getEnvironment().getPropertySources().addFirst(...)`를 직접 호출하는 순서로 바꾼다(인자 없는 생성자로 컨텍스트를 만들고 `register(Cfg.class)` 전에 프로퍼티소스를 넣은 뒤 `refresh()`).

- [ ] **Step 5: Case55 — 생성자 2개, 자동주입 실패**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.BeanCreationException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

/** f-log case-55: 기본 생성자가 없고, 두 생성자 중 어느 쪽도 @Autowired가 아니며 어느 쪽도 자동주입으로 만족되지 않는다. */
class Case55WiringConstructorAmbiguityTest {

    public static class Svc55 {
        public Svc55(String name) {}

        public Svc55(int code) {}
    }

    @Test
    void wiringConstructorAmbiguity() throws Exception {
        Exception e;
        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            ctx.register(Svc55.class);
            e = assertThrows(BeanCreationException.class, ctx::refresh);
        }

        CaseLog.write("case-55-wiring-constructor-ambiguity", Svc55.class, "빈 생성 실패 생성자 2개 중 선택 불가", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-55-wiring-constructor-ambiguity.log"));
        assertTrue(log.contains("constructor") || log.contains("생성자") || log.contains("Constructor"), log);
        assertTrue(log.contains("Case55WiringConstructorAmbiguityTest"), log);
    }
}
```
이 케이스는 정확한 예외 서브타입(`BeanInstantiationException` vs 다른 `BeanCreationException` 계열)이 사전 검증되지 않았다 — 실제로 실행해서 뭐가 던져지는지 확인하고, `assertThrows(BeanCreationException.class, ...)`(모든 빈 생성 실패의 공통 상위 타입)가 잡지 못하면(즉 Spring이 예외 없이 둘 중 하나를 조용히 골라버리면) 두 생성자의 파라미터 타입을 자동주입으로 둘 다 만족 가능한 형태(`Svc55(Dep55 a)`와 `Svc55(Dep55 a, String extra)`처럼)로 바꿔 "Ambiguous constructor matches found" 메시지가 실제로 나오는 조합을 찾는다.

- [ ] **Step 6: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case5[1-5]*' -q`
Expected: BUILD SUCCESSFUL. 로그 5개.

- [ ] **Step 7: 룰 확인 후 골든 YAML 5개**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_wiring.md`

```yaml
# case-51-wiring-circular.yaml
log: logs/f-log-cases/case-51-wiring-circular.log
exception: org.springframework.beans.factory.UnsatisfiedDependencyException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case51WiringCircularTest.java"]
cause_symbol: wiringCircular
fix_keywords_any: ["순환", "circular", "A51", "B51"]
rule: fico_wiring
```
```yaml
# case-52-wiring-placeholder.yaml
log: logs/f-log-cases/case-52-wiring-placeholder.log
exception: org.springframework.beans.factory.BeanCreationException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case52WiringPlaceholderTest.java"]
cause_symbol: wiringPlaceholder
fix_keywords_any: ["placeholder", "tlab.missing", "프로퍼티"]
rule: fico_wiring
```
```yaml
# case-53-wiring-init-method-failed.yaml
log: logs/f-log-cases/case-53-wiring-init-method-failed.log
exception: org.springframework.beans.factory.BeanCreationException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case53WiringInitMethodFailedTest.java"]
cause_symbol: wiringInitMethodFailed
fix_keywords_any: ["PostConstruct", "초기화", "init"]
rule: fico_wiring
```
```yaml
# case-54-wiring-value-type-mismatch.yaml
log: logs/f-log-cases/case-54-wiring-value-type-mismatch.log
exception: org.springframework.beans.factory.BeanCreationException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case54WiringValueTypeMismatchTest.java"]
cause_symbol: wiringValueTypeMismatch
fix_keywords_any: ["tlab.port", "타입", "변환", "int"]
rule: fico_wiring
```
```yaml
# case-55-wiring-constructor-ambiguity.yaml
log: logs/f-log-cases/case-55-wiring-constructor-ambiguity.log
exception: org.springframework.beans.factory.BeanCreationException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case55WiringConstructorAmbiguityTest.java"]
cause_symbol: wiringConstructorAmbiguity
fix_keywords_any: ["생성자", "constructor", "Autowired"]
rule: fico_wiring
```
(51의 실제 최상위 예외가 `BeanCurrentlyInCreationException` 그대로일 수도 있다 — Step 6 실행 결과에 맞춰 `exception:` 값을 실제 로그의 첫 줄과 일치시킨다.)

---

### Task C3: 와이어링 — 재정의·스캔범위·프록시·프로파일 + 문자셋 (케이스 56~59, 70, 5개)

**Files:**
- Create (target): `flogcase/Case56WiringBeanOverrideTest.java`
- Create (target): `flogcase/Case57WiringMapperScanWrongPackageTest.java`
- Create (target): `flogcase/Case58WiringFinalClassProxyTest.java`
- Create (target): `flogcase/Case59WiringProfileInactiveTest.java`
- Create (target): `flogcase/Case70CharsetMalformedEuckrTest.java`
- Create (target): `f-log-cases/case-56-wiring-bean-override.yaml` ~ `case-59-wiring-profile-inactive.yaml`, `case-70-charset-malformed-euckr.yaml` (5개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1).

- [ ] **Step 1: Case56 — 같은 이름의 빈 2개, 재정의 금지**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** f-log case-56: 서로 다른 @Configuration에서 같은 이름의 빈을 선언하고, 재정의를 명시적으로 금지한다. */
class Case56WiringBeanOverrideTest {

    static class Svc56 {}

    @Configuration
    static class CfgA {
        @Bean("dupSvc56")
        Svc56 a() {
            return new Svc56();
        }
    }

    @Configuration
    static class CfgB {
        @Bean("dupSvc56")
        Svc56 b() {
            return new Svc56();
        }
    }

    @Test
    void wiringBeanOverride() throws Exception {
        Exception e;
        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            ctx.setAllowBeanDefinitionOverriding(false); // 기본값은 true라 명시적으로 꺼야 재현된다.
            ctx.register(CfgA.class, CfgB.class);
            e = assertThrows(Exception.class, ctx::refresh);
        }

        CaseLog.write("case-56-wiring-bean-override", Svc56.class, "빈 등록 실패 이름 충돌 dupSvc56", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-56-wiring-bean-override.log"));
        assertTrue(log.contains("BeanDefinitionOverrideException") || log.contains("dupSvc56"), log);
        assertTrue(log.contains("Case56WiringBeanOverrideTest"), log);
    }
}
```

- [ ] **Step 2: Case57 — `@MapperScan` 패키지 오타(빈 없음)**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.beans.factory.NoSuchBeanDefinitionException;
import org.springframework.beans.factory.UnsatisfiedDependencyException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * f-log case-57: @MapperScan이 실제 매퍼 인터페이스가 있는 패키지가 아니라 오타 패키지를 가리켜
 * 매퍼 빈이 하나도 등록되지 않는다 — 생성자로 그 매퍼를 요구하는 서비스가 기동 실패.
 */
class Case57WiringMapperScanWrongPackageTest {

    interface SomeMapper57 {
        String selectOne();
    }

    static class Svc57 {
        Svc57(SomeMapper57 mapper) {}
    }

    @Configuration
    @MapperScan(basePackages = "kr.co.koscom.pb.on.test.lab.online.flogcase.nowhere57") // 실제 매퍼가 없는 패키지 — 고의
    static class Cfg {
        @Bean
        Svc57 svc57(SomeMapper57 mapper) {
            return new Svc57(mapper);
        }
    }

    @Test
    void wiringMapperScanWrongPackage() throws Exception {
        Exception e = assertThrows(Exception.class, () -> new AnnotationConfigApplicationContext(Cfg.class));

        CaseLog.write("case-57-wiring-mapper-scan-wrong-package", Svc57.class, "빈 생성 실패 매퍼 스캔 범위 오타", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-57-wiring-mapper-scan-wrong-package.log"));
        assertTrue(log.contains("NoSuchBeanDefinitionException") || log.contains("UnsatisfiedDependencyException"), log);
        assertTrue(log.contains("Case57WiringMapperScanWrongPackageTest"), log);
    }
}
```
`@MapperScan`은 MyBatis-Spring 통합 어노테이션인데 이 프로젝트가 `org.mybatis.spring.annotation.MapperScan`을 테스트 클래스패스에 갖고 있는지 먼저 컴파일로 확인한다(온라인 앱이 MyBatis-Spring을 실제로 쓰므로 가능성 높음). 없으면 `import`를 지우고 대신 `@ComponentScan(basePackages = "...nowhere57")`로 대체해도 같은 "스캔 범위가 잘못돼 빈이 없다"는 취지를 유지할 수 있다 — 그 경우 로그 assertion과 YAML의 `fix_keywords_any`에서 "매퍼"/"Mapper" 언급을 빼고 "컴포넌트 스캔"으로 바꾼다.

- [ ] **Step 3: Case58 — final 클래스에 CGLIB 프록시 시도**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.aop.framework.AopConfigException;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.aop.support.DefaultPointcutAdvisor;
import org.springframework.aop.support.NameMatchMethodPointcut;
import org.aopalliance.intercept.MethodInterceptor;
import org.aopalliance.intercept.MethodInvocation;

/** f-log case-58: final 클래스는 인터페이스가 없으면 CGLIB로 서브클래싱해야 하는데 final이라 실패한다. */
class Case58WiringFinalClassProxyTest {

    public static final class Svc58 { // final — 인터페이스 없음, 고의
        public void run() {}
    }

    static class NoopInterceptor implements MethodInterceptor {
        public Object invoke(MethodInvocation invocation) throws Throwable {
            return invocation.proceed();
        }
    }

    @Test
    void wiringFinalClassProxy() throws Exception {
        ProxyFactory factory = new ProxyFactory(new Svc58());
        factory.setProxyTargetClass(true);
        NameMatchMethodPointcut pointcut = new NameMatchMethodPointcut();
        pointcut.addMethodName("run");
        factory.addAdvisor(new DefaultPointcutAdvisor(pointcut, new NoopInterceptor()));

        AopConfigException e = assertThrows(AopConfigException.class, factory::getProxy);

        CaseLog.write("case-58-wiring-final-class-proxy", Svc58.class, "AOP 프록시 생성 실패 final class", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-58-wiring-final-class-proxy.log"));
        assertTrue(log.contains("AopConfigException"), log);
        assertTrue(log.contains("final class") || log.contains("CGLIB"), log);
    }
}
```

- [ ] **Step 4: Case59 — 비활성 프로파일의 빈을 요구**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.UnsatisfiedDependencyException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

/** f-log case-59: @Profile("prod") 빈을 요구하는데 활성 프로파일이 지정돼 있지 않다(기본 프로파일만 활성). */
class Case59WiringProfileInactiveTest {

    static class ProdOnlySvc59 {}

    static class Consumer59 {
        Consumer59(ProdOnlySvc59 svc) {}
    }

    @Configuration
    static class Cfg {
        @Bean
        @Profile("prod")
        ProdOnlySvc59 prodOnlySvc59() {
            return new ProdOnlySvc59();
        }

        @Bean
        Consumer59 consumer59(ProdOnlySvc59 svc) {
            return new Consumer59(svc);
        }
    }

    @Test
    void wiringProfileInactive() throws Exception {
        // 활성 프로파일을 지정하지 않는다 — prod 빈은 등록되지 않는다.
        UnsatisfiedDependencyException e = assertThrows(UnsatisfiedDependencyException.class,
                () -> new AnnotationConfigApplicationContext(Cfg.class));

        CaseLog.write("case-59-wiring-profile-inactive", Consumer59.class, "빈 생성 실패 type=ProdOnlySvc59 profile=prod 비활성", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-59-wiring-profile-inactive.log"));
        assertTrue(log.contains("UnsatisfiedDependencyException") || log.contains("NoSuchBeanDefinitionException"), log);
        assertTrue(log.contains("Case59WiringProfileInactiveTest"), log);
    }
}
```

- [ ] **Step 5: Case70 — EUC-KR 엄격 디코딩에 깨진 바이트**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-70: EUC-KR로 선언된 전문 바이트열에 그 인코딩으로 디코딩 불가능한 바이트가 섞여 있다. */
class Case70CharsetMalformedEuckrTest {

    @Test
    void charsetMalformedEuckr() throws Exception {
        // 0xFF 0xFF는 EUC-KR 2바이트 조합으로 유효하지 않다 — 고의로 깨진 전문.
        byte[] malformed = { (byte) 0xB0, (byte) 0xA1, (byte) 0xFF, (byte) 0xFF };

        Charset euckr = Charset.forName("EUC-KR");
        var decoder = euckr.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        Reader reader = new InputStreamReader(new ByteArrayInputStream(malformed), decoder);

        CharacterCodingException e = assertThrows(CharacterCodingException.class, () -> {
            int c;
            while ((c = reader.read()) != -1) {
                // 읽기만 한다 — 디코딩 실패 시 여기서 예외
            }
        });

        CaseLog.write("case-70-charset-malformed-euckr", Reader.class, "전문 디코딩 실패 EUC-KR 깨진 바이트", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-70-charset-malformed-euckr.log"));
        assertTrue(log.contains("CharacterCodingException") || log.contains("MalformedInputException"), log);
        assertTrue(log.contains("Case70CharsetMalformedEuckrTest"), log);
    }
}
```
비고: `InputStreamReader.read()`가 실제로 체크 예외 `CharacterCodingException`을 던지는지(내부적으로 `MalformedInputException`으로 감싸 `IOException`만 던질 수도 있다 — `MalformedInputException extends CharacterCodingException`이므로 어느 쪽이든 이 타입으로 잡힌다) 확인한다. `IOException`으로만 잡고 싶으면 `assertThrows(IOException.class, ...)`로 넓히고 로그에서 구체 타입을 확인해도 된다.

- [ ] **Step 6: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case5[6-9]*' --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case70*' -q`
Expected: BUILD SUCCESSFUL. 로그 5개.

- [ ] **Step 7: 룰 확인 후 골든 YAML 5개**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_wiring.md /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_fixed_message.md`

```yaml
# case-56-wiring-bean-override.yaml
log: logs/f-log-cases/case-56-wiring-bean-override.log
exception: org.springframework.context.annotation.ConflictingBeanDefinitionException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case56WiringBeanOverrideTest.java"]
cause_symbol: wiringBeanOverride
fix_keywords_any: ["재정의", "override", "dupSvc56"]
rule: fico_wiring
```
```yaml
# case-57-wiring-mapper-scan-wrong-package.yaml
log: logs/f-log-cases/case-57-wiring-mapper-scan-wrong-package.log
exception: org.springframework.beans.factory.UnsatisfiedDependencyException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case57WiringMapperScanWrongPackageTest.java"]
cause_symbol: wiringMapperScanWrongPackage
fix_keywords_any: ["스캔", "scan", "패키지", "package"]
rule: fico_wiring
```
```yaml
# case-58-wiring-final-class-proxy.yaml
log: logs/f-log-cases/case-58-wiring-final-class-proxy.log
exception: org.springframework.aop.framework.AopConfigException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case58WiringFinalClassProxyTest.java"]
cause_symbol: wiringFinalClassProxy
fix_keywords_any: ["final", "CGLIB", "프록시", "proxy"]
```
```yaml
# case-59-wiring-profile-inactive.yaml
log: logs/f-log-cases/case-59-wiring-profile-inactive.log
exception: org.springframework.beans.factory.UnsatisfiedDependencyException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case59WiringProfileInactiveTest.java"]
cause_symbol: wiringProfileInactive
fix_keywords_any: ["profile", "prod", "프로파일", "활성"]
rule: fico_wiring
```
```yaml
# case-70-charset-malformed-euckr.yaml
log: logs/f-log-cases/case-70-charset-malformed-euckr.log
exception: java.nio.charset.MalformedInputException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case70CharsetMalformedEuckrTest.java"]
cause_symbol: charsetMalformedEuckr
fix_keywords_any: ["EUC-KR", "인코딩", "charset", "디코딩"]
rule: fico_fixed_message
```
(56의 `exception:` 은 케이스-03 전례처럼 `ConflictingBeanDefinitionException`으로 적었지만, 실제로 `AnnotationConfigApplicationContext(Class...)` 경유가 아니라 수동 `register+refresh` 경로라 다른 예외로 나올 수 있다 — Step 6 로그의 실제 첫 줄과 반드시 맞춘다. 58은 어느 fico_* 룰에도 AOP 프록시 예외가 없을 가능성이 높다 — 없으면 `rule:` 생략.)

---

### Task D1: 트랜잭션 전파·타임아웃 (케이스 60~64, 5개)

**Files:**
- Create (target): `flogcase/Case60TxMandatoryTest.java`
- Create (target): `flogcase/Case61TxUnexpectedRollbackTest.java`
- Create (target): `flogcase/Case62TxNestedNotSupportedTest.java`
- Create (target): `flogcase/Case63TxTimeoutTest.java`
- Create (target): `flogcase/Case64TxNoManagerTest.java`
- Create (target): `f-log-cases/case-60-tx-mandatory.yaml` ~ `case-64-tx-no-manager.yaml` (5개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1). H2 `JdbcDataSource` + `DataSourceTransactionManager` + `TransactionTemplate` — Spring 컨텍스트(`ApplicationContext`) 불필요, 순수 객체 조합.

- [ ] **Step 1: Case60 — MANDATORY인데 기존 트랜잭션 없음**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** f-log case-60: PROPAGATION_MANDATORY로 실행했는데 이미 진행 중인 트랜잭션이 없다. */
class Case60TxMandatoryTest {

    @Test
    void txMandatory() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog60;DB_CLOSE_DELAY=-1");
        DataSourceTransactionManager txManager = new DataSourceTransactionManager(ds);
        TransactionTemplate tpl = new TransactionTemplate(txManager);
        tpl.setPropagationBehavior(TransactionDefinition.PROPAGATION_MANDATORY);

        IllegalTransactionStateException e = assertThrows(IllegalTransactionStateException.class,
                () -> tpl.execute(status -> null));

        CaseLog.write("case-60-tx-mandatory", TransactionTemplate.class, "트랜잭션 필수(MANDATORY)인데 기존 트랜잭션 없음", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-60-tx-mandatory.log"));
        assertTrue(log.contains("IllegalTransactionStateException"), log);
        assertTrue(log.contains("mandatory") || log.contains("Case60TxMandatoryTest"), log);
    }
}
```

- [ ] **Step 2: Case61 — 전역 rollback-only인데 커밋 시도**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.UnexpectedRollbackException;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * f-log case-61: 내부(참여) 트랜잭션이 rollback-only로 마킹된 채 정상 반환하면, 외부가 커밋을
 * 시도할 때 Spring이 "조용히 롤백됐다"는 사실을 숨기지 않고 UnexpectedRollbackException을 던진다.
 */
class Case61TxUnexpectedRollbackTest {

    @Test
    void txUnexpectedRollback() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog61;DB_CLOSE_DELAY=-1");
        DataSourceTransactionManager txManager = new DataSourceTransactionManager(ds);
        TransactionTemplate outer = new TransactionTemplate(txManager); // 기본 PROPAGATION_REQUIRED
        TransactionTemplate inner = new TransactionTemplate(txManager); // 같은 매니저 — 같은 트랜잭션에 참여

        UnexpectedRollbackException e = assertThrows(UnexpectedRollbackException.class, () -> outer.execute(outerStatus -> {
            inner.execute(innerStatus -> {
                innerStatus.setRollbackOnly(); // 내부가 rollback-only로 마킹하고 정상 반환(예외 없음)
                return null;
            });
            return null; // 외부는 이 상태를 모른 채 커밋을 시도한다
        }));

        CaseLog.write("case-61-tx-unexpected-rollback", TransactionTemplate.class, "커밋 실패 내부 rollback-only 마킹", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-61-tx-unexpected-rollback.log"));
        assertTrue(log.contains("UnexpectedRollbackException"), log);
        assertTrue(log.contains("rollback-only") || log.contains("Case61TxUnexpectedRollbackTest"), log);
    }
}
```

- [ ] **Step 3: Case62 — NESTED 미지원**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.NestedTransactionNotSupportedException;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * f-log case-62: DataSourceTransactionManager는 기본으로 nestedTransactionAllowed=true지만,
 * 이 설정을 명시적으로 꺼둔 상태(팀 컨벤션으로 세이브포인트를 금지하는 경우 등)에서
 * PROPAGATION_NESTED를 쓰면 실패한다.
 */
class Case62TxNestedNotSupportedTest {

    @Test
    void txNestedNotSupported() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog62;DB_CLOSE_DELAY=-1");
        DataSourceTransactionManager txManager = new DataSourceTransactionManager(ds);
        txManager.setNestedTransactionAllowed(false); // 명시적으로 끔 — 고의

        TransactionTemplate outer = new TransactionTemplate(txManager);
        TransactionTemplate nested = new TransactionTemplate(txManager);
        nested.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);

        NestedTransactionNotSupportedException e = assertThrows(NestedTransactionNotSupportedException.class,
                () -> outer.execute(outerStatus -> nested.execute(nestedStatus -> null)));

        CaseLog.write("case-62-tx-nested-not-supported", TransactionTemplate.class, "중첩 트랜잭션 실패 nestedTransactionAllowed=false", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-62-tx-nested-not-supported.log"));
        assertTrue(log.contains("NestedTransactionNotSupportedException"), log);
        assertTrue(log.contains("nestedTransactionAllowed") || log.contains("Case62TxNestedNotSupportedTest"), log);
    }
}
```

- [ ] **Step 4: Case63 — 트랜잭션 타임아웃**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.TransactionTimedOutException;
import org.springframework.transaction.support.TransactionTemplate;

/** f-log case-63: 트랜잭션 타임아웃(1초)을 넘긴 뒤 같은 트랜잭션 안에서 JDBC 호출을 계속한다. */
class Case63TxTimeoutTest {

    @Test
    void txTimeout() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog63;DB_CLOSE_DELAY=-1");
        DataSourceTransactionManager txManager = new DataSourceTransactionManager(ds);
        TransactionTemplate tpl = new TransactionTemplate(txManager);
        tpl.setTimeout(1); // 1초
        JdbcTemplate jdbc = new JdbcTemplate(ds);

        TransactionTimedOutException e = assertThrows(TransactionTimedOutException.class, () -> tpl.execute(status -> {
            try {
                Thread.sleep(1500); // 타임아웃보다 오래 대기
            } catch (InterruptedException ignored) {
            }
            jdbc.execute("SELECT 1"); // 타임아웃 초과 후 JDBC 호출 — 여기서 던져진다
            return null;
        }));

        CaseLog.write("case-63-tx-timeout", TransactionTemplate.class, "트랜잭션 타임아웃 초과 timeout=1s", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-63-tx-timeout.log"));
        assertTrue(log.contains("TransactionTimedOutException"), log);
        assertTrue(log.contains("timed out") || log.contains("Case63TxTimeoutTest"), log);
    }
}
```

- [ ] **Step 5: Case64 — TransactionTemplate에 매니저 미설정**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionTemplate;

/** f-log case-64: TransactionTemplate을 트랜잭션 매니저 없이 생성해 바로 실행한다. */
class Case64TxNoManagerTest {

    @Test
    void txNoManager() throws Exception {
        TransactionTemplate tpl = new TransactionTemplate(); // transactionManager 미설정 — 고의

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> tpl.execute(status -> null));

        CaseLog.write("case-64-tx-no-manager", TransactionTemplate.class, "트랜잭션 템플릿 실행 실패 transactionManager 미설정", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-64-tx-no-manager.log"));
        assertTrue(log.contains("IllegalArgumentException"), log);
        assertTrue(log.contains("transactionManager") || log.contains("Case64TxNoManagerTest"), log);
    }
}
```

- [ ] **Step 6: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case6[0-4]*' -q`
Expected: BUILD SUCCESSFUL. 로그 5개.

- [ ] **Step 7: 룰 확인 후 골든 YAML 5개**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_transaction.md`

```yaml
# case-60-tx-mandatory.yaml
log: logs/f-log-cases/case-60-tx-mandatory.log
exception: org.springframework.transaction.IllegalTransactionStateException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case60TxMandatoryTest.java"]
cause_symbol: txMandatory
fix_keywords_any: ["MANDATORY", "트랜잭션", "propagation"]
rule: fico_transaction
```
```yaml
# case-61-tx-unexpected-rollback.yaml
log: logs/f-log-cases/case-61-tx-unexpected-rollback.log
exception: org.springframework.transaction.UnexpectedRollbackException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case61TxUnexpectedRollbackTest.java"]
cause_symbol: txUnexpectedRollback
fix_keywords_any: ["rollback-only", "롤백", "커밋"]
rule: fico_transaction
```
```yaml
# case-62-tx-nested-not-supported.yaml
log: logs/f-log-cases/case-62-tx-nested-not-supported.log
exception: org.springframework.transaction.NestedTransactionNotSupportedException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case62TxNestedNotSupportedTest.java"]
cause_symbol: txNestedNotSupported
fix_keywords_any: ["nestedTransactionAllowed", "중첩", "NESTED"]
rule: fico_transaction
```
```yaml
# case-63-tx-timeout.yaml
log: logs/f-log-cases/case-63-tx-timeout.log
exception: org.springframework.transaction.TransactionTimedOutException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case63TxTimeoutTest.java"]
cause_symbol: txTimeout
fix_keywords_any: ["timeout", "타임아웃", "초과"]
rule: fico_transaction
```
```yaml
# case-64-tx-no-manager.yaml
log: logs/f-log-cases/case-64-tx-no-manager.log
exception: java.lang.IllegalArgumentException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case64TxNoManagerTest.java"]
cause_symbol: txNoManager
fix_keywords_any: ["transactionManager", "설정", "TransactionTemplate"]
```
(64는 `fico_transaction`이 `IllegalArgumentException`을 안 잡을 가능성이 높다 — 범용 타입이라 Phase 2 교훈대로 실제 매칭 없으면 `rule:` 생략.)

---

### Task D2: 낙관적 락 · DB 동시성 · 비동기 경계 (케이스 65~69, 5개)

**Files:**
- Create (target): `flogcase/Case65TxOptimisticLockTest.java`
- Create (target): `flogcase/Case66DbDeadlockTest.java`
- Create (target): `flogcase/Case67DbLockTimeoutTest.java`
- Create (target): `flogcase/Case68AsyncExceptionBoundaryTest.java`
- Create (target): `flogcase/Case69ExecutorRejectedTest.java`
- Create (target): `f-log-cases/case-65-tx-optimistic-lock.yaml` ~ `case-69-executor-rejected.yaml` (5개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1).

- [ ] **Step 1: Case65 — 수동 낙관적 락 검사 실패**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Statement;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.dao.OptimisticLockingFailureException;

/**
 * f-log case-65: version 컬럼으로 수동 낙관적 락을 구현했는데, 오래된 version으로 UPDATE해서
 * 0행이 갱신된다 — 앱 코드가 영향받은 행 수를 확인하고 OptimisticLockingFailureException을 던진다.
 */
class Case65TxOptimisticLockTest {

    @Test
    void txOptimisticLock() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog65;DB_CLOSE_DELAY=-1");
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c65 (id VARCHAR(10) PRIMARY KEY, val VARCHAR(20), version INT)");
            s.execute("INSERT INTO tlab_c65 VALUES ('A1', 'old', 2)"); // 실제 버전은 2
        }

        OptimisticLockingFailureException e = assertThrows(OptimisticLockingFailureException.class, () -> {
            try (Connection c = ds.getConnection();
                    PreparedStatement ps = c.prepareStatement(
                            "UPDATE tlab_c65 SET val = ?, version = version + 1 WHERE id = ? AND version = ?")) {
                ps.setString(1, "new");
                ps.setString(2, "A1");
                ps.setInt(3, 1); // 오래된 version(1)으로 시도 — 실제는 2
                int updated = ps.executeUpdate();
                if (updated == 0) {
                    throw new OptimisticLockingFailureException("낙관적 락 충돌 id=A1 expectedVersion=1");
                }
            }
        });

        CaseLog.write("case-65-tx-optimistic-lock", PreparedStatement.class, "낙관적 락 충돌 id=A1 expectedVersion=1", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-65-tx-optimistic-lock.log"));
        assertTrue(log.contains("OptimisticLockingFailureException"), log);
        assertTrue(log.contains("expectedVersion") || log.contains("Case65TxOptimisticLockTest"), log);
    }
}
```

- [ ] **Step 2: Case66 — 두 스레드 반대 순서 갱신(교착)**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.h2.jdbc.JdbcSQLTransactionRollbackException;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/**
 * f-log case-66: 스레드1이 행A→행B 순서로, 스레드2가 행B→행A 순서로 갱신 — 서로의 두 번째
 * 잠금을 기다리며 교착에 빠지고, H2가 감지해 둘 중 하나에 JdbcSQLTransactionRollbackException을 던진다.
 * CountDownLatch로 "둘 다 첫 잠금을 쥔 뒤에만" 두 번째 갱신을 시도하도록 강제해 타이밍 요행에 기대지 않는다.
 */
class Case66DbDeadlockTest {

    @Test
    void dbDeadlock() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog66;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=4000");
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c66 (id VARCHAR(10) PRIMARY KEY, val VARCHAR(10))");
            s.execute("INSERT INTO tlab_c66 VALUES ('A', '0'), ('B', '0')");
        }

        CountDownLatch bothFirstLockHeld = new CountDownLatch(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<Exception> t1 = pool.submit(() -> lockThenCross(ds, "A", "B", bothFirstLockHeld));
            Future<Exception> t2 = pool.submit(() -> lockThenCross(ds, "B", "A", bothFirstLockHeld));

            Exception e1 = t1.get(10, TimeUnit.SECONDS);
            Exception e2 = t2.get(10, TimeUnit.SECONDS);
            Exception deadlockEx = (e1 != null) ? e1 : e2;

            assertTrue(deadlockEx != null, "두 스레드 중 적어도 하나는 교착 예외를 받아야 한다");
            assertTrue(deadlockEx instanceof JdbcSQLTransactionRollbackException, deadlockEx.toString());

            CaseLog.write("case-66-db-deadlock", Statement.class, "교착 상태 감지 두 스레드 반대 순서 갱신", deadlockEx);
            String log = Files.readString(Path.of("logs/f-log-cases/case-66-db-deadlock.log"));
            assertTrue(log.contains("JdbcSQLTransactionRollbackException") || log.contains("Deadlock"), log);
            assertTrue(log.contains("Case66DbDeadlockTest"), log);
        } finally {
            pool.shutdownNow();
        }
    }

    /** first를 잠그고 latch를 내린 뒤, 둘 다 first를 쥘 때까지 기다렸다가 second를 잠근다. 실패하면 그 예외를 반환. */
    private static Exception lockThenCross(JdbcDataSource ds, String first, String second, CountDownLatch latch) {
        try (Connection c = ds.getConnection()) {
            c.setAutoCommit(false);
            try (Statement s = c.createStatement()) {
                s.executeUpdate("UPDATE tlab_c66 SET val = val || 'x' WHERE id = '" + first + "'");
                latch.countDown();
                latch.await(10, TimeUnit.SECONDS);
                s.executeUpdate("UPDATE tlab_c66 SET val = val || 'y' WHERE id = '" + second + "'");
                c.commit();
                return null; // 교착의 "승자" — 예외 없이 완료
            }
        } catch (Exception e) {
            return e; // 교착의 "패자" — H2가 던진 예외
        }
    }
}
```
주의: 이 케이스가 가장 타이밍에 민감하다 — `t1.get(10, TimeUnit.SECONDS)`가 시간 초과되면 `LOCK_TIMEOUT`(4000ms)보다 넉넉하게 잡혀 있는지, `CountDownLatch(2)`가 정확히 "두 스레드 모두 첫 잠금을 쥔 시점"에 풀리는지 재확인한다. 만약 실행이 불안정하면(가끔 타임아웃) `LOCK_TIMEOUT`을 늘리거나 `t1.get`의 대기 시간을 늘린다 — 절대 `Thread.sleep`으로 순서를 흉내내지 않는다(레이스 컨디션).

- [ ] **Step 3: Case67 — 락 타임아웃(단일 대기)**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.h2.jdbc.JdbcSQLTimeoutException;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** f-log case-67: 다른 스레드가 커밋하지 않은 채 행을 잠근 상태에서, 이 스레드가 LOCK_TIMEOUT을 넘겨 대기한다. */
class Case67DbLockTimeoutTest {

    @Test
    void dbLockTimeout() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog67;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=500");
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c67 (id VARCHAR(10) PRIMARY KEY, val VARCHAR(10))");
            s.execute("INSERT INTO tlab_c67 VALUES ('A1', '0')");
        }

        CountDownLatch holderLocked = new CountDownLatch(1);
        CountDownLatch testDone = new CountDownLatch(1);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            pool.submit(() -> {
                try (Connection c = ds.getConnection()) {
                    c.setAutoCommit(false);
                    try (Statement s = c.createStatement()) {
                        s.executeUpdate("UPDATE tlab_c67 SET val = '1' WHERE id = 'A1'");
                        holderLocked.countDown();
                        testDone.await(10, TimeUnit.SECONDS); // 테스트가 끝날 때까지 커밋하지 않고 잠금 유지
                    }
                } catch (Exception ignored) {
                }
            });
            holderLocked.await(10, TimeUnit.SECONDS);

            JdbcSQLTimeoutException e;
            try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
                c.setAutoCommit(false);
                e = assertThrows(JdbcSQLTimeoutException.class,
                        () -> s.executeUpdate("UPDATE tlab_c67 SET val = '2' WHERE id = 'A1'"));
            }

            CaseLog.write("case-67-db-lock-timeout", Statement.class, "락 대기 시간 초과 LOCK_TIMEOUT=500ms", e);
        } finally {
            testDone.countDown();
            pool.shutdownNow();
        }

        String log = Files.readString(Path.of("logs/f-log-cases/case-67-db-lock-timeout.log"));
        assertTrue(log.contains("JdbcSQLTimeoutException"), log);
        assertTrue(log.contains("Case67DbLockTimeoutTest"), log);
    }
}
```

- [ ] **Step 4: Case68 — CompletableFuture 내부 예외의 스레드 경계**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import org.junit.jupiter.api.Test;

/** f-log case-68: supplyAsync 안에서 던진 예외가 CompletionException으로 감싸져 호출 스레드로 전파된다. */
class Case68AsyncExceptionBoundaryTest {

    @Test
    void asyncExceptionBoundary() throws Exception {
        CompletableFuture<String> future = CompletableFuture.supplyAsync(() -> {
            throw new IllegalStateException("비동기 작업 실패 accountNo=1234567890");
        });

        CompletionException e = assertThrows(CompletionException.class, future::join);

        CaseLog.write("case-68-async-exception-boundary", CompletableFuture.class, "비동기 작업 실패 join 시점 전파", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-68-async-exception-boundary.log"));
        assertTrue(log.contains("CompletionException"), log);
        assertTrue(log.contains("IllegalStateException") || log.contains("accountNo=1234567890"), log);
    }
}
```

- [ ] **Step 5: Case69 — 스레드풀 큐 초과**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

/** f-log case-69: 스레드 1개, 큐 용량 1인 실행기에 3건을 제출 — 세 번째가 거부된다. */
class Case69ExecutorRejectedTest {

    @Test
    void executorRejected() throws Exception {
        CountDownLatch block = new CountDownLatch(1);
        ThreadPoolExecutor pool = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(1));
        try {
            pool.submit(() -> { // 1건: 스레드 점유(블로킹)
                try {
                    block.await();
                } catch (InterruptedException ignored) {
                }
            });
            pool.submit(() -> {}); // 2건: 큐에 들어감(용량 1)

            RejectedExecutionException e = assertThrows(RejectedExecutionException.class,
                    () -> pool.submit(() -> {})); // 3건: 큐도 가득 참 — 거부

            CaseLog.write("case-69-executor-rejected", ThreadPoolExecutor.class, "작업 거부 큐 용량 초과 core=1 queue=1", e);
        } finally {
            block.countDown();
            pool.shutdownNow();
        }

        String log = Files.readString(Path.of("logs/f-log-cases/case-69-executor-rejected.log"));
        assertTrue(log.contains("RejectedExecutionException"), log);
        assertTrue(log.contains("Case69ExecutorRejectedTest"), log);
    }
}
```

- [ ] **Step 6: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case6[5-9]*' -q`
Expected: BUILD SUCCESSFUL. 로그 5개. **66이 실패하거나 타임아웃하면 주의사항대로 타이밍값을 조정해 재시도한다 — 케이스를 포기하지 않는다(가장 어려운 카탈로그 항목이라 ★★★로 표시돼 있다).**

- [ ] **Step 7: 룰 확인 후 골든 YAML 5개**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_mybatis.md /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_datasource.md`

```yaml
# case-65-tx-optimistic-lock.yaml
log: logs/f-log-cases/case-65-tx-optimistic-lock.log
exception: org.springframework.dao.OptimisticLockingFailureException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case65TxOptimisticLockTest.java"]
cause_symbol: txOptimisticLock
fix_keywords_any: ["version", "낙관적", "optimistic", "충돌"]
rule: fico_mybatis
```
```yaml
# case-66-db-deadlock.yaml
log: logs/f-log-cases/case-66-db-deadlock.log
exception: org.h2.jdbc.JdbcSQLTransactionRollbackException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case66DbDeadlockTest.java"]
cause_symbol: dbDeadlock
fix_keywords_any: ["교착", "deadlock", "순서", "order"]
```
```yaml
# case-67-db-lock-timeout.yaml
log: logs/f-log-cases/case-67-db-lock-timeout.log
exception: org.h2.jdbc.JdbcSQLTimeoutException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case67DbLockTimeoutTest.java"]
cause_symbol: dbLockTimeout
fix_keywords_any: ["LOCK_TIMEOUT", "잠금", "lock", "대기"]
rule: fico_datasource
```
```yaml
# case-68-async-exception-boundary.yaml
log: logs/f-log-cases/case-68-async-exception-boundary.log
exception: java.util.concurrent.CompletionException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case68AsyncExceptionBoundaryTest.java"]
cause_symbol: asyncExceptionBoundary
fix_keywords_any: ["비동기", "async", "join", "CompletableFuture"]
```
```yaml
# case-69-executor-rejected.yaml
log: logs/f-log-cases/case-69-executor-rejected.log
exception: java.util.concurrent.RejectedExecutionException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case69ExecutorRejectedTest.java"]
cause_symbol: executorRejected
fix_keywords_any: ["큐", "queue", "거부", "rejected", "풀"]
```
(65의 `OptimisticLockingFailureException`이 `org.springframework.dao.DataAccessException`의 하위 타입이라 `fico_mybatis`의 `*DataAccessException` 패턴에 걸릴 가능성이 높다 — Phase 2 case-48과 같은 논리, Step 7에서 직접 확인. 66/67은 `fico_datasource`의 `*SQLException`/`*SQLTimeoutException`류 패턴을 확인한다 — 66의 `JdbcSQLTransactionRollbackException`은 현재 패턴에 없을 가능성이 높다, 없으면 생략하고 이번에도 결함이면 이전처럼 보고한다. 68/69는 순수 JDK 동시성 타입이라 어느 fico_* 룰도 안 걸릴 가능성이 높다 — 확인 후 없으면 생략.)

- [ ] **Step 8: 70개 전체 재실행으로 회귀 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline -q && ls on-test-lab-online/logs/f-log-cases/ | wc -l`
Expected: BUILD SUCCESSFUL, 로그 파일 수 70(기존 50 + 이번 20).

---

## Self-review 메모

- 카탈로그 §C(51~59, 9개)+§D(60~69, 10개)+§E 첫 행(70, 1개) = 20행 전부 Task C2(5)+C3(5)+D1(5)+D2(5) = 20으로 매핑됨.
- 트랜잭션(60~64)과 동시성(65~69)은 Spring 컨텍스트 없이 `DataSourceTransactionManager`/`TransactionTemplate`을 직접 조합 — AOP·`@Transactional` 어노테이션 불필요, 코드로 트랜잭션 경계를 명시하므로 재현이 결정적이다.
- 가장 위험한 케이스 66(데드락, ★★★)은 `CountDownLatch`로 "두 스레드가 각자 첫 잠금을 쥔 뒤에만" 교차 잠금을 시도하도록 강제해 타이밍 요행을 없앴다. 구현자에게 실패 시 포기하지 말고 타이밍 값 조정을 지시.
- 55(생성자 모호성), 51(순환 의존 정확한 예외 서브타입), 56(빈 재정의 실제 흐름)은 사전 완전 검증되지 않아 각 Step에 "실행 결과 보고 조정" 지시를 명시.
- `rule:` 필드는 Phase 2 최종 리뷰의 교훈(실제 매칭 확인 없이 생략 금지)을 모든 Step에 반영.
- Category E의 나머지(71~77)·F~H(78~100)는 이 계획의 범위 밖 — 후속 계획.
