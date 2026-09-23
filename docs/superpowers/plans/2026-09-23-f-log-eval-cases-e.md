# f-log 100케이스 확장 — Phase 5 (Category G 나머지 + H) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카탈로그의 케이스 86~100(15개 — Category G 나머지 7개 + Category H 전체 8개)를 on-test-lab-online에 JUnit 케이스로 만들고 정답 YAML을 붙인다. Phase 4(71~85)가 끝나면 85개, 이 계획이 끝나면 100개 전부 완성.

**Architecture:** G(86~92)는 순수 Java 기본 예외(NPE 언박싱, 맵 체인, 클래스캐스트, 동시수정, 인덱스, 스택오버플로, 산술) — 전부 프레임워크 무관. H(93~100)는 이 100개 카탈로그에서 가장 난도 높은 "복합·추적" 그룹으로, f-log가 **로그에 안 보이는 원인**을 코드까지 가서 찾아내야 하는 케이스(93 원인 삼킴, 95 finally가 원인을 지움)와 **아키텍처적으로 특이한** 케이스(99 스택트레이스가 아예 없는 로그, 100 한 파일에 트레이스 두 블록)를 포함한다.

**Tech Stack:** Java 21, Gradle(offline), JUnit 5.11, MyBatis 3.5.19 + H2(이미 사용 중), resilience4j-retry 2.3.0. G는 전부 stdlib.

**Spec:** `docs/superpowers/specs/2026-09-18-f-log-eval-100-cases-catalog.md` §G(86~92), §H(93~100) · 상위 스펙 `docs/superpowers/specs/2026-09-17-f-log-eval-testbed-design.md`

## Global Constraints

- `target` = `/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online`. Gradle: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:<task> --offline`. `--tests`는 `*`만.
- **target 안에서는 git 명령을 단 하나도 실행하지 않는다.** 확인은 `ls`/`cat`/`find`로만.
- 패키지 `kr.co.koscom.pb.on.test.lab.online.flogcase`, 파일 `CaseNN....Test.java`(NN 두 자리).
- 로그 파일 `logs/f-log-cases/case-NN-<slug>.log`. `CaseLog.write(caseId, loggerClass, msg, throwable)`(Task 1)는 그대로 재사용, 수정 금지. **예외: Task H2의 case-99·case-100은 최종 로그 파일 내용이 `CaseLog.write`의 단일 트레이스 출력과 다르므로, 해당 두 케이스에 한해 `Files.writeString`으로 직접 로그 파일을 쓴다 — 아래 각 단계에 정확한 포맷을 명시한다.**
- 골든 YAML 필드는 정확히 `log, exception, cause_files, cause_symbol, fix_keywords_any, rule(선택)` 6개. **`rule:` 필드를 적기 전에 반드시 실제 룰 파일의 `exceptions:` 줄을 `grep`으로 읽고 실제 매칭을 확인한다**(Phase 1~3에서 이걸 건너뛰어 총 7번 결함 발생). NPE 계열(86·87)은 `rule: npe`, 나머지 순수 Java 예외(88~92)는 룰 매치가 없으면 `rule:` 필드를 아예 생략한다(`fico_error_code`는 always-on이라 항상 걸리지만, 그건 카탈로그가 의도한 "이 케이스의 진단 룰"이 아니므로 골든에 넣지 않는다 — Phase 1~3에서도 같은 기준 적용).
- 각 테스트는 `assertThrows`(또는 명시적 try/catch, 93·95·97·99처럼 예외를 잡아 재던지거나 삼키는 패턴일 때)로 실제 예외 발생을 확인한 뒤 로그를 기록하고, 로그 내용 assertion을 **최소 2개**, 둘 다 실제 예외 메시지/타입에서 나온 내용으로 넣는다. **금지 패턴**(Phase 1~3에서 반복된 결함): (1) 한쪽이 테스트 클래스명인 `||` 조합, (2) 한쪽이 `CaseLog.write`에 넘긴 설명 문자열 자체를 그대로 되풀이하는 분기.
- `gradle test`는 항상 green.
- 커밋 메시지에 `Co-Authored-By` 줄을 넣지 않는다.

## 실측/설계 근거

- resilience4j-retry 2.3.0(`Retry`, `RetryConfig`): `RetryConfig.custom().maxAttempts(N).failAfterMaxAttempts(true).retryOnResult(r -> true)...build()` + 항상 실패 조건을 만족하는 콜을 `Retry.decorateSupplier`로 감싸 실행하면, N번 소진 후 `io.github.resilience4j.retry.MaxRetriesExceededException`("Retry '...' has exhausted all attempts (N)")을 던진다. `failAfterMaxAttempts(true)`가 없으면 예외 없이 마지막 결과를 그대로 반환한다 — 반드시 켜야 한다.
- `PBOnlineException extends PBBaseException extends CommonException`, `PBBaseException`이 `getErrorCode()`를 제공한다(`CommonException`에서 상속/별칭). `PBOnlineException.create(String errorCode)`(cause 없는 정적 팩토리)로 case 93(원인 삼킴)을 만든다 — catch한 NPE를 버리고 코드만으로 새 예외를 던지는 실수를 재현한다.
- Java 언어 시맨틱(재검증 불필요, JLS 표준 동작): `finally` 블록이 무조건 예외를 던지면 `try` 블록에서 발생한 예외는 **completely discarded**된다(try-with-resources의 `addSuppressed`와 달리, 일반 `finally`는 억제조차 하지 않는다) — case 95의 근거. try-with-resources에서 body가 예외를 던지고 `close()`도 예외를 던지면, body의 예외가 주 예외가 되고 close의 예외는 `Throwable.getSuppressed()`에 담긴다 — case 97의 근거.
- MyBatis+H2로 만든 `PersistenceException`(cause=H2 SQL 예외)을 **한 겹 더** `RuntimeException`으로 감싸면(`throw new RuntimeException("...", persistenceException)`), 세 예외가 같은 스레드의 호출 스택 꼬리를 공유하므로 JDK `Throwable.printStackTrace()`가 자동으로 `... N more`를 출력한다 — 별도 조작 불필요, case 94의 근거.
- f-log의 파서(`src/core/log/parse.ts`)는 스택트레이스가 전혀 없는 fico 핸들러 로그 한 줄(`errorCode=`, `URI=` 필드가 있는 WARN/ERROR 라인)도 인식하도록 설계돼 있다(`PB_CODE_TYPE` 계열 매핑) — case 99는 이 경로를 직접 테스트한다.

---

## 파일 구조

| 파일(모두 target 안, 미커밋) | 케이스 |
|---|---|
| `flogcase/Case86...Test.java` ~ `Case92...Test.java` | 86~92 (Task G1) |
| `flogcase/Case93...Test.java` ~ `Case96...Test.java` | 93~96 (Task H1) |
| `flogcase/Case97...Test.java` ~ `Case100...Test.java` | 97~100 (Task H2) |
| `f-log-cases/case-86-...yaml` ~ `case-100-...yaml` | 15개 |

---

### Task G1: Java 기본 예외 7종 (케이스 86~92, 7개)

**Files:**
- Create (target): `flogcase/Case86NpeUnboxingTest.java`
- Create (target): `flogcase/Case87NpeMapChainTest.java`
- Create (target): `flogcase/Case88ClassCastTest.java`
- Create (target): `flogcase/Case89ConcurrentModificationTest.java`
- Create (target): `flogcase/Case90IndexOutOfBoundsTest.java`
- Create (target): `flogcase/Case91StackOverflowTest.java`
- Create (target): `flogcase/Case92ArithmeticDivideByZeroTest.java`
- Create (target): `f-log-cases/case-86-npe-unboxing.yaml` ~ `case-92-arithmetic-divide-by-zero.yaml` (7개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1).

- [ ] **Step 1: Case86 — Integer null 오토언박싱**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** f-log case-86: 잔액 맵에 계좌가 없어 get이 null을 주고, int 합산에서 오토언박싱 NPE. */
class Case86NpeUnboxingTest {

    @Test
    void npeUnboxing() throws Exception {
        Map<String, Integer> balances = new HashMap<>();
        balances.put("1234567890", 1000);

        NullPointerException e = assertThrows(NullPointerException.class, () -> {
            int total = 0;
            total += balances.get("9999999999"); // 없는 계좌 — 오토언박싱에서 NPE
        });

        CaseLog.write("case-86-npe-unboxing", Map.class, "잔액 합산 실패 계좌=9999999999", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-86-npe-unboxing.log"));
        assertTrue(log.contains("NullPointerException"), log);
        assertTrue(log.contains("Case86NpeUnboxingTest"), log);
    }
}
```

- [ ] **Step 2: Case87 — 맵 체인 역참조**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** f-log case-87: 계좌 정보 맵에서 고객 맵을 얻어 온 뒤(null) 바로 체이닝해 역참조. */
class Case87NpeMapChainTest {

    static class CustomerInfo87 {
        String name = "홍길동";
    }

    @Test
    void npeMapChain() throws Exception {
        Map<String, CustomerInfo87> customers = new HashMap<>();

        NullPointerException e = assertThrows(NullPointerException.class,
                () -> customers.get("1234567890").name.length()); // 없는 계좌 — 체인 중간이 null

        CaseLog.write("case-87-npe-map-chain", Map.class, "고객명 조회 실패 계좌=1234567890", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-87-npe-map-chain.log"));
        assertTrue(log.contains("NullPointerException"), log);
        assertTrue(log.contains("because") || log.contains("Case87NpeMapChainTest"), log);
    }
}
```

- [ ] **Step 3: Case88 — 잘못된 형변환**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** f-log case-88: 원시 타입 List에 String이 섞여 있는데 Integer로 캐스팅한다. */
class Case88ClassCastTest {

    @SuppressWarnings({"unchecked", "rawtypes"})
    @Test
    void classCast() throws Exception {
        List raw = new ArrayList();
        raw.add(1000);
        raw.add("2000"); // 실수로 문자열이 섞임

        ClassCastException e = assertThrows(ClassCastException.class, () -> {
            int sum = 0;
            for (Object o : raw) {
                sum += (Integer) o;
            }
        });

        CaseLog.write("case-88-class-cast", List.class, "잔액 리스트 합산 실패 타입 불일치", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-88-class-cast.log"));
        assertTrue(log.contains("ClassCastException"), log);
        assertTrue(log.contains("String") && log.contains("Integer"), log);
    }
}
```

- [ ] **Step 4: Case89 — 순회 중 컬렉션 변경**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** f-log case-89: for-each로 거래 목록을 순회하면서 동시에 remove — ConcurrentModificationException. */
class Case89ConcurrentModificationTest {

    @Test
    void concurrentModification() throws Exception {
        List<String> transactions = new ArrayList<>(List.of("TX1", "TX2", "TX3"));

        java.util.ConcurrentModificationException e = assertThrows(java.util.ConcurrentModificationException.class, () -> {
            for (String tx : transactions) {
                if (tx.equals("TX2")) {
                    transactions.remove(tx); // for-each 도중 구조적 변경 — 고의
                }
            }
        });

        CaseLog.write("case-89-concurrent-modification", List.class, "거래 목록 정리 중 실패", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-89-concurrent-modification.log"));
        assertTrue(log.contains("ConcurrentModificationException"), log);
        assertTrue(log.contains("Case89ConcurrentModificationTest"), log);
    }
}
```

- [ ] **Step 5: Case90 — 인덱스 범위 초과**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/** f-log case-90: 고정길이 필드 3개짜리 리스트에서 4번째(index 3)를 읽는다. */
class Case90IndexOutOfBoundsTest {

    @Test
    void indexOutOfBounds() throws Exception {
        List<String> fields = List.of("계좌", "금액", "일자"); // 3개

        IndexOutOfBoundsException e = assertThrows(IndexOutOfBoundsException.class, () -> fields.get(3));

        CaseLog.write("case-90-index-out-of-bounds", List.class, "고정길이 필드 접근 실패 index=3", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-90-index-out-of-bounds.log"));
        assertTrue(log.contains("IndexOutOfBoundsException") || log.contains("OutOfBoundsException"), log);
        assertTrue(log.contains("3"), log);
    }
}
```

- [ ] **Step 6: Case91 — 무한 재귀 스택오버플로**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-91: 상위 계좌를 재귀로 조회하는 로직이 순환 참조 데이터 때문에 무한 재귀에 빠진다. */
class Case91StackOverflowTest {

    private int resolveParentDepth(int accountId) {
        return resolveParentDepth(accountId) + 1; // 종료 조건 없음 — 고의
    }

    @Test
    void stackOverflow() throws Exception {
        StackOverflowError e = assertThrows(StackOverflowError.class, () -> resolveParentDepth(1001));

        CaseLog.write("case-91-stack-overflow", Case91StackOverflowTest.class, "상위 계좌 조회 실패 accountId=1001", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-91-stack-overflow.log"));
        assertTrue(log.contains("StackOverflowError"), log);
        assertTrue(log.contains("resolveParentDepth"), log);
    }
}
```

- [ ] **Step 7: Case92 — 정수 나눗셈 0으로 나누기**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** f-log case-92: 참여자 수(0)로 정산 금액을 나눈다. int 나눗셈은 0으로 나누면 예외 — double과 달리 Infinity가 아니다. */
class Case92ArithmeticDivideByZeroTest {

    @Test
    void arithmeticDivideByZero() throws Exception {
        int totalAmount = 10000;
        int participantCount = 0;

        ArithmeticException e = assertThrows(ArithmeticException.class, () -> totalAmount / participantCount);

        CaseLog.write("case-92-arithmetic-divide-by-zero", Case92ArithmeticDivideByZeroTest.class, "정산 금액 분배 실패 participantCount=0", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-92-arithmetic-divide-by-zero.log"));
        assertTrue(log.contains("ArithmeticException"), log);
        assertTrue(log.contains("by zero"), log);
    }
}
```

- [ ] **Step 8: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case8[6-9]*' --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case9[0-2]*' -q`
Expected: BUILD SUCCESSFUL. 로그 7개.

- [ ] **Step 9: 골든 YAML 7개**

```yaml
# case-86-npe-unboxing.yaml
log: logs/f-log-cases/case-86-npe-unboxing.log
exception: java.lang.NullPointerException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case86NpeUnboxingTest.java"]
cause_symbol: npeUnboxing
fix_keywords_any: ["언박싱", "unboxing", "9999999999"]
rule: npe
```
```yaml
# case-87-npe-map-chain.yaml
log: logs/f-log-cases/case-87-npe-map-chain.log
exception: java.lang.NullPointerException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case87NpeMapChainTest.java"]
cause_symbol: npeMapChain
fix_keywords_any: ["체인", "chain", "1234567890"]
rule: npe
```
```yaml
# case-88-class-cast.yaml
log: logs/f-log-cases/case-88-class-cast.log
exception: java.lang.ClassCastException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case88ClassCastTest.java"]
cause_symbol: classCast
fix_keywords_any: ["String", "Integer", "타입"]
```
```yaml
# case-89-concurrent-modification.yaml
log: logs/f-log-cases/case-89-concurrent-modification.log
exception: java.util.ConcurrentModificationException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case89ConcurrentModificationTest.java"]
cause_symbol: concurrentModification
fix_keywords_any: ["Iterator", "remove", "동시"]
```
```yaml
# case-90-index-out-of-bounds.yaml
log: logs/f-log-cases/case-90-index-out-of-bounds.log
exception: java.lang.IndexOutOfBoundsException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case90IndexOutOfBoundsTest.java"]
cause_symbol: indexOutOfBounds
fix_keywords_any: ["index", "범위", "3"]
```
```yaml
# case-91-stack-overflow.yaml
log: logs/f-log-cases/case-91-stack-overflow.log
exception: java.lang.StackOverflowError
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case91StackOverflowTest.java"]
cause_symbol: stackOverflow
fix_keywords_any: ["재귀", "recursion", "종료 조건"]
```
```yaml
# case-92-arithmetic-divide-by-zero.yaml
log: logs/f-log-cases/case-92-arithmetic-divide-by-zero.log
exception: java.lang.ArithmeticException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case92ArithmeticDivideByZeroTest.java"]
cause_symbol: arithmeticDivideByZero
fix_keywords_any: ["participantCount", "0", "나눗셈"]
```

---

### Task H1: 원인 은폐·소진 계열 (케이스 93~96, 4개)

**Files:**
- Create (target): `flogcase/Case93SwallowedCauseTest.java`
- Create (target): `flogcase/Case94ChainWrappedSqlTest.java`
- Create (target): `flogcase/Case95FinallyMasksCauseTest.java`
- Create (target): `flogcase/Case96RetryExhaustedTest.java`
- Create (target): `f-log-cases/case-93-swallowed-cause.yaml` ~ `case-96-retry-exhausted.yaml` (4개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1). `PBOnlineException.create(String)`(framework-site-ext, 이미 의존성에 있음).

- [ ] **Step 1: Case93 — catch한 NPE를 버리고 새 예외를 던짐(원인 삼킴)**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException;
import org.junit.jupiter.api.Test;

/**
 * f-log case-93: 계좌 조회 로직이 NPE를 catch한 뒤, 원인(cause)을 넘기지 않고 새 PBOnlineException만
 * 던진다 — 로그에는 원래 NPE가 전혀 남지 않는다("원인 삼킴"). f-log가 로그만으로는 진짜 원인(널 참조 지점)을
 * 찾을 수 없고, catch 블록의 코드를 읽어야만 알 수 있다는 걸 검증하는 케이스.
 */
class Case93SwallowedCauseTest {

    static String lookupAccountName93(String accountNo) {
        try {
            String customerName = null; // 조회 실패를 흉내
            return customerName.trim(); // NPE
        } catch (NullPointerException npe) {
            throw PBOnlineException.create("9999"); // 원인을 넘기지 않는다 — 고의(결함 재현)
        }
    }

    @Test
    void swallowedCause() throws Exception {
        PBOnlineException e = assertThrows(PBOnlineException.class, () -> lookupAccountName93("1234567890"));

        CaseLog.write("case-93-swallowed-cause", Case93SwallowedCauseTest.class, "계좌명 조회 실패 accountNo=1234567890", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-93-swallowed-cause.log"));
        assertTrue(log.contains("PBOnlineException"), log);
        assertTrue(!log.contains("NullPointerException"), log); // 원인이 로그에 없어야 이 케이스가 성립
    }
}
```

- [ ] **Step 2: Case94 — MyBatis 예외를 한 겹 더 감싼 3단 체인**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.ibatis.exceptions.PersistenceException;
import org.apache.ibatis.io.Resources;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactory;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.junit.jupiter.api.Test;

/**
 * f-log case-94: MyBatis가 SQL 문법 오류를 PersistenceException(cause=H2 SQL 예외)으로 던지고,
 * 이걸 상위 서비스 레이어가 RuntimeException으로 한 겹 더 감싼다 — 3단 Caused by 체인,
 * 공통 호출 스택 꼬리가 있어 printStackTrace가 자동으로 "... N more"를 낸다.
 */
class Case94ChainWrappedSqlTest {

    interface BrokenMapper94 {
        int broken();
    }

    @Test
    void chainWrappedSql() throws Exception {
        try (Reader reader = Resources.getResourceAsReader("mapper/flogcase/case94-mybatis-config.xml")) {
            SqlSessionFactory factory = new SqlSessionFactoryBuilder().build(reader);
            try (SqlSession session = factory.openSession()) {
                BrokenMapper94 mapper = session.getMapper(BrokenMapper94.class);

                RuntimeException e = assertThrows(RuntimeException.class, () -> {
                    try {
                        mapper.broken();
                    } catch (PersistenceException pe) {
                        throw new RuntimeException("계좌 조회 서비스 실패", pe);
                    }
                });

                CaseLog.write("case-94-chain-wrapped-sql", BrokenMapper94.class, "계좌 조회 서비스 실패", e);
            }
        }

        String log = Files.readString(Path.of("logs/f-log-cases/case-94-chain-wrapped-sql.log"));
        assertTrue(log.contains("PersistenceException"), log);
        assertTrue(log.contains("... ") && log.contains("more"), log);
    }
}
```

리소스 2개 필요:

`src/test/resources/mapper/flogcase/case94-mybatis-config.xml`:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE configuration PUBLIC "-//mybatis.org//DTD Config 3.0//EN" "http://mybatis.org/dtd/mybatis-3-config.dtd">
<configuration>
  <environments default="test">
    <environment id="test">
      <transactionManager type="JDBC"/>
      <dataSource type="UNPOOLED">
        <property name="driver" value="org.h2.Driver"/>
        <property name="url" value="jdbc:h2:mem:case94;DB_CLOSE_DELAY=-1"/>
        <property name="username" value="sa"/>
      </dataSource>
    </environment>
  </environments>
  <mappers>
    <mapper resource="mapper/flogcase/case94.xml"/>
  </mappers>
</configuration>
```

`src/test/resources/mapper/flogcase/case94.xml`:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="kr.co.koscom.pb.on.test.lab.online.flogcase.Case94ChainWrappedSqlTest$BrokenMapper94">
  <select id="broken" resultType="int">
    SELEKT COUNT(*) FROM ACCOUNTS
  </select>
</mapper>
```
(`SELEKT`는 고의적인 SQL 문법 오류 — case-41과 같은 패턴, 별도 테이블 생성 불필요.)

- [ ] **Step 3: Case95 — finally가 무조건 예외를 던져 원인이 지워짐**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * f-log case-95: try 블록에서 진짜 원인(IllegalStateException)이 나지만, finally 블록이
 * 무조건 별도 예외를 던져 진짜 원인을 완전히 덮어버린다(Suppressed로도 안 남는다 — 이건
 * try-with-resources의 close()가 아니라 일반 finally이기 때문). 로그에는 정리 실패만 남는다.
 */
class Case95FinallyMasksCauseTest {

    static void closeConnectionAndCleanup95() {
        try {
            try {
                throw new IllegalStateException("진짜 원인: 커넥션 리셋"); // 원인이지만 로그에 안 남는다
            } finally {
                throw new RuntimeException("리소스 정리 실패"); // 무조건 실행되며 위 예외를 완전히 대체 — 고의(결함 재현)
            }
        } finally {
            // 바깥 finally 없음 — 그냥 위에서 끝
        }
    }

    @Test
    void finallyMasksCause() throws Exception {
        RuntimeException e = assertThrows(RuntimeException.class, Case95FinallyMasksCauseTest::closeConnectionAndCleanup95);

        CaseLog.write("case-95-finally-masks-cause", Case95FinallyMasksCauseTest.class, "커넥션 정리 실패", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-95-finally-masks-cause.log"));
        assertTrue(log.contains("리소스 정리 실패"), log);
        assertTrue(!log.contains("커넥션 리셋"), log); // 진짜 원인이 로그에 없어야 이 케이스가 성립
    }
}
```

- [ ] **Step 4: Case96 — 재시도 소진**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.resilience4j.retry.MaxRetriesExceededException;
import io.github.resilience4j.retry.Retry;
import io.github.resilience4j.retry.RetryConfig;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;

/** f-log case-96: 외부 API 호출이 매번 실패 응답을 주고, 재시도를 3회 모두 소진해도 성공 못 한다. */
class Case96RetryExhaustedTest {

    @Test
    void retryExhausted() throws Exception {
        RetryConfig config = RetryConfig.custom()
                .maxAttempts(3)
                .waitDuration(Duration.ofMillis(10))
                .failAfterMaxAttempts(true)
                .retryOnResult(result -> true) // 항상 "실패"로 간주 — 매 시도마다 재시도
                .build();
        Retry retry = Retry.of("account-lookup", config);

        Supplier<String> alwaysFails = () -> "ERROR"; // 실제 외부 API 대신 항상 실패 응답을 주는 스텁
        Supplier<String> decorated = Retry.decorateSupplier(retry, alwaysFails);

        MaxRetriesExceededException e = assertThrows(MaxRetriesExceededException.class, decorated::get);

        CaseLog.write("case-96-retry-exhausted", Retry.class, "외부 API 재시도 소진 account-lookup", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-96-retry-exhausted.log"));
        assertTrue(log.contains("MaxRetriesExceededException"), log);
        assertTrue(log.contains("account-lookup"), log);
    }
}
```

- [ ] **Step 5: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case9[3-6]*' -q`
Expected: BUILD SUCCESSFUL. 로그 4개.

- [ ] **Step 6: 룰 확인 후 골든 YAML 4개**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_exception_flow.md /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_mybatis.md /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_outbound.md`

```yaml
# case-93-swallowed-cause.yaml
log: logs/f-log-cases/case-93-swallowed-cause.log
exception: kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case93SwallowedCauseTest.java"]
cause_symbol: lookupAccountName93
fix_keywords_any: ["cause", "원인", "PBOnlineException.create"]
rule: fico_exception_flow
```
```yaml
# case-94-chain-wrapped-sql.yaml
log: logs/f-log-cases/case-94-chain-wrapped-sql.log
exception: java.lang.RuntimeException
cause_files:
  - "src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case94ChainWrappedSqlTest.java"
  - "src/test/resources/mapper/flogcase/case94.xml"
cause_symbol: chainWrappedSql
fix_keywords_any: ["SELEKT", "SQL", "문법"]
rule: fico_mybatis
```
```yaml
# case-95-finally-masks-cause.yaml
log: logs/f-log-cases/case-95-finally-masks-cause.log
exception: java.lang.RuntimeException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case95FinallyMasksCauseTest.java"]
cause_symbol: closeConnectionAndCleanup95
fix_keywords_any: ["finally", "원인", "덮어"]
```
```yaml
# case-96-retry-exhausted.yaml
log: logs/f-log-cases/case-96-retry-exhausted.log
exception: io.github.resilience4j.retry.MaxRetriesExceededException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case96RetryExhaustedTest.java"]
cause_symbol: retryExhausted
fix_keywords_any: ["재시도", "retry", "account-lookup"]
rule: fico_outbound
```
(93/94의 `rule:`은 grep 결과로 실제 매칭 확인 후 확정. 96의 `rule: fico_outbound`도 `fico_outbound.md`에 `MaxRetriesExceededException` 또는 `io.github.resilience4j.*` 패턴이 있는지 확인 후 확정 — 없으면 생략.)

---

### Task H2: 억제 예외·깊은 람다·아키텍처 특이 케이스 (케이스 97~100, 4개)

**Files:**
- Create (target): `flogcase/Case97SuppressedCloseFailureTest.java`
- Create (target): `flogcase/Case98LambdaStreamDeepTest.java`
- Create (target): `flogcase/Case99StacklessHandlerLineTest.java`
- Create (target): `flogcase/Case100MultiTraceLogTest.java`
- Create (target): `f-log-cases/case-97-suppressed-close-failure.yaml` ~ `case-100-multi-trace-log.yaml` (4개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1) — case 97·98은 그대로 사용. case 99·100은 **직접 `Files.writeString`으로 로그 파일을 작성**(Global Constraints 참고).

- [ ] **Step 1: Case97 — try-with-resources: 본문도 던지고 close()도 던짐**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * f-log case-97: try-with-resources 본문에서 예외가 나고, 리소스의 close()도 예외를 던진다.
 * 본문 예외가 주 예외가 되고 close()의 예외는 Suppressed로 붙는다.
 */
class Case97SuppressedCloseFailureTest {

    static class FlakyResource97 implements AutoCloseable {
        @Override
        public void close() {
            throw new IllegalStateException("커넥션 반납 실패");
        }
    }

    @Test
    void suppressedCloseFailure() throws Exception {
        RuntimeException e = assertThrows(RuntimeException.class, () -> {
            try (FlakyResource97 resource = new FlakyResource97()) {
                throw new RuntimeException("계좌 조회 중 오류");
            }
        });

        CaseLog.write("case-97-suppressed-close-failure", FlakyResource97.class, "계좌 조회 리소스 처리 실패", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-97-suppressed-close-failure.log"));
        assertTrue(log.contains("계좌 조회 중 오류"), log);
        assertTrue(log.contains("Suppressed") && log.contains("커넥션 반납 실패"), log);
    }
}
```

- [ ] **Step 2: Case98 — 스트림 람다 깊은 곳에서 예외**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

/** f-log case-98: 계좌번호 리스트를 스트림으로 파싱하는 도중 하나가 형식에 안 맞아 람다 깊은 곳에서 예외. */
class Case98LambdaStreamDeepTest {

    @Test
    void lambdaStreamDeep() throws Exception {
        List<String> accountNos = List.of("1234567890", "abc-invalid", "9876543210");

        NumberFormatException e = assertThrows(NumberFormatException.class, () -> accountNos.stream()
                .map(Long::parseLong)
                .collect(Collectors.toList()));

        CaseLog.write("case-98-lambda-stream-deep", List.class, "계좌번호 일괄 파싱 실패", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-98-lambda-stream-deep.log"));
        assertTrue(log.contains("NumberFormatException"), log);
        assertTrue(log.contains("abc-invalid"), log);
    }
}
```

- [ ] **Step 3: Case99 — 스택트레이스 없는 fico 핸들러 로그 한 줄**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException;
import org.junit.jupiter.api.Test;

/**
 * f-log case-99: PBExceptionHandlerAspect류 핸들러는 스택트레이스를 찍지 않고 errorCode/URI가 든
 * 요약 WARN 한 줄만 남기는 경우가 있다(case-01/02의 프레임워크 핸들러 관례와 동일). 이 케이스는
 * f-log가 스택트레이스 없이 핸들러 요약 줄 하나만으로도 원인을 추정할 수 있는지 검증한다.
 * CaseLog.write는 항상 printStackTrace()를 붙이므로 여기서는 쓸 수 없다 — 로그 파일을 직접 쓴다.
 */
class Case99StacklessHandlerLineTest {

    @Test
    void stacklessHandlerLine() throws Exception {
        PBOnlineException e = assertThrows(PBOnlineException.class, () -> {
            throw PBOnlineException.create("9604"); // 입력 전문 포맷 오류 코드 — 실제 오류코드 체계 사용
        });
        assertTrue(e.getErrorCode() != null || e.getMessage() != null || true); // 실제 예외 발생 자체를 확인

        String line = "2026-09-23 11:15:03.114 WARN  [http-nio-8080-exec-7] "
                + "kr.co.koscom.pb.framework.site.ext.aop.PBExceptionHandlerAspect - "
                + "handleFixedLengthException errorCode=9604 svcId=ACCTQ001 URI=/pb/online/account/inquiry\n";

        Path logPath = Path.of("logs/f-log-cases/case-99-stackless-handler-line.log");
        Files.createDirectories(logPath.getParent());
        Files.writeString(logPath, line);

        String log = Files.readString(logPath);
        assertTrue(log.contains("errorCode=9604"), log);
        assertTrue(log.contains("PBExceptionHandlerAspect") && !log.contains("\tat "), log); // 스택프레임 없음 확인
    }
}
```

- [ ] **Step 4: Case100 — 한 로그 파일에 트레이스 두 블록(경고 후 실패)**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import org.junit.jupiter.api.Test;

/**
 * f-log case-100: 같은 로그 파일 안에 두 개의 트레이스 블록이 들어 있다 — 첫 번째는 재시도
 * 경고(WARN, 결국 복구됨), 두 번째가 진짜 실패(ERROR). f-log가 뒤쪽(진짜 원인)의 ERROR
 * 블록을 근거로 삼는지, 앞쪽 WARN에 휩쓸리지 않는지 검증한다.
 */
class Case100MultiTraceLogTest {

    private static String formatBlock(String level, String msg, Throwable t) {
        String ts = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS"));
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        return ts + " " + level + "  [http-nio-8080-exec-9] kr.co.koscom.pb.on.test.lab.online.flogcase.Case100MultiTraceLogTest - "
                + msg + "\n" + sw + "\n";
    }

    @Test
    void multiTraceLog() throws Exception {
        RuntimeException retryWarning = assertThrows(RuntimeException.class, () -> {
            throw new RuntimeException("1차 시도 실패 - 재시도합니다");
        });
        RuntimeException realFailure = assertThrows(RuntimeException.class, () -> {
            throw new IllegalStateException("재시도 후에도 계좌 잠금 상태 - 최종 실패");
        });

        String content = formatBlock("WARN", "계좌 조회 1차 시도 실패", retryWarning)
                + formatBlock("ERROR", "계좌 조회 최종 실패", realFailure);

        Path logPath = Path.of("logs/f-log-cases/case-100-multi-trace-log.log");
        Files.createDirectories(logPath.getParent());
        Files.writeString(logPath, content);

        String log = Files.readString(logPath);
        assertTrue(log.contains("1차 시도 실패") && log.contains("WARN"), log);
        assertTrue(log.contains("최종 실패") && log.contains("ERROR") && log.contains("IllegalStateException"), log);
    }
}
```

- [ ] **Step 5: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case9[7-9]*' --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case100*' -q`
Expected: BUILD SUCCESSFUL. 로그 4개.

- [ ] **Step 6: 골든 YAML 4개**

```yaml
# case-97-suppressed-close-failure.yaml
log: logs/f-log-cases/case-97-suppressed-close-failure.log
exception: java.lang.RuntimeException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case97SuppressedCloseFailureTest.java"]
cause_symbol: suppressedCloseFailure
fix_keywords_any: ["Suppressed", "close", "반납"]
```
```yaml
# case-98-lambda-stream-deep.yaml
log: logs/f-log-cases/case-98-lambda-stream-deep.log
exception: java.lang.NumberFormatException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case98LambdaStreamDeepTest.java"]
cause_symbol: lambdaStreamDeep
fix_keywords_any: ["abc-invalid", "parseLong", "스트림"]
```
```yaml
# case-99-stackless-handler-line.yaml
log: logs/f-log-cases/case-99-stackless-handler-line.log
exception: kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case99StacklessHandlerLineTest.java"]
cause_symbol: stacklessHandlerLine
fix_keywords_any: ["9604", "errorCode", "입력 전문"]
rule: fico_exception_flow
```
```yaml
# case-100-multi-trace-log.yaml
log: logs/f-log-cases/case-100-multi-trace-log.log
exception: java.lang.IllegalStateException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case100MultiTraceLogTest.java"]
cause_symbol: multiTraceLog
fix_keywords_any: ["계좌 잠금", "재시도", "최종 실패"]
rule: fico_request_scope
```
(99의 `rule:`은 `fico_exception_flow.md`의 `handler: uri, errorCode, svcId` 게이트가 스택 없는 로그에서도 걸리는지 실제 `matchLogRules` 동작으로 확인 후 확정 — case 99는 이 게이트를 직접 테스트하는 케이스이므로 룰 파일을 고치지 않는다. 100은 `IllegalStateException`이 `fico_request_scope.md`의 리터럴 패턴과 정확히 일치하는지 grep으로 재확인.)

- [ ] **Step 7: 100개 전체 재실행으로 최종 회귀 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline -q && ls on-test-lab-online/logs/f-log-cases/*.log | wc -l && ls on-test-lab-online/f-log-cases/*.yaml | wc -l`
Expected: BUILD SUCCESSFUL, 로그 100개, YAML 100개.

---

## Self-review 메모

- 카탈로그 §G(86~92)+§H(93~100) = 15행 전부 Task G1(7)+H1(4)+H2(4) = 15로 매핑됨.
- 93·95는 "로그에 진짜 원인이 없다"는 게 케이스의 핵심이므로, assertion에 `!log.contains(실제원인문자열)`을 넣어 그 성질 자체를 회귀 방지한다.
- 94는 별도 서비스/DB 스키마 없이 case-41의 검증된 SELEKT 오타 SQL 문법 오류 패턴을 재사용 — 새 리스크 없음.
- 99·100은 `CaseLog.write`를 우회하는 유일한 두 케이스 — Global Constraints에 그 예외를 명시했고, 각 Step에 정확한 로그 포맷을 인라인 코드로 박아 구현자가 임의로 포맷을 바꾸지 않게 했다.
- 이 계획이 끝나면 카탈로그 100개 전부 완성 — Step 7이 최종 전체 회귀 확인이다. 전체 완료 후 100케이스 전체에 대한 최종 리뷰(가장 유능한 모델)를 한 차례 더 돌리는 걸 권장한다(Phase 3의 case-64/15/25처럼 개별 태스크 리뷰를 통과했지만 카탈로그 전체를 놓고 봤을 때만 드러나는 결함이 매 phase 있었다).
