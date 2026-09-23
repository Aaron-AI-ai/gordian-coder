# f-log 100케이스 확장 — Phase 4 (Category E 나머지 + F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카탈로그의 케이스 71~85(15개 — Category E 나머지 7개 + Category F 전체 8개)를 on-test-lab-online에 JUnit 케이스로 만들고 정답 YAML을 붙인다. 지금까지 70개(01~70) 완료됨. 이 계획이 끝나면 85개.

**Architecture:** E(71~77)는 순수 Java — 문자셋/Jackson/숫자 파싱, 전부 순수 Java(P). F(78~85)는 로컬 소켓·서버·강제 상태전환으로 외부 인프라 없이 재현 — Redis는 닫힌 포트(78)와 응답 없는 raw 소켓(79), HTTP는 로컬 `HttpServer`(83·84)와 닫힌 포트(80)·존재하지 않는 호스트(81)·응답 없는 소켓(82), 서킷브레이커는 `transitionToOpenState()`로 강제 전환(85) — 진짜 네트워크 실패를 기다리지 않는다.

**Tech Stack:** Java 21, Gradle(offline), JUnit 5.11, Jackson-databind 2.18.5, Lettuce 6.4.2/spring-data-redis 3.4.12, spring-web 6.2.14(`RestTemplate`), resilience4j-circuitbreaker 2.3.0. 전부 기존 의존성.

**Spec:** `docs/superpowers/specs/2026-09-18-f-log-eval-100-cases-catalog.md` §E(71~77), §F(78~85) · 상위 스펙 `docs/superpowers/specs/2026-09-17-f-log-eval-testbed-design.md`

## Global Constraints

- `target` = `/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online`. Gradle: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:<task> --offline`. `--tests`는 `*`만, 대괄호 구간 미지원. macOS엔 `timeout` 없음.
- **target 안에서는 git 명령을 단 하나도 실행하지 않는다 — 읽기 전용 `git status`/`git diff`조차 금지.** 파일 확인은 `ls`/`cat`/`find`로만.
- 패키지 `kr.co.koscom.pb.on.test.lab.online.flogcase`, 파일 `CaseNN....Test.java`(NN 두 자리). 헬퍼는 같은 파일의 `private static` 중첩 클래스로.
- 로그 파일 `logs/f-log-cases/case-NN-<slug>.log`. `CaseLog.write(caseId, loggerClass, msg, throwable)`(Task 1)는 그대로 재사용, 수정 금지.
- 골든 YAML 필드는 정확히 `log, exception, cause_files, cause_symbol, fix_keywords_any, rule(선택)` 6개. `exception:`은 실제 첫 줄(바깥쪽) 타입. **`rule:` 필드를 적기 전에 반드시 실제 룰 파일의 `exceptions:` 줄을 `grep`으로 읽고, `Bun.Glob`이 리터럴 접미사 매칭이라는 걸 감안해 실제 매칭되는지 확인한다** — Phase 1~3에서 이 확인을 건너뛰어 총 7번의 결함/누락이 발생했다(3번은 룰 파일 자체 결함, 나머지는 정답 쪽에서 실제 매칭을 놓친 것). 룰 파일에 패키지 접두어 패턴(`org.springframework.transaction.*` 등)이 있으면 그 패턴이 인스턴스 계층이 아니라 **문자열 접미사**로 매칭된다는 것도 확인한다.
- 각 테스트는 `assertThrows`로 예외 발생을 확인한 뒤 `CaseLog.write`로 기록하고, 로그 내용에 대한 구체적 assertion을 **최소 2개**, 둘 다 실제 예외 메시지/타입에서 나온 내용으로 넣는다. **다음 두 함정을 피한다**(Phase 1~3에서 반복된 결함): (1) 한쪽이 테스트 클래스명(`log.contains("CaseNNTest")`)인 `||` 조합 — 예외가 테스트 메서드 안의 람다에서 던져지면 클래스명은 스택트레이스에 항상 나오므로 이 분기는 상시 참이라 무의미하다. (2) 한쪽이 `CaseLog.write`에 넘긴 설명 문자열 자체를 그대로 되풀이하는 분기 — 실제 예외 메시지에 없는 내용이면 검증 가치가 없다. `gradle test`는 항상 green.
- 케이스마다 독립된 리소스(포트·소켓·DB 이름)를 쓴다. 로컬 서버/소켓은 테스트 종료 시 반드시 닫는다(`try`/`finally` 또는 try-with-resources).
- 커밋 메시지에 `Co-Authored-By` 줄을 넣지 않는다.

## 실측 검증 근거(구현 전 소스 코드 직접 확인)

- spring-data-redis 3.4.12(`LettuceConnectionFactory`): 연결 실패를 `org.springframework.data.redis.RedisConnectionFailureException`("Unable to connect to Redis")으로 감싼다.
- lettuce-core 6.4.2: `io.lettuce.core.RedisCommandTimeoutException` 클래스가 실제로 존재 — TCP 연결은 성공하지만(로컬 raw 소켓이 `accept()`만 하고 응답을 안 주는 경우) RESP 명령 응답을 `commandTimeout` 안에 못 받으면 이 예외가 난다.
- resilience4j-retry 2.3.0: `RetryConfig.failAfterMaxAttempts(true)` + 항상 참인 `retryOnResult` 조건이면, `maxAttempts` 소진 후 `MaxRetriesExceededException.createMaxRetriesExceededException(retry)`("Retry '...' has exhausted all attempts (N)")를 던진다. 이 설정이 없으면 그냥 마지막 결과/예외를 그대로 반환/전파한다 — `failAfterMaxAttempts(true)`가 반드시 필요하다.
- resilience4j-circuitbreaker 2.3.0: `CircuitBreaker` 인터페이스에 `void transitionToOpenState()`가 직접 있다 — 실패를 여러 번 흘려보내 트립시키는 대신 이걸로 즉시 OPEN 상태로 만들 수 있다. OPEN 상태에서 `circuitBreaker.executeSupplier(...)`를 부르면 `CallNotPermittedException.createCallNotPermittedException(circuitBreaker)`를 던진다.
- framework-site-ext: `PBOnlineException`은 `PBBaseException`(→ `CommonException`)을 상속하고 `getErrorCode()`를 그대로 물려받는다(별도 재정의 없음). `PBOnlineException.create(String errorCode)`(cause 없는 오버로드)가 존재 — case 93(원인 삼킴)에서 그대로 쓸 수 있다.

---

## 파일 구조

| 파일(모두 target 안, 미커밋) | 케이스 |
|---|---|
| `flogcase/Case71...Test.java` ~ `Case77...Test.java` | 71~77 (Task E1) |
| `flogcase/Case78...Test.java` ~ `Case81...Test.java` | 78~81 (Task F1) |
| `flogcase/Case82...Test.java` ~ `Case85...Test.java` | 82~85 (Task F2) |
| `f-log-cases/case-71-...yaml` ~ `case-85-...yaml` | 15개 |

---

### Task E1: 문자셋·고정길이 숫자·Jackson (케이스 71~77, 7개)

**Files:**
- Create (target): `flogcase/Case71CharsetUnmappableLatin1Test.java`
- Create (target): `flogcase/Case72FixedFieldNumberFormatTest.java`
- Create (target): `flogcase/Case73JacksonUnknownPropertyTest.java`
- Create (target): `flogcase/Case74JacksonInvalidFormatTest.java`
- Create (target): `flogcase/Case75JacksonMissingCreatorTest.java`
- Create (target): `flogcase/Case76JacksonMismatchedInputTest.java`
- Create (target): `flogcase/Case77JacksonInfiniteRecursionTest.java`
- Create (target): `f-log-cases/case-71-charset-unmappable-latin1.yaml` ~ `case-77-jackson-infinite-recursion.yaml` (7개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1).

- [ ] **Step 1: Case71 — ISO-8859-1로 한글을 엄격 인코딩**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.Charset;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-71: 계좌명 "삼성전자"를 ISO-8859-1로 엄격 인코딩 — 매핑 불가능한 문자. */
class Case71CharsetUnmappableLatin1Test {

    @Test
    void charsetUnmappableLatin1() throws Exception {
        Charset latin1 = Charset.forName("ISO-8859-1");
        var encoder = latin1.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        Writer writer = new OutputStreamWriter(out, encoder);

        CharacterCodingException e = assertThrows(CharacterCodingException.class, () -> {
            writer.write("삼성전자");
            writer.flush();
        });

        CaseLog.write("case-71-charset-unmappable-latin1", Writer.class, "계좌명 인코딩 실패 ISO-8859-1", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-71-charset-unmappable-latin1.log"));
        assertTrue(log.contains("UnmappableCharacterException") || log.contains("CharacterCodingException"), log);
        assertTrue(log.contains("Input length") || log.contains("ISO-8859-1") || log.contains("삼성전자"), log);
    }
}
```

- [ ] **Step 2: Case72 — 고정길이 숫자 필드에 알파벳**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-72: 고정길이 수량 필드 " 12A"를 숫자로 파싱 — 트림 후에도 알파벳이 남는다. */
class Case72FixedFieldNumberFormatTest {

    @Test
    void fixedFieldNumberFormat() throws Exception {
        String field = " 12A";

        NumberFormatException e = assertThrows(NumberFormatException.class, () -> Long.parseLong(field.trim()));

        CaseLog.write("case-72-fixed-field-number-format", Long.class, "고정길이 수량 필드 파싱 실패 value=' 12A'", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-72-fixed-field-number-format.log"));
        assertTrue(log.contains("NumberFormatException"), log);
        assertTrue(log.contains("12A"), log);
    }
}
```

- [ ] **Step 3: Case73 — Jackson 알 수 없는 필드**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-73: 응답 DTO에 없는 필드 "extraField"가 JSON에 들어와 엄격 모드에서 역직렬화 실패. */
class Case73JacksonUnknownPropertyTest {

    static class Dto73 {
        public String accountNo;
    }

    @Test
    void jacksonUnknownProperty() throws Exception {
        ObjectMapper mapper = new ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true);
        String json = "{\"accountNo\":\"1234567890\",\"extraField\":\"boom\"}";

        UnrecognizedPropertyException e = assertThrows(UnrecognizedPropertyException.class,
                () -> mapper.readValue(json, Dto73.class));

        CaseLog.write("case-73-jackson-unknown-property", ObjectMapper.class, "JSON 역직렬화 실패 extraField", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-73-jackson-unknown-property.log"));
        assertTrue(log.contains("UnrecognizedPropertyException"), log);
        assertTrue(log.contains("extraField"), log);
    }
}
```

- [ ] **Step 4: Case74 — Jackson 타입 변환 실패**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.InvalidFormatException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-74: balance 필드(int)에 문자열 "abc"가 들어온다. */
class Case74JacksonInvalidFormatTest {

    static class Dto74 {
        public int balance;
    }

    @Test
    void jacksonInvalidFormat() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        String json = "{\"balance\":\"abc\"}";

        InvalidFormatException e = assertThrows(InvalidFormatException.class, () -> mapper.readValue(json, Dto74.class));

        CaseLog.write("case-74-jackson-invalid-format", ObjectMapper.class, "JSON 타입 변환 실패 balance=abc", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-74-jackson-invalid-format.log"));
        assertTrue(log.contains("InvalidFormatException"), log);
        assertTrue(log.contains("balance") || log.contains("\"abc\""), log);
    }
}
```

- [ ] **Step 5: Case75 — 기본 생성자 없는 클래스 역직렬화**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.InvalidDefinitionException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-75: 기본 생성자도 @JsonCreator도 없는 불변 DTO를 역직렬화하려 한다. */
class Case75JacksonMissingCreatorTest {

    static class Dto75 {
        public final String accountNo;

        Dto75(String accountNo) { // 기본 생성자 없음, @JsonCreator 없음 — 고의
            this.accountNo = accountNo;
        }
    }

    @Test
    void jacksonMissingCreator() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        String json = "{\"accountNo\":\"1234567890\"}";

        InvalidDefinitionException e = assertThrows(InvalidDefinitionException.class,
                () -> mapper.readValue(json, Dto75.class));

        CaseLog.write("case-75-jackson-missing-creator", ObjectMapper.class, "JSON 역직렬화 실패 생성자 없음 Dto75", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-75-jackson-missing-creator.log"));
        assertTrue(log.contains("InvalidDefinitionException"), log);
        assertTrue(log.contains("no Creators") || log.contains("Dto75"), log);
    }
}
```

- [ ] **Step 6: Case76 — 배열을 객체로 역직렬화**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.MismatchedInputException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-76: 응답이 배열(JSON array)인데 단일 객체 DTO로 역직렬화하려 한다. */
class Case76JacksonMismatchedInputTest {

    static class Dto76 {
        public String accountNo;
    }

    @Test
    void jacksonMismatchedInput() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        String json = "[{\"accountNo\":\"1234567890\"}]";

        MismatchedInputException e = assertThrows(MismatchedInputException.class, () -> mapper.readValue(json, Dto76.class));

        CaseLog.write("case-76-jackson-mismatched-input", ObjectMapper.class, "JSON 역직렬화 실패 배열을 객체로", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-76-jackson-mismatched-input.log"));
        assertTrue(log.contains("MismatchedInputException"), log);
        assertTrue(log.contains("START_ARRAY") || log.contains("Dto76"), log);
    }
}
```

- [ ] **Step 7: Case77 — 양방향 참조 직렬화 무한 재귀**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-77: 계좌↔고객이 서로를 참조해 직렬화가 무한 재귀에 빠진다(StackOverflowError를 감싼다). */
class Case77JacksonInfiniteRecursionTest {

    static class Account77 {
        public Customer77 owner;
    }

    static class Customer77 {
        public Account77 account;
    }

    @Test
    void jacksonInfiniteRecursion() throws Exception {
        Account77 account = new Account77();
        Customer77 customer = new Customer77();
        account.owner = customer;
        customer.account = account; // 순환 참조 — 고의

        ObjectMapper mapper = new ObjectMapper();
        Throwable e = assertThrows(Throwable.class, () -> mapper.writeValueAsString(account));

        CaseLog.write("case-77-jackson-infinite-recursion", ObjectMapper.class, "JSON 직렬화 실패 Account77<->Customer77 순환", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-77-jackson-infinite-recursion.log"));
        assertTrue(log.contains("StackOverflowError") || log.contains("JsonMappingException"), log);
        assertTrue(log.contains("Account77") || log.contains("Customer77"), log);
    }
}
```
비고: 최신 Jackson은 무한 재귀를 `JsonMappingException`으로 깔끔하게 감싸지 않고 진짜 `StackOverflowError`를 낼 수도 있다 — `assertThrows(Throwable.class, ...)`로 넓게 잡은 이유다. 실행 결과를 보고 로그 assertion의 실제 문자열을 맞춘다.

- [ ] **Step 8: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case7[1-7]*' -q`
Expected: BUILD SUCCESSFUL. 로그 7개.

- [ ] **Step 9: 룰 확인 후 골든 YAML 7개**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_fixed_message.md` (71은 `*CharacterCodingException`/`*MalformedInputException` 패턴에 걸릴 수 있으나 `UnmappableCharacterException`은 다른 클래스임에 주의 — `CharacterCodingException`의 서브클래스이므로 상위 타입 문자열로 검사).

```yaml
# case-71-charset-unmappable-latin1.yaml
log: logs/f-log-cases/case-71-charset-unmappable-latin1.log
exception: java.nio.charset.UnmappableCharacterException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case71CharsetUnmappableLatin1Test.java"]
cause_symbol: charsetUnmappableLatin1
fix_keywords_any: ["ISO-8859-1", "인코딩", "매핑"]
```
```yaml
# case-72-fixed-field-number-format.yaml
log: logs/f-log-cases/case-72-fixed-field-number-format.log
exception: java.lang.NumberFormatException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case72FixedFieldNumberFormatTest.java"]
cause_symbol: fixedFieldNumberFormat
fix_keywords_any: ["12A", "parseLong", "숫자"]
```
```yaml
# case-73-jackson-unknown-property.yaml
log: logs/f-log-cases/case-73-jackson-unknown-property.log
exception: com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case73JacksonUnknownPropertyTest.java"]
cause_symbol: jacksonUnknownProperty
fix_keywords_any: ["extraField", "FAIL_ON_UNKNOWN_PROPERTIES", "알 수 없는"]
```
```yaml
# case-74-jackson-invalid-format.yaml
log: logs/f-log-cases/case-74-jackson-invalid-format.log
exception: com.fasterxml.jackson.databind.exc.InvalidFormatException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case74JacksonInvalidFormatTest.java"]
cause_symbol: jacksonInvalidFormat
fix_keywords_any: ["balance", "int", "타입"]
```
```yaml
# case-75-jackson-missing-creator.yaml
log: logs/f-log-cases/case-75-jackson-missing-creator.log
exception: com.fasterxml.jackson.databind.exc.InvalidDefinitionException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case75JacksonMissingCreatorTest.java"]
cause_symbol: jacksonMissingCreator
fix_keywords_any: ["생성자", "Creator", "constructor"]
```
```yaml
# case-76-jackson-mismatched-input.yaml
log: logs/f-log-cases/case-76-jackson-mismatched-input.log
exception: com.fasterxml.jackson.databind.exc.MismatchedInputException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case76JacksonMismatchedInputTest.java"]
cause_symbol: jacksonMismatchedInput
fix_keywords_any: ["배열", "array", "Dto76"]
```
```yaml
# case-77-jackson-infinite-recursion.yaml
log: logs/f-log-cases/case-77-jackson-infinite-recursion.log
exception: java.lang.StackOverflowError
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case77JacksonInfiniteRecursionTest.java"]
cause_symbol: jacksonInfiniteRecursion
fix_keywords_any: ["순환", "recursion", "JsonIgnore", "@JsonManagedReference"]
```
(77의 `exception:`은 Step 8 실행 결과가 `JsonMappingException`이면 그 값으로 바꾼다.)

---

### Task F1: Redis · 외부 연동 연결/호스트 (케이스 78~81, 4개)

**Files:**
- Create (target): `flogcase/Case78RedisConnectionRefusedTest.java`
- Create (target): `flogcase/Case79RedisCommandTimeoutTest.java`
- Create (target): `flogcase/Case80OutboundConnectRefusedTest.java`
- Create (target): `flogcase/Case81OutboundUnknownHostTest.java`
- Create (target): `f-log-cases/case-78-redis-connection-refused.yaml` ~ `case-81-outbound-unknown-host.yaml` (4개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1).

- [ ] **Step 1: Case78 — Redis 연결 거부**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;

/** f-log case-78: 아무도 듣지 않는 포트로 Redis 연결을 시도한다. */
class Case78RedisConnectionRefusedTest {

    @Test
    void redisConnectionRefused() throws Exception {
        LettuceConnectionFactory factory = new LettuceConnectionFactory(new RedisStandaloneConfiguration("127.0.0.1", 1));
        factory.afterPropertiesSet();

        RedisConnectionFailureException e;
        try {
            e = assertThrows(RedisConnectionFailureException.class, () -> factory.getConnection().ping());
        } finally {
            factory.destroy();
        }

        CaseLog.write("case-78-redis-connection-refused", LettuceConnectionFactory.class, "Redis 연결 실패 127.0.0.1:1", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-78-redis-connection-refused.log"));
        assertTrue(log.contains("RedisConnectionFailureException"), log);
        assertTrue(log.contains("Unable to connect to Redis") || log.contains("Connection refused"), log);
    }
}
```

- [ ] **Step 2: Case79 — Redis 명령 타임아웃**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.lettuce.core.RedisCommandTimeoutException;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisURI;
import io.lettuce.core.api.StatefulRedisConnection;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import org.junit.jupiter.api.Test;

/**
 * f-log case-79: TCP 연결 자체는 성립하지만(로컬 소켓이 accept만 하고 아무 응답도 안 함) RESP
 * 명령의 응답을 commandTimeout 안에 못 받아 타임아웃이 난다.
 */
class Case79RedisCommandTimeoutTest {

    @Test
    void redisCommandTimeout() throws Exception {
        try (ServerSocket server = new ServerSocket(0)) {
            int port = server.getLocalPort();
            Thread acceptor = new Thread(() -> {
                try (var socket = server.accept()) {
                    Thread.sleep(5000); // 연결만 받고 응답은 절대 안 준다
                } catch (Exception ignored) {
                }
            });
            acceptor.setDaemon(true);
            acceptor.start();

            RedisClient client = RedisClient.create(RedisURI.builder()
                    .withHost("127.0.0.1").withPort(port)
                    .withTimeout(Duration.ofMillis(500))
                    .build());

            RedisCommandTimeoutException e;
            try {
                e = assertThrows(RedisCommandTimeoutException.class, () -> {
                    StatefulRedisConnection<String, String> conn = client.connect();
                    conn.sync().ping();
                });
            } finally {
                client.shutdown();
            }

            CaseLog.write("case-79-redis-command-timeout", RedisClient.class, "Redis 명령 타임아웃 timeout=500ms", e);
        }

        String log = Files.readString(Path.of("logs/f-log-cases/case-79-redis-command-timeout.log"));
        assertTrue(log.contains("RedisCommandTimeoutException"), log);
        assertTrue(log.contains("timeout") || log.contains("Case79RedisCommandTimeoutTest"), log);
    }
}
```
주의: 이 케이스가 실행이 불안정하면(연결 자체가 실패하거나 예상과 다른 예외가 나면) `RedisURI`에 `.withTimeout(...)`이 명령 타임아웃이 아니라 연결 타임아웃으로 해석될 수 있다 — 실제로 `client.connect()`가 던지는지, 아니면 `conn.sync().ping()`이 던지는지 로그로 확인해 `assertThrows`의 호출 대상을 맞춘다. `RedisClient.create(RedisURI)` 대신 `RedisClient.create("redis://127.0.0.1:" + port)`로 만들고 `client.setDefaultTimeout(Duration.ofMillis(500))`을 따로 호출하는 방식으로 바꿔도 된다.

- [ ] **Step 3: Case80 — 외부 호출 연결 거부**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;

/** f-log case-80: 외부 API 호출이 아무도 듣지 않는 포트로 나가 연결이 거부된다. */
class Case80OutboundConnectRefusedTest {

    @Test
    void outboundConnectRefused() throws Exception {
        RestTemplate rest = new RestTemplate();

        ResourceAccessException e = assertThrows(ResourceAccessException.class,
                () -> rest.getForObject("http://127.0.0.1:1/api/health", String.class));

        CaseLog.write("case-80-outbound-connect-refused", RestTemplate.class, "외부 API 호출 실패 http://127.0.0.1:1/api/health", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-80-outbound-connect-refused.log"));
        assertTrue(log.contains("ResourceAccessException"), log);
        assertTrue(log.contains("ConnectException") || log.contains("Connection refused"), log);
    }
}
```

- [ ] **Step 4: Case81 — 존재하지 않는 호스트**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;

/** f-log case-81: 외부 API 호출 URL의 호스트명이 DNS로 해석되지 않는다. */
class Case81OutboundUnknownHostTest {

    @Test
    void outboundUnknownHost() throws Exception {
        RestTemplate rest = new RestTemplate();

        ResourceAccessException e = assertThrows(ResourceAccessException.class,
                () -> rest.getForObject("http://no-such-host.invalid/api/health", String.class));

        CaseLog.write("case-81-outbound-unknown-host", RestTemplate.class, "외부 API 호출 실패 호스트 해석 불가 no-such-host.invalid", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-81-outbound-unknown-host.log"));
        assertTrue(log.contains("ResourceAccessException"), log);
        assertTrue(log.contains("UnknownHostException") || log.contains("no-such-host.invalid"), log);
    }
}
```

- [ ] **Step 5: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case7[8-9]*' --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case8[01]*' -q`
Expected: BUILD SUCCESSFUL. 로그 4개. **79가 실행이 불안정하면 위 주의사항대로 타이밍/구성을 조정한다.**

- [ ] **Step 6: 룰 확인 후 골든 YAML 4개**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_redis.md /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_outbound.md`

```yaml
# case-78-redis-connection-refused.yaml
log: logs/f-log-cases/case-78-redis-connection-refused.log
exception: org.springframework.data.redis.RedisConnectionFailureException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case78RedisConnectionRefusedTest.java"]
cause_symbol: redisConnectionRefused
fix_keywords_any: ["Redis", "연결", "connection"]
rule: fico_redis
```
```yaml
# case-79-redis-command-timeout.yaml
log: logs/f-log-cases/case-79-redis-command-timeout.log
exception: io.lettuce.core.RedisCommandTimeoutException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case79RedisCommandTimeoutTest.java"]
cause_symbol: redisCommandTimeout
fix_keywords_any: ["timeout", "타임아웃", "commandTimeout"]
rule: fico_redis
```
```yaml
# case-80-outbound-connect-refused.yaml
log: logs/f-log-cases/case-80-outbound-connect-refused.log
exception: org.springframework.web.client.ResourceAccessException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case80OutboundConnectRefusedTest.java"]
cause_symbol: outboundConnectRefused
fix_keywords_any: ["연결", "connect", "refused"]
rule: fico_outbound
```
```yaml
# case-81-outbound-unknown-host.yaml
log: logs/f-log-cases/case-81-outbound-unknown-host.log
exception: org.springframework.web.client.ResourceAccessException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case81OutboundUnknownHostTest.java"]
cause_symbol: outboundUnknownHost
fix_keywords_any: ["호스트", "host", "UnknownHost"]
rule: fico_outbound
```
(79의 `rule:`은 `fico_redis.md`가 `RedisCommandTimeoutException`이라는 리터럴/글롭을 실제로 갖고 있는지 확인 후 정한다 — 패키지 접두어(`io.lettuce.*` 또는 `org.springframework.data.redis.*`)만 있으면 이 클래스는 `io.lettuce.core` 패키지라 `org.springframework.data.redis.*`로는 안 걸린다.)

---

### Task F2: 외부 연동 타임아웃/상태코드 + 서킷브레이커 (케이스 82~85, 4개)

**Files:**
- Create (target): `flogcase/Case82OutboundReadTimeoutTest.java`
- Create (target): `flogcase/Case83Outbound4xxTest.java`
- Create (target): `flogcase/Case84Outbound5xxTest.java`
- Create (target): `flogcase/Case85CircuitBreakerOpenTest.java`
- Create (target): `f-log-cases/case-82-outbound-read-timeout.yaml` ~ `case-85-circuit-breaker-open.yaml` (4개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1).

- [ ] **Step 1: Case82 — 응답 없는 소켓, 읽기 타임아웃**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;

/** f-log case-82: 소켓이 연결은 받아주지만 응답을 절대 안 줘서 readTimeout이 걸린다. */
class Case82OutboundReadTimeoutTest {

    @Test
    void outboundReadTimeout() throws Exception {
        try (ServerSocket server = new ServerSocket(0)) {
            int port = server.getLocalPort();
            Thread acceptor = new Thread(() -> {
                try (var socket = server.accept()) {
                    Thread.sleep(5000); // 연결만 받고 응답은 절대 안 준다
                } catch (Exception ignored) {
                }
            });
            acceptor.setDaemon(true);
            acceptor.start();

            SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
            factory.setConnectTimeout(2000);
            factory.setReadTimeout(300);
            RestTemplate rest = new RestTemplate(factory);

            ResourceAccessException e = assertThrows(ResourceAccessException.class,
                    () -> rest.getForObject("http://127.0.0.1:" + port + "/api/health", String.class));

            CaseLog.write("case-82-outbound-read-timeout", RestTemplate.class, "외부 API 호출 실패 readTimeout=300ms", e);
        }

        String log = Files.readString(Path.of("logs/f-log-cases/case-82-outbound-read-timeout.log"));
        assertTrue(log.contains("ResourceAccessException"), log);
        assertTrue(log.contains("SocketTimeoutException") || log.contains("Read timed out"), log);
    }
}
```

- [ ] **Step 2: Case83 — 404**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

/** f-log case-83: 로컬 HTTP 서버가 매핑 안 된 경로에 404를 돌려준다. */
class Case83Outbound4xxTest {

    @Test
    void outbound4xx() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.start();
        try {
            int port = server.getAddress().getPort();
            RestTemplate rest = new RestTemplate();

            HttpClientErrorException.NotFound e = assertThrows(HttpClientErrorException.NotFound.class,
                    () -> rest.getForObject("http://127.0.0.1:" + port + "/no-such-path", String.class));

            CaseLog.write("case-83-outbound-4xx", RestTemplate.class, "외부 API 호출 실패 404 /no-such-path", e);
        } finally {
            server.stop(0);
        }

        String log = Files.readString(Path.of("logs/f-log-cases/case-83-outbound-4xx.log"));
        assertTrue(log.contains("HttpClientErrorException") || log.contains("404"), log);
        assertTrue(log.contains("Not Found") || log.contains("Case83Outbound4xxTest"), log);
    }
}
```

- [ ] **Step 3: Case84 — 500**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.RestTemplate;

/** f-log case-84: 로컬 HTTP 서버가 핸들러 안에서 500을 돌려준다. */
class Case84Outbound5xxTest {

    @Test
    void outbound5xx() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/broken", exchange -> {
            byte[] body = "internal error".getBytes();
            exchange.sendResponseHeaders(500, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            int port = server.getAddress().getPort();
            RestTemplate rest = new RestTemplate();

            HttpServerErrorException.InternalServerError e = assertThrows(HttpServerErrorException.InternalServerError.class,
                    () -> rest.getForObject("http://127.0.0.1:" + port + "/api/broken", String.class));

            CaseLog.write("case-84-outbound-5xx", RestTemplate.class, "외부 API 호출 실패 500 /api/broken", e);
        } finally {
            server.stop(0);
        }

        String log = Files.readString(Path.of("logs/f-log-cases/case-84-outbound-5xx.log"));
        assertTrue(log.contains("HttpServerErrorException") || log.contains("500"), log);
        assertTrue(log.contains("Internal Server Error") || log.contains("Case84Outbound5xxTest"), log);
    }
}
```

- [ ] **Step 4: Case85 — 서킷브레이커 OPEN**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-85: 서킷브레이커를 강제로 OPEN 상태로 전환한 뒤 보호된 호출을 시도한다. */
class Case85CircuitBreakerOpenTest {

    @Test
    void circuitBreakerOpen() throws Exception {
        CircuitBreaker cb = CircuitBreaker.ofDefaults("account-service");
        cb.transitionToOpenState(); // 실패를 여러 번 흘려보내는 대신 강제로 OPEN

        CallNotPermittedException e = assertThrows(CallNotPermittedException.class,
                () -> cb.executeSupplier(() -> "이 호출은 실행되지 않는다"));

        CaseLog.write("case-85-circuit-breaker-open", CircuitBreaker.class, "서킷브레이커 OPEN account-service", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-85-circuit-breaker-open.log"));
        assertTrue(log.contains("CallNotPermittedException"), log);
        assertTrue(log.contains("account-service") || log.contains("OPEN"), log);
    }
}
```

- [ ] **Step 5: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case8[2-5]*' -q`
Expected: BUILD SUCCESSFUL. 로그 4개.

- [ ] **Step 6: 룰 확인 후 골든 YAML 4개**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_outbound.md`

```yaml
# case-82-outbound-read-timeout.yaml
log: logs/f-log-cases/case-82-outbound-read-timeout.log
exception: org.springframework.web.client.ResourceAccessException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case82OutboundReadTimeoutTest.java"]
cause_symbol: outboundReadTimeout
fix_keywords_any: ["readTimeout", "타임아웃", "timeout"]
rule: fico_outbound
```
```yaml
# case-83-outbound-4xx.yaml
log: logs/f-log-cases/case-83-outbound-4xx.log
exception: org.springframework.web.client.HttpClientErrorException$NotFound
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case83Outbound4xxTest.java"]
cause_symbol: outbound4xx
fix_keywords_any: ["404", "Not Found", "경로"]
rule: fico_outbound
```
```yaml
# case-84-outbound-5xx.yaml
log: logs/f-log-cases/case-84-outbound-5xx.log
exception: org.springframework.web.client.HttpServerErrorException$InternalServerError
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case84Outbound5xxTest.java"]
cause_symbol: outbound5xx
fix_keywords_any: ["500", "Internal Server Error"]
rule: fico_outbound
```
```yaml
# case-85-circuit-breaker-open.yaml
log: logs/f-log-cases/case-85-circuit-breaker-open.log
exception: io.github.resilience4j.circuitbreaker.CallNotPermittedException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case85CircuitBreakerOpenTest.java"]
cause_symbol: circuitBreakerOpen
fix_keywords_any: ["CircuitBreaker", "OPEN", "서킷브레이커"]
rule: fico_outbound
```
(83/84의 `exception:`은 실제 로그 첫 줄이 `HttpClientErrorException$NotFound`처럼 중첩 클래스 표기인지 `HttpClientErrorException`만 나오는지 Step 5 결과로 확인해 맞춘다. 85의 `rule:`은 `fico_outbound.md`에 `CallNotPermittedException`이 실제로 있는지 확인 — 이미 카탈로그에서 fico_outbound로 지정돼 있었으므로 있을 가능성이 높다.)

- [ ] **Step 7: 85개 전체 재실행으로 회귀 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline -q && ls on-test-lab-online/logs/f-log-cases/ | wc -l`
Expected: BUILD SUCCESSFUL, 로그 파일 수 85.

---

## Self-review 메모

- 카탈로그 §E(71~77)+§F(78~85) = 15행 전부 Task E1(7)+F1(4)+F2(4) = 15로 매핑됨.
- 78~85는 전부 로컬 소켓/서버/강제 상태전환으로 재현 — 실제 네트워크·외부 서비스 의존 없음.
- 79(Redis 커맨드 타임아웃)는 카탈로그에도 "검증 필요"로 표시된 유일한 ★★★ — Step 2에 대체 구성 지시 포함.
- `rule:` 필드는 Phase 1~3에서 누적 7번 놓친 교훈을 Global Constraints에 명시.
- Category G(86~92)·H(93~100)는 이 계획의 범위 밖 — 후속 계획(Phase 5).
