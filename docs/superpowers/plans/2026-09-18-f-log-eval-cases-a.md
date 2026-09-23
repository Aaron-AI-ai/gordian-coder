# f-log 100케이스 확장 — Phase 1 (Category A: 프레임워크 코드 위반) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카탈로그의 Category A(프레임워크 코드 위반, 케이스 04~34, 31개)를 on-test-lab-online에 JUnit 케이스로 만들고 정답 YAML을 붙인다. Category B~H는 이 계획의 범위 밖이며 후속 계획으로 진행한다.

**Architecture:** 각 케이스는 실제 fico 프레임워크 API를 오사용하는 JUnit 테스트 1개다. 오사용 호출 자체가 "버그"이므로 별도 프로덕션 서비스 코드는 만들지 않는다(케이스 03 bean-conflict와 같은 전례: 버그가 `src/test`의 테스트 지원 코드에 있어도 된다). 테스트는 `CaseLog.write`로 로그를 남기고, 골든 YAML의 `cause_files`는 그 테스트 파일 자신을, `cause_symbol`은 테스트 메서드명을 가리킨다 — 스택의 다른 프레임은 전부 프레임워크 jar 코드라 저장소에 대응 파일이 없기 때문이다.

**Tech Stack:** Java 21, Gradle(offline), JUnit 5.11, Spring 6.2(일부 케이스만 `AnnotationConfigApplicationContext`), fico-fwk-core 3.0.1-SNAPSHOT / fico-fwk-extension / framework-site-ext (전부 on-test-lab-online의 기존 의존성, 추가 없음).

**Spec:** `docs/superpowers/specs/2026-09-18-f-log-eval-100-cases-catalog.md` §A · 상위 스펙 `docs/superpowers/specs/2026-09-17-f-log-eval-testbed-design.md`

## Global Constraints

- `target` = `/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online`. Gradle: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:<task> --offline`. macOS엔 `timeout` 없음.
- **target은 절대 커밋하지 않는다** (그 레포는 전부 미추적 상태, 소유자가 결정). gordian-coder 쪽에 커밋할 파일은 이 계획에 없다(카탈로그는 이미 커밋됨).
- 패키지 `kr.co.koscom.pb.on.test.lab.online.flogcase`, 파일 `src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/CaseNN....java` (NN은 두 자리, 예 `Case04FixedStringLengthOverflowTest.java`). 헬퍼 클래스가 필요하면 같은 파일의 `private static` 중첩 클래스로 둔다 — 새 파일을 늘리지 않는다.
- 로그 파일 `logs/f-log-cases/case-NN-<slug>.log` (slug는 카탈로그의 ID에서 `fw-` 접두어를 뺀 나머지, 예 `case-04-fixed-string-length-overflow.log`). `CaseLog.write(caseId, loggerClass, msg, throwable)`은 이미 있다(Task 1) — 그대로 재사용, 수정 금지.
- 골든 YAML `f-log-cases/case-NN-<slug>.yaml`, 필드는 정확히 `log, exception, cause_files, cause_symbol, fix_keywords_any, rule(선택)` 6개. `cause_files`는 `["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/CaseNN....java"]` 하나만(달리 명시 없는 한). `exception`은 카탈로그의 "루트 예외" FQCN.
- 각 테스트는 예외 발생을 `assertThrows`로 확인한 뒤 `CaseLog.write`로 기록하고, 로그 내용에 대한 구체적 assertion을 최소 2개 넣는다(예외 클래스명, 메시지 일부, 또는 스택의 특정 프레임). `gradle test`는 항상 green이어야 한다(테스트가 예외 발생을 검증하지, 실패로 끝나지 않는다).
- import 대상 프레임워크 클래스가 컴파일 안 되면(존재하지 않거나 다른 패키지) 추측으로 바꾸지 말고 실제 소스(`/Users/koscom/workspace/fico/fico-fwk-core`, `/Users/koscom/workspace/fico/fico-fwk-extension`, `/Users/koscom/workspace/fico/framework-site-ext`)에서 `grep -rn 'class <Name>'`으로 확인한다. 그래도 안 되면(의존성 버전 문제) BLOCKED로 보고 — 임의로 케이스를 바꾸지 않는다.
- 케이스 15는 `@EnableTransactionManagement` + `AnnotationConfigApplicationContext`가 필요하다. 케이스 20·21은 **`FicoApplicationContextProvider`를 `@Component`로 등록해 스캔을 트리거하지 않는다** — 그 클래스에 `@ComponentScan(basePackages="kr.co.openlabs.fico.framework")`가 붙어 있어 무거운 실제 스캔이 돈다. 대신 빈 컨텍스트를 만들고 `new FicoApplicationContextProvider().setApplicationContext(ctx)`를 직접 호출해 홀더만 채운다(아래 Task A2 Step에 정확한 코드 있음).
- 커밋 메시지에 `Co-Authored-By` 줄을 넣지 않는다(사용자 규칙).

---

## 파일 구조

| 파일(모두 target 안, 미커밋) | 케이스 |
|---|---|
| `flogcase/Case04FixedStringLengthOverflowTest.java` ~ `Case14PagingConttrkeyIndexTest.java` | 04~14 (Task A1) |
| `flogcase/Case15ExtTransactionalMissingManagerTest.java` ~ `Case25NumberDecimalStringOverflowTest.java` | 15~25 (Task A2) |
| `flogcase/Case26StringInvalidPaddingDirectionTest.java` ~ `Case34CryptoFieldProcessorPropagationTest.java` | 26~34 (Task A3) |
| `f-log-cases/case-04-fixed-string-length-overflow.yaml` ~ `case-34-crypto-field-processor-propagation.yaml` | 각 케이스 1개 |

---

### Task A1: 고정길이 전문 · 컨버터 · 응답 · 페이징 (케이스 04~14, 11개)

**Files:**
- Create (target): `flogcase/Case04FixedStringLengthOverflowTest.java`
- Create (target): `flogcase/Case05FixedListSizeExceededTest.java`
- Create (target): `flogcase/Case06FixedListMissingSizeNotLastTest.java`
- Create (target): `flogcase/Case07FixedParseNoNoargCtorTest.java`
- Create (target): `flogcase/Case08FixedParseOversizeInputTest.java`
- Create (target): `flogcase/Case09FixedLongInvalidSignByteTest.java`
- Create (target): `flogcase/Case10FixedNestedVoBlockCountTest.java`
- Create (target): `flogcase/Case11PbresponseNullHeaderTest.java`
- Create (target): `flogcase/Case12ControllerAspectMissingHeaderTest.java`
- Create (target): `flogcase/Case13RequestScopeOutsideThreadTest.java`
- Create (target): `flogcase/Case14PagingConttrkeyIndexTest.java`
- Create (target): `f-log-cases/case-04-fixed-string-length-overflow.yaml` ~ `case-14-paging-conttrkey-index.yaml` (11개)

**Interfaces:**
- Consumes: `CaseLog.write(String, Class<?>, String, Throwable)` (이미 존재, Task 1).
- Produces: 없음(다음 태스크가 이 파일들을 참조하지 않음 — A1/A2/A3는 독립).

- [ ] **Step 1: Case04 — 고정 문자열 길이 초과**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData;
import kr.co.openlabs.fico.framework.utils.FormatterUtils;
import org.junit.jupiter.api.Test;

/** f-log case-04: @FixedString(length=5)에 5자 초과 값을 직렬화. */
class Case04FixedStringLengthOverflowTest {

    static class V {
        @FixedData(length = 5)
        String code = "TOO_LONG_VALUE";
    }

    @Test
    void fixedStringLengthOverflow() throws Exception {
        CommonException e = assertThrows(CommonException.class, () -> FormatterUtils.getFixedData(new V()));

        CaseLog.write("case-04-fixed-string-length-overflow", FormatterUtils.class, "고정길이 직렬화 실패 field=code", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-04-fixed-string-length-overflow.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case04FixedStringLengthOverflowTest"), log);
    }
}
```

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests '*Case04*' -q`
Expected: FAIL first (컴파일 전이면 스킵) — 이 Step은 바로 실행 가능한 코드이므로 최초 실행에서 BUILD SUCCESSFUL을 기대한다. 만약 `@FixedData`가 이 필드 타입/위치에서 원하는 메시지("length error")를 안 낸다면 `@FixedData`의 실제 검증 로직을(FormatterUtils.java:1018 부근) 읽고 메시지 문자열을 맞춰 assertion을 조정한다(예외 타입은 CommonException으로 고정).

- [ ] **Step 2: Case05 — 고정 리스트 크기 초과**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.internal.annotations.FixedList;
import kr.co.openlabs.fico.framework.utils.FormatterUtils;
import org.junit.jupiter.api.Test;

/** f-log case-05: @FixedList(size=2)에 3건을 채워 직렬화. */
class Case05FixedListSizeExceededTest {

    static class Lst {
        @FixedList(size = 2)
        List<String> items = List.of("A", "B", "C");
    }

    @Test
    void fixedListSizeExceeded() throws Exception {
        CommonException e = assertThrows(CommonException.class, () -> FormatterUtils.getFixedData(new Lst()));

        CaseLog.write("case-05-fixed-list-size-exceeded", FormatterUtils.class, "고정길이 리스트 직렬화 실패 field=items", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-05-fixed-list-size-exceeded.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case05FixedListSizeExceededTest"), log);
    }
}
```

- [ ] **Step 3: Case06 — size 없는 @FixedList가 마지막 필드가 아님**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData;
import kr.co.openlabs.fico.framework.internal.annotations.FixedList;
import kr.co.openlabs.fico.framework.utils.FormatterUtils;
import org.junit.jupiter.api.Test;

/** f-log case-06: size 없는 @FixedList가 마지막 필드가 아니면 길이를 계산할 수 없어 실패. */
class Case06FixedListMissingSizeNotLastTest {

    static class Bad {
        @FixedList
        List<String> items = List.of("A", "B");

        @FixedData(length = 3)
        String tail = "XYZ";
    }

    @Test
    void fixedListMissingSizeNotLast() throws Exception {
        CommonException e = assertThrows(CommonException.class, () -> FormatterUtils.getFixedData(new Bad()));

        CaseLog.write("case-06-fixed-list-missing-size-not-last", FormatterUtils.class, "고정길이 리스트 위치 오류 field=items", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-06-fixed-list-missing-size-not-last.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case06FixedListMissingSizeNotLastTest"), log);
    }
}
```

- [ ] **Step 4: Case07 — 기본 생성자 없는 VO로 파싱**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData;
import kr.co.openlabs.fico.framework.utils.FormatterUtils;
import kr.co.openlabs.fico.framework.utils.FormatterUtils.LengthCheck;
import org.junit.jupiter.api.Test;

/** f-log case-07: 기본 생성자가 없는 VO로 전문을 파싱하면 리플렉션 생성에 실패한다. */
class Case07FixedParseNoNoargCtorTest {

    static class NoCtor {
        @FixedData(length = 5)
        String x;

        NoCtor(int i) {
            this.x = String.valueOf(i);
        }
    }

    @Test
    void fixedParseNoNoargCtor() throws Exception {
        CommonException e = assertThrows(CommonException.class,
                () -> FormatterUtils.getFixedData("ABCDE", NoCtor.class, LengthCheck.NO_CHECK));

        CaseLog.write("case-07-fixed-parse-no-noarg-ctor", FormatterUtils.class, "고정길이 파싱 실패 type=NoCtor", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-07-fixed-parse-no-noarg-ctor.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case07FixedParseNoNoargCtorTest"), log);
    }
}
```

주의: `LengthCheck` enum 값은 `CHECK`와 그 반대(생략 검사) 두 개다. 실제 이름을 `FormatterUtils.java:93` 부근에서 확인하고 `NO_CHECK`가 아니면 실제 상수명으로 바꾼다(정확한 이름은 소스에 있다 — 추측하지 말고 `grep -n 'enum LengthCheck' -A6 .../FormatterUtils.java`로 확인).

- [ ] **Step 5: Case08 — 전문이 VO 최대 길이 초과**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData;
import kr.co.openlabs.fico.framework.utils.FormatterUtils;
import org.junit.jupiter.api.Test;

/** f-log case-08: 파싱할 전문 문자열이 VO가 정의한 최대 길이를 초과. */
class Case08FixedParseOversizeInputTest {

    static class V {
        @FixedData(length = 5)
        String code;
    }

    @Test
    void fixedParseOversizeInput() throws Exception {
        CommonException e = assertThrows(CommonException.class,
                () -> FormatterUtils.getFixedData("TOOLONGSTRING", V.class));

        CaseLog.write("case-08-fixed-parse-oversize-input", FormatterUtils.class, "고정길이 파싱 실패 길이초과", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-08-fixed-parse-oversize-input.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case08FixedParseOversizeInputTest"), log);
    }
}
```

- [ ] **Step 6: Case09 — 부호 바이트 불량**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData;
import kr.co.openlabs.fico.framework.utils.FormatterUtils;
import kr.co.openlabs.fico.framework.utils.FormatterUtils.LengthCheck;
import org.junit.jupiter.api.Test;

/** f-log case-09: 부호 있는 고정길이 숫자 필드의 부호 바이트가 +/-/0/space 가 아님. */
class Case09FixedLongInvalidSignByteTest {

    static class L {
        @FixedData(length = 5)
        Long amount;
    }

    @Test
    void fixedLongInvalidSignByte() throws Exception {
        CommonException e = assertThrows(CommonException.class,
                () -> FormatterUtils.getFixedData("A1234", L.class, LengthCheck.NO_CHECK));

        CaseLog.write("case-09-fixed-long-invalid-sign-byte", FormatterUtils.class, "고정길이 숫자 파싱 실패 부호바이트", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-09-fixed-long-invalid-sign-byte.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case09FixedLongInvalidSignByteTest"), log);
    }
}
```

주의: `@FixedData`가 `Long` 필드에 부호 옵션을 어떻게 표현하는지(별도 `signed` 속성이 있는지, 혹은 타입만으로 결정되는지) `FixedData` 어노테이션 정의(`kr.co.openlabs.fico.framework.internal.annotations.FixedData`)를 열어 확인한다. 속성명이 다르면 그 이름으로 바꾼다.

- [ ] **Step 7: Case10 — 중첩 @FixedVo 기본생성자 없음 → 늦은 오도(誤導) 실패**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.koscom.pb.framework.site.ext.converter.PBFixedDataConverter;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData;
import kr.co.openlabs.fico.framework.internal.annotations.FixedVo;
import org.junit.jupiter.api.Test;

/**
 * f-log case-10: 중첩 @FixedVo 클래스에 기본 생성자가 없으면 PBFixedDataConverter가 블록 길이를
 * 0으로 조용히 캐시하고(swallow), 그 결과 뒤에서 실제 원인과 무관한 파싱 메시지로 실패한다.
 */
class Case10FixedNestedVoBlockCountTest {

    static class Inner {
        @FixedData(length = 5)
        String code;

        Inner(String code) {
            this.code = code;
        } // 기본 생성자 없음 — 고의
    }

    static class Outer {
        @FixedVo
        Inner inner = new Inner("ABCDE");
    }

    @Test
    void fixedNestedVoBlockCount() throws Exception {
        CommonException e = assertThrows(CommonException.class,
                () -> PBFixedDataConverter.getBlockStringLength(Outer.class, "UTF-8"));

        CaseLog.write("case-10-fixed-nested-vo-block-count", PBFixedDataConverter.class,
                "중첩 VO 블록 길이 계산 실패 type=Outer.inner", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-10-fixed-nested-vo-block-count.log"));
        assertTrue(log.contains("Case10FixedNestedVoBlockCountTest"), log);
    }
}
```

주의: 브리핑 §A의 조사에서는 `getBlockStringLength`가 리플렉션 실패를 **침묵 삼킴(0 캐시)** 이라고 했다 — 즉 이 호출 자체는 예외를 던지지 않을 수 있다. 먼저 `assertThrows`로 시도해서 실패하면(즉 예외가 안 던져지면), 대신 `PBFixedDataConverter.stripBlockCounts(...)` 또는 `FormatterUtils.getFixedData("XXXXXXXXXX", Outer.class)`로 그 뒤 단계에서 발생하는 늦은 예외를 잡는 방향으로 바꾼다 — 정확한 메서드 시그니처는 `PBFixedDataConverter.java`에서 확인한다. 이 케이스가 예외 없이 끝나는 경로만 있다면(진짜 침묵), `assertDoesNotThrow`로 바꾸고 **YAML의 exception 필드를 CommonException 대신 실제 결과에 맞게 조정**하며 그 판단을 보고서에 남긴다.

- [ ] **Step 8: Case11 — PBResponse.success(null, data)**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.koscom.pb.framework.site.ext.model.fixed.PBResponse;
import org.junit.jupiter.api.Test;

/** f-log case-11: 컨트롤러가 param.getCommonHeader()가 null인 채로 PBResponse.success를 호출. */
class Case11PbresponseNullHeaderTest {

    @Test
    void pbresponseNullHeader() throws Exception {
        NullPointerException e = assertThrows(NullPointerException.class,
                () -> PBResponse.success(null, "any-data"));

        CaseLog.write("case-11-pbresponse-null-header", PBResponse.class, "응답 생성 실패 header=null", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-11-pbresponse-null-header.log"));
        assertTrue(log.contains("NullPointerException"), log);
        assertTrue(log.contains("Case11PbresponseNullHeaderTest"), log);
    }
}
```

- [ ] **Step 9: Case12 — 헤더 null로 ControllerAspect.onBeforeHandler**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.common.model.CommonRequest;
import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.extension.aspect.ControllerAspect;
import org.junit.jupiter.api.Test;

/** f-log case-12: commonHeader가 null인 요청으로 ControllerAspect.onBeforeHandler를 직접 호출. */
class Case12ControllerAspectMissingHeaderTest {

    @Test
    void controllerAspectMissingHeader() throws Exception {
        ControllerAspect aspect = new ControllerAspect(null);
        CommonRequest<Object> req = new CommonRequest<>(); // commonHeader 미설정

        CommonException e = assertThrows(CommonException.class, () -> aspect.onBeforeHandler(req));

        CaseLog.write("case-12-controller-aspect-missing-header", ControllerAspect.class, "컨트롤러 전처리 실패 header=null", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-12-controller-aspect-missing-header.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case12ControllerAspectMissingHeaderTest"), log);
    }
}
```

주의: `new ControllerAspect(null)` 생성자 인자가 실제로 몇 개·무슨 타입인지 `ControllerAspect.java`의 생성자를 확인한다(`@RequiredArgsConstructor` 등으로 필드가 여러 개면 인자도 그만큼 필요하다 — 전부 `null`로 넘기면 되는지, 아니면 mock이 필요한지 확인). 필드가 여러 개면 그만큼 `null`을 채운다(이 경로에서 그 필드들을 안 쓰면 NPE 없이 통과한다).

- [ ] **Step 10: Case13 — 요청 스레드 밖 RequestScopeUtils**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.utils.RequestScopeUtils;
import org.junit.jupiter.api.Test;

/** f-log case-13: HTTP 요청 스레드가 아닌 곳(배치/데몬/비동기 등)에서 요청 스코프 접근. */
class Case13RequestScopeOutsideThreadTest {

    @Test
    void requestScopeOutsideThread() throws Exception {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                RequestScopeUtils::getServletRequestAttributes);

        CaseLog.write("case-13-request-scope-outside-thread", RequestScopeUtils.class, "요청 스코프 접근 실패(스레드 경계)", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-13-request-scope-outside-thread.log"));
        assertTrue(log.contains("IllegalStateException"), log);
        assertTrue(log.contains("Case13RequestScopeOutsideThreadTest"), log);
    }
}
```

- [ ] **Step 11: Case14 — 연속키 필드/값 개수 불일치**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.List;
import kr.co.openlabs.fico.framework.internal.database.paging.MyBatisQueryInterceptor;
import kr.co.openlabs.fico.framework.internal.database.paging.PagingInfo;
import org.junit.jupiter.api.Test;

/**
 * f-log case-14: 연속키(continuation key) 필드 이름 2개를 등록했는데 값은 1개만 채워서
 * MyBatisQueryInterceptor의 private setContTrKeys가 못 잡는 IndexOutOfBoundsException을 던진다.
 */
class Case14PagingConttrkeyIndexTest {

    public static class Target {
        public String f1 = "a";
        public String f2 = "b";
    }

    @Test
    void pagingConttrkeyIndex() throws Exception {
        PagingInfo pagingInfo = PagingInfo.builder().build();
        pagingInfo.setContTrKeyFields("f1", "f2");
        pagingInfo.setContTrKeyValues(List.of("only-one"));

        Method m = MyBatisQueryInterceptor.class.getDeclaredMethod("setContTrKeys", PagingInfo.class, Object.class);
        m.setAccessible(true);
        MyBatisQueryInterceptor interceptor = new MyBatisQueryInterceptor();
        Target target = new Target();

        InvocationTargetException wrapper = assertThrows(InvocationTargetException.class,
                () -> m.invoke(interceptor, pagingInfo, target));
        Throwable e = wrapper.getCause();

        CaseLog.write("case-14-paging-conttrkey-index", MyBatisQueryInterceptor.class, "연속키 처리 실패 fields=2 values=1", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-14-paging-conttrkey-index.log"));
        assertTrue(log.contains("IndexOutOfBoundsException") || log.contains("ArrayIndexOutOfBoundsException"), log);
        assertTrue(log.contains("Case14PagingConttrkeyIndexTest"), log);
    }
}
```

주의: `PagingInfo.builder()`, `setContTrKeyFields(String...)`, `setContTrKeyValues(List<String>)`의 정확한 시그니처를 `PagingInfo.java`에서 확인한다(빌더 패턴이 아니거나 필드명이 다르면 맞춘다). `setContTrKeys(PagingInfo, Object)`는 이미 확인됨(private, target의 필드 `f1`,`f2`를 리플렉션으로 읽는 구조로 추정 — 실제로 `Object` 파라미터를 어떻게 쓰는지 메서드 본문을 보고 `Target`의 필드명을 맞춘다).

- [ ] **Step 12: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case0*' --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case1*' -q`
Expected: BUILD SUCCESSFUL. `ls .../logs/f-log-cases/` 에 `case-04-*` ~ `case-14-*` 로그 11개.

- [ ] **Step 13: 골든 YAML 11개 작성**

각 파일 `target/f-log-cases/case-NN-<slug>.yaml`:

```yaml
# case-04-fixed-string-length-overflow.yaml
log: logs/f-log-cases/case-04-fixed-string-length-overflow.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files:
  - src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case04FixedStringLengthOverflowTest.java
cause_symbol: fixedStringLengthOverflow
fix_keywords_any: ["length", "길이", "FixedData"]
rule: fico_fixed_message
```
```yaml
# case-05-fixed-list-size-exceeded.yaml
log: logs/f-log-cases/case-05-fixed-list-size-exceeded.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case05FixedListSizeExceededTest.java"]
cause_symbol: fixedListSizeExceeded
fix_keywords_any: ["size", "리스트", "FixedList"]
rule: fico_fixed_message
```
```yaml
# case-06-fixed-list-missing-size-not-last.yaml
log: logs/f-log-cases/case-06-fixed-list-missing-size-not-last.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case06FixedListMissingSizeNotLastTest.java"]
cause_symbol: fixedListMissingSizeNotLast
fix_keywords_any: ["마지막", "size", "last"]
rule: fico_fixed_message
```
```yaml
# case-07-fixed-parse-no-noarg-ctor.yaml
log: logs/f-log-cases/case-07-fixed-parse-no-noarg-ctor.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case07FixedParseNoNoargCtorTest.java"]
cause_symbol: fixedParseNoNoargCtor
fix_keywords_any: ["기본 생성자", "no-arg", "생성자"]
rule: fico_fixed_message
```
```yaml
# case-08-fixed-parse-oversize-input.yaml
log: logs/f-log-cases/case-08-fixed-parse-oversize-input.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case08FixedParseOversizeInputTest.java"]
cause_symbol: fixedParseOversizeInput
fix_keywords_any: ["길이", "length", "초과"]
rule: fico_fixed_message
```
```yaml
# case-09-fixed-long-invalid-sign-byte.yaml
log: logs/f-log-cases/case-09-fixed-long-invalid-sign-byte.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case09FixedLongInvalidSignByteTest.java"]
cause_symbol: fixedLongInvalidSignByte
fix_keywords_any: ["부호", "sign", "signed"]
rule: fico_fixed_message
```
```yaml
# case-10-fixed-nested-vo-block-count.yaml
log: logs/f-log-cases/case-10-fixed-nested-vo-block-count.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case10FixedNestedVoBlockCountTest.java"]
cause_symbol: fixedNestedVoBlockCount
fix_keywords_any: ["기본 생성자", "중첩", "nested"]
rule: fico_fixed_message
```
```yaml
# case-11-pbresponse-null-header.yaml
log: logs/f-log-cases/case-11-pbresponse-null-header.log
exception: java.lang.NullPointerException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case11PbresponseNullHeaderTest.java"]
cause_symbol: pbresponseNullHeader
fix_keywords_any: ["header", "헤더", "null"]
rule: fico_fixed_message
```
```yaml
# case-12-controller-aspect-missing-header.yaml
log: logs/f-log-cases/case-12-controller-aspect-missing-header.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case12ControllerAspectMissingHeaderTest.java"]
cause_symbol: controllerAspectMissingHeader
fix_keywords_any: ["header", "헤더", "commonHeader"]
rule: fico_error_code
```
```yaml
# case-13-request-scope-outside-thread.yaml
log: logs/f-log-cases/case-13-request-scope-outside-thread.log
exception: java.lang.IllegalStateException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case13RequestScopeOutsideThreadTest.java"]
cause_symbol: requestScopeOutsideThread
fix_keywords_any: ["스레드", "thread", "요청 스코프", "request scope"]
rule: fico_request_scope
```
```yaml
# case-14-paging-conttrkey-index.yaml
log: logs/f-log-cases/case-14-paging-conttrkey-index.log
exception: java.lang.IndexOutOfBoundsException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case14PagingConttrkeyIndexTest.java"]
cause_symbol: pagingConttrkeyIndex
fix_keywords_any: ["연속키", "conttrkey", "필드", "값"]
```

- [ ] **Step 14: YAML 파싱 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online && for f in f-log-cases/case-0[4-9]*.yaml f-log-cases/case-1[0-4]*.yaml; do bun -e "const y=Bun.YAML.parse(await Bun.file('$f').text()); console.log('$f', Object.keys(y).length)"; done`
Expected: 11줄, 각각 필드 수 5 또는 6(rule 있는 것 6, case-14는 5).

---

### Task A2: 컨텍스트·설정 조회 · 유틸리티 일부 (케이스 15~25, 11개)

**Files:**
- Create (target): `flogcase/Case15ExtTransactionalMissingManagerTest.java`
- Create (target): `flogcase/Case16EncryptUtilsNullKeyTest.java`
- Create (target): `flogcase/Case17CubeoneMissingCryptoidTest.java`
- Create (target): `flogcase/Case18JwtBlankSecretTest.java`
- Create (target): `flogcase/Case19ExtMapperRequiredInjectionTest.java`
- Create (target): `flogcase/Case20BeanUtilsMissingBeanTest.java`
- Create (target): `flogcase/Case21PbEnvPropertiesMissingTest.java`
- Create (target): `flogcase/Case22DbmessagesourceUnknownCodeTest.java`
- Create (target): `flogcase/Case23NumberDecimalStringOverflowTest.java`
- Create (target): `flogcase/Case24NumberLongToKorOverflowTest.java`
- Create (target): `flogcase/Case25NumberInvalidRoundingModeTest.java`
- Create (target): `f-log-cases/case-15-…yaml` ~ `case-25-…yaml` (11개)

**Interfaces:**
- Consumes: `CaseLog.write` (Task 1). Task A1과 파일 공유 없음 — 독립 실행 가능.

- [ ] **Step 1: Case15 — @ExtTransactional인데 extTransactionManager 없음**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

import kr.co.koscom.pb.framework.site.ext.annotation.ExtTransactional;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.NoSuchBeanDefinitionException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;

/** f-log case-15: @ExtTransactional은 "extTransactionManager"라는 이름의 빈을 요구하는데, 기본 transactionManager만 등록됨. */
class Case15ExtTransactionalMissingManagerTest {

    @Configuration
    @EnableTransactionManagement
    static class Cfg {
        @Bean
        PlatformTransactionManager transactionManager() {
            return mock(PlatformTransactionManager.class);
        }

        @Bean
        Svc svc() {
            return new Svc();
        }
    }

    static class Svc {
        @ExtTransactional
        public void run() {}
    }

    @Test
    void extTransactionalMissingManager() throws Exception {
        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext(Cfg.class)) {
            NoSuchBeanDefinitionException e = assertThrows(NoSuchBeanDefinitionException.class,
                    () -> ctx.getBean(Svc.class).run());

            CaseLog.write("case-15-ext-transactional-missing-manager", Svc.class, "ext 트랜잭션 실행 실패", e);
        }
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-15-ext-transactional-missing-manager.log"));
        assertTrue(log.contains("NoSuchBeanDefinitionException"), log);
        assertTrue(log.contains("extTransactionManager") || log.contains("Case15"), log);
    }
}
```

Mockito가 없으면(`import static org.mockito.Mockito.mock;`이 컴파일 안 되면) `mock(PlatformTransactionManager.class)` 대신 익명 구현 `new PlatformTransactionManager() { ...모든 메서드 최소 구현... }`으로 바꾼다(스프링 버전에 맞는 메서드 목록은 `PlatformTransactionManager` 인터페이스를 확인).

- [ ] **Step 2: Case16 — EncryptUtils.setKey(null)**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.utils.EncryptUtils;
import org.junit.jupiter.api.Test;

/** f-log case-16: EncryptUtils.setKey(null) — null 검증 없이 바로 key.getBytes() 호출. */
class Case16EncryptUtilsNullKeyTest {

    @Test
    void encryptUtilsNullKey() throws Exception {
        NullPointerException e = assertThrows(NullPointerException.class, () -> EncryptUtils.setKey(null));

        CaseLog.write("case-16-encrypt-utils-null-key", EncryptUtils.class, "암호화 키 설정 실패 key=null", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-16-encrypt-utils-null-key.log"));
        assertTrue(log.contains("NullPointerException"), log);
        assertTrue(log.contains("Case16EncryptUtilsNullKeyTest"), log);
    }
}
```

- [ ] **Step 3: Case17 — CubeOneCryptoService cryptoId 미설정**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.koscom.pb.framework.site.ext.crypto.CubeOneCryptoException;
import kr.co.koscom.pb.framework.site.ext.crypto.CubeOneCryptoService;
import org.junit.jupiter.api.Test;

/** f-log case-17: CubeOneCryptoService.encrypt(text, null) — defaultCryptoId 미설정 상태. */
class Case17CubeoneMissingCryptoidTest {

    @Test
    void cubeoneMissingCryptoid() throws Exception {
        CubeOneCryptoService svc = new CubeOneCryptoService(null, 0);

        CubeOneCryptoException e = assertThrows(CubeOneCryptoException.class, () -> svc.encrypt("secret", null));

        CaseLog.write("case-17-cubeone-missing-cryptoid", CubeOneCryptoService.class, "CubeOne 암호화 실패 cryptoId=null", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-17-cubeone-missing-cryptoid.log"));
        assertTrue(log.contains("CubeOneCryptoException"), log);
        assertTrue(log.contains("Case17CubeoneMissingCryptoidTest"), log);
    }
}
```

`new CubeOneCryptoService(null, 0)`의 정확한 생성자 인자 타입/개수를 `CubeOneCryptoService.java`에서 확인해 맞춘다. `encrypt(String, String)` 시그니처도 확인.

- [ ] **Step 4: Case18 — JwtUtils.setKey 공백**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.jwt.JwtUtils;
import org.junit.jupiter.api.Test;

/** f-log case-18: JwtUtils.setKey에 공백 문자열 — 실질적으로 빈 시크릿 키. */
class Case18JwtBlankSecretTest {

    @Test
    void jwtBlankSecret() throws Exception {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> new JwtUtils().setKey("   "));

        CaseLog.write("case-18-jwt-blank-secret", JwtUtils.class, "JWT 키 설정 실패 key=blank", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-18-jwt-blank-secret.log"));
        assertTrue(log.contains("IllegalArgumentException"), log);
        assertTrue(log.contains("Case18JwtBlankSecretTest"), log);
    }
}
```

`JwtUtils`가 인스턴스 메서드인지 static인지, `new JwtUtils()`가 되는지(private 생성자면 static으로 바꾼다) `JwtUtils.java:55` 주변에서 확인.

- [ ] **Step 5: Case19 — ext 매퍼류 선택 빈을 생성자 필수 주입으로 받음**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.UnsatisfiedDependencyException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * f-log case-19: fico 규약상 mapper/ext 매퍼는 선택 빈(@Autowired(required=false),
 * 앱 코드가 null 체크)인데, 이 서비스는 생성자로 필수 주입한다. ext 설정이 없는(빈 미등록)
 * 컨텍스트에서 기동이 실패한다. (근거: fico_wiring.md, on-stk-ord TransactionTestService의
 * `@Autowired(required=false) private ExtLogMapper extLogMapper;` 규약)
 */
class Case19ExtMapperRequiredInjectionTest {

    interface ExtLogMapperLike {
        void insertLog(String svcId);
    }

    static class Svc {
        private final ExtLogMapperLike extLogMapper;

        Svc(ExtLogMapperLike extLogMapper) { // 생성자 필수 주입 — 고의 위반
            this.extLogMapper = extLogMapper;
        }
    }

    @Configuration
    static class Cfg {
        @Bean
        Svc svc(ExtLogMapperLike extLogMapper) { // ExtLogMapperLike 빈이 어디에도 없음
            return new Svc(extLogMapper);
        }
    }

    @Test
    void extMapperRequiredInjection() throws Exception {
        UnsatisfiedDependencyException e = assertThrows(UnsatisfiedDependencyException.class,
                () -> new AnnotationConfigApplicationContext(Cfg.class));

        CaseLog.write("case-19-ext-mapper-required-injection", Svc.class, "ext 매퍼 필수 주입 실패", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-19-ext-mapper-required-injection.log"));
        assertTrue(log.contains("UnsatisfiedDependencyException") || log.contains("NoSuchBeanDefinitionException"), log);
        assertTrue(log.contains("Case19ExtMapperRequiredInjectionTest"), log);
    }
}
```

- [ ] **Step 6: Case20 — BeanUtils.getBean 미등록**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.koscom.pb.framework.site.ext.config.PBEnvProperties;
import kr.co.openlabs.fico.framework.internal.FicoApplicationContextProvider;
import kr.co.openlabs.fico.framework.utils.BeanUtils;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.NoSuchBeanDefinitionException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

/**
 * f-log case-20: BeanUtils.getBean(PBEnvProperties.class)를 호출했지만 그 빈이 등록돼 있지 않다.
 * FicoApplicationContextProvider는 그 자체에 무거운 @ComponentScan이 붙어 있어(전체 프레임워크
 * 패키지 스캔) 빈 컨텍스트를 만들고 setApplicationContext를 직접 호출해 홀더만 채운다 —
 * FicoApplicationContextProvider를 @Bean/@Component로 등록하지 않는다.
 */
class Case20BeanUtilsMissingBeanTest {

    @Test
    void beanUtilsMissingBean() throws Exception {
        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            ctx.refresh();
            new FicoApplicationContextProvider().setApplicationContext(ctx);

            NoSuchBeanDefinitionException e = assertThrows(NoSuchBeanDefinitionException.class,
                    () -> BeanUtils.getBean(PBEnvProperties.class));

            CaseLog.write("case-20-bean-utils-missing-bean", BeanUtils.class, "빈 조회 실패 type=PBEnvProperties", e);
        }
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-20-bean-utils-missing-bean.log"));
        assertTrue(log.contains("NoSuchBeanDefinitionException"), log);
        assertTrue(log.contains("Case20BeanUtilsMissingBeanTest"), log);
    }
}
```

`new AnnotationConfigApplicationContext()`(인자 없는 생성자)는 자동으로 refresh하지 않으므로 명시적으로 `ctx.refresh()`를 부른다(반대로 빈 클래스를 인자로 준 생성자는 자동 refresh — Step 1의 `new AnnotationConfigApplicationContext(Cfg.class)`와 다르다는 점에 주의).

- [ ] **Step 7: Case21 — PBCommonUtils.getFirmNo() 미스캔**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.koscom.pb.framework.site.ext.utils.PBCommonUtils;
import kr.co.openlabs.fico.framework.internal.FicoApplicationContextProvider;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.NoSuchBeanDefinitionException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

/** f-log case-21: PBCommonUtils.getFirmNo()가 내부적으로 PBEnvProperties 빈을 찾지만 등록돼 있지 않다. */
class Case21PbEnvPropertiesMissingTest {

    @Test
    void pbEnvPropertiesMissing() throws Exception {
        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            ctx.refresh();
            new FicoApplicationContextProvider().setApplicationContext(ctx);

            NoSuchBeanDefinitionException e = assertThrows(NoSuchBeanDefinitionException.class, PBCommonUtils::getFirmNo);

            CaseLog.write("case-21-pb-env-properties-missing", PBCommonUtils.class, "이용사번호 조회 실패", e);
        }
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-21-pb-env-properties-missing.log"));
        assertTrue(log.contains("NoSuchBeanDefinitionException"), log);
        assertTrue(log.contains("Case21PbEnvPropertiesMissingTest"), log);
    }
}
```

`PBCommonUtils.getFirmNo()`가 정말 인자 없는 static 메서드인지, 메서드 레퍼런스 `PBCommonUtils::getFirmNo`가 `Executable`(assertThrows 두 번째 인자)로 맞는지 확인한다.

- [ ] **Step 8: Case22 — 없는 메시지 코드 해석**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Locale;
import kr.co.openlabs.fico.framework.extension.message.DBMessageSource;
import kr.co.openlabs.fico.framework.extension.message.mapper.MessageMapper;
import org.junit.jupiter.api.Test;
import org.springframework.context.NoSuchMessageException;

/** f-log case-22: 캐시에도 DB에도 없는 메시지 코드를 해석. */
class Case22DbmessagesourceUnknownCodeTest {

    static class NullMapper implements MessageMapper {
        // 인터페이스의 모든 메서드가 null/빈 결과를 반환하도록 구현 — 실제 메서드 목록은
        // MessageMapper.java를 확인해 맞춘다.
    }

    @Test
    void dbmessagesourceUnknownCode() throws Exception {
        DBMessageSource src = new DBMessageSource(new NullMapper());

        NoSuchMessageException e = assertThrows(NoSuchMessageException.class,
                () -> src.getMessage("NOEXIST", null, Locale.KOREAN));

        CaseLog.write("case-22-dbmessagesource-unknown-code", DBMessageSource.class, "메시지 코드 해석 실패 code=NOEXIST", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-22-dbmessagesource-unknown-code.log"));
        assertTrue(log.contains("NoSuchMessageException"), log);
        assertTrue(log.contains("Case22DbmessagesourceUnknownCodeTest"), log);
    }
}
```

`MessageMapper` 인터페이스의 실제 메서드 목록(`kr.co.openlabs.fico.framework.extension.message.mapper.MessageMapper`)을 확인해 `NullMapper`가 전부 구현하도록 채운다(대부분 null 또는 빈 리스트 반환이면 된다).

- [ ] **Step 9: Case23 — NumberUtils.getDecimalFromString 길이 초과**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.utils.NumberUtils;
import org.junit.jupiter.api.Test;

/** f-log case-23: getDecimalFromString(str, length) 호출 시 length가 str 길이보다 큼. */
class Case23NumberDecimalStringOverflowTest {

    @Test
    void numberDecimalStringOverflow() throws Exception {
        CommonException e = assertThrows(CommonException.class, () -> NumberUtils.getDecimalFromString("123", 10));

        CaseLog.write("case-23-number-decimal-string-overflow", NumberUtils.class, "10진수 변환 실패 input=123 length=10", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-23-number-decimal-string-overflow.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case23NumberDecimalStringOverflowTest"), log);
    }
}
```

- [ ] **Step 10: Case24 — NumberUtils.longToKor 초과**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.utils.NumberUtils;
import org.junit.jupiter.api.Test;

/** f-log case-24: longToKor(Long.MAX_VALUE) — 16자리 초과 값. */
class Case24NumberLongToKorOverflowTest {

    @Test
    void numberLongToKorOverflow() throws Exception {
        CommonException e = assertThrows(CommonException.class, () -> NumberUtils.longToKor(Long.MAX_VALUE));

        CaseLog.write("case-24-number-long-to-kor-overflow", NumberUtils.class, "숫자→한글 변환 실패 value=" + Long.MAX_VALUE, e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-24-number-long-to-kor-overflow.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case24NumberLongToKorOverflowTest"), log);
    }
}
```

- [ ] **Step 11: Case25 — NumberUtils 잘못된 반올림 모드**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.utils.NumberUtils;
import org.junit.jupiter.api.Test;

/** f-log case-25: setScalePrc(num, scale, roundTp)의 roundTp가 유효한 RoundingMode ordinal이 아님. */
class Case25NumberInvalidRoundingModeTest {

    @Test
    void numberInvalidRoundingMode() throws Exception {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> NumberUtils.setScalePrc(new java.math.BigDecimal("1.2345"), 2, 99));

        CaseLog.write("case-25-number-invalid-rounding-mode", NumberUtils.class, "반올림 처리 실패 roundTp=99", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-25-number-invalid-rounding-mode.log"));
        assertTrue(log.contains("IllegalArgumentException"), log);
        assertTrue(log.contains("Case25NumberInvalidRoundingModeTest"), log);
    }
}
```

`setScalePrc`의 정확한 파라미터 타입(첫 인자가 BigDecimal인지 double/long인지)을 `NumberUtils.java:149` 부근에서 확인.

- [ ] **Step 12: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case1[5-9]*' --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case2[0-5]*' -q`
Expected: BUILD SUCCESSFUL. 로그 11개 생성.

- [ ] **Step 13: 골든 YAML 11개**

```yaml
# case-15-ext-transactional-missing-manager.yaml
log: logs/f-log-cases/case-15-ext-transactional-missing-manager.log
exception: org.springframework.beans.factory.NoSuchBeanDefinitionException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case15ExtTransactionalMissingManagerTest.java"]
cause_symbol: extTransactionalMissingManager
fix_keywords_any: ["extTransactionManager", "빈", "bean"]
rule: fico_transaction
```
```yaml
# case-16-encrypt-utils-null-key.yaml
log: logs/f-log-cases/case-16-encrypt-utils-null-key.log
exception: java.lang.NullPointerException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case16EncryptUtilsNullKeyTest.java"]
cause_symbol: encryptUtilsNullKey
fix_keywords_any: ["null", "key", "키"]
rule: npe
```
```yaml
# case-17-cubeone-missing-cryptoid.yaml
log: logs/f-log-cases/case-17-cubeone-missing-cryptoid.log
exception: kr.co.koscom.pb.framework.site.ext.crypto.CubeOneCryptoException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case17CubeoneMissingCryptoidTest.java"]
cause_symbol: cubeoneMissingCryptoid
fix_keywords_any: ["cryptoId", "defaultCryptoId"]
rule: fico_fixed_message
```
```yaml
# case-18-jwt-blank-secret.yaml
log: logs/f-log-cases/case-18-jwt-blank-secret.log
exception: java.lang.IllegalArgumentException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case18JwtBlankSecretTest.java"]
cause_symbol: jwtBlankSecret
fix_keywords_any: ["secret", "키", "blank", "공백"]
```
```yaml
# case-19-ext-mapper-required-injection.yaml
log: logs/f-log-cases/case-19-ext-mapper-required-injection.log
exception: org.springframework.beans.factory.UnsatisfiedDependencyException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case19ExtMapperRequiredInjectionTest.java"]
cause_symbol: extMapperRequiredInjection
fix_keywords_any: ["required=false", "선택", "생성자", "optional"]
rule: fico_wiring
```
```yaml
# case-20-bean-utils-missing-bean.yaml
log: logs/f-log-cases/case-20-bean-utils-missing-bean.log
exception: org.springframework.beans.factory.NoSuchBeanDefinitionException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case20BeanUtilsMissingBeanTest.java"]
cause_symbol: beanUtilsMissingBean
fix_keywords_any: ["PBEnvProperties", "빈", "등록"]
rule: fico_wiring
```
```yaml
# case-21-pb-env-properties-missing.yaml
log: logs/f-log-cases/case-21-pb-env-properties-missing.log
exception: org.springframework.beans.factory.NoSuchBeanDefinitionException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case21PbEnvPropertiesMissingTest.java"]
cause_symbol: pbEnvPropertiesMissing
fix_keywords_any: ["PBEnvProperties", "스캔", "scan"]
rule: fico_wiring
```
```yaml
# case-22-dbmessagesource-unknown-code.yaml
log: logs/f-log-cases/case-22-dbmessagesource-unknown-code.log
exception: org.springframework.context.NoSuchMessageException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case22DbmessagesourceUnknownCodeTest.java"]
cause_symbol: dbmessagesourceUnknownCode
fix_keywords_any: ["메시지 코드", "message", "NOEXIST"]
```
```yaml
# case-23-number-decimal-string-overflow.yaml
log: logs/f-log-cases/case-23-number-decimal-string-overflow.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case23NumberDecimalStringOverflowTest.java"]
cause_symbol: numberDecimalStringOverflow
fix_keywords_any: ["length", "길이"]
rule: fico_exception_flow
```
```yaml
# case-24-number-long-to-kor-overflow.yaml
log: logs/f-log-cases/case-24-number-long-to-kor-overflow.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case24NumberLongToKorOverflowTest.java"]
cause_symbol: numberLongToKorOverflow
fix_keywords_any: ["16자리", "범위", "overflow"]
rule: fico_exception_flow
```
```yaml
# case-25-number-invalid-rounding-mode.yaml
log: logs/f-log-cases/case-25-number-invalid-rounding-mode.log
exception: java.lang.IllegalArgumentException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case25NumberInvalidRoundingModeTest.java"]
cause_symbol: numberInvalidRoundingMode
fix_keywords_any: ["RoundingMode", "roundTp", "반올림"]
rule: fico_exception_flow
```

---

### Task A3: 유틸리티(문자열·날짜·암호·압축) · 재시도 · 필드 암호화 전파 (케이스 26~34, 9개)

**Files:**
- Create (target): `flogcase/Case26StringInvalidPaddingDirectionTest.java`
- Create (target): `flogcase/Case27StringMaskingInvalidTypeTest.java`
- Create (target): `flogcase/Case28DateDaysInMonthInvalidYearTest.java`
- Create (target): `flogcase/Case29DateCompareBothInvalidTest.java`
- Create (target): `flogcase/Case30EncryptBlake2bDigestRangeTest.java`
- Create (target): `flogcase/Case31EncryptAesBadBase64Test.java`
- Create (target): `flogcase/Case32CompressionCorruptLzoTest.java`
- Create (target): `flogcase/Case33RetryTemplateZeroAttemptsTest.java`
- Create (target): `flogcase/Case34CryptoFieldProcessorPropagationTest.java`
- Create (target): `f-log-cases/case-26-…yaml` ~ `case-34-…yaml` (9개)

**Interfaces:**
- Consumes: `CaseLog.write` (Task 1). 독립 실행.

- [ ] **Step 1: Case26 — StringUtils 잘못된 패딩 구분**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.utils.StringUtils;
import org.junit.jupiter.api.Test;

/** f-log case-26: stringPadding의 패딩 구분 코드(gbn)가 0/1이 아님. */
class Case26StringInvalidPaddingDirectionTest {

    @Test
    void stringInvalidPaddingDirection() throws Exception {
        CommonException e = assertThrows(CommonException.class,
                () -> StringUtils.stringPadding(10, "abc", 2, '#'));

        CaseLog.write("case-26-string-invalid-padding-direction", StringUtils.class, "문자열 패딩 실패 gbn=2", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-26-string-invalid-padding-direction.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case26StringInvalidPaddingDirectionTest"), log);
    }
}
```

`stringPadding(int, String, int, char)`의 정확한 파라미터 순서를 `StringUtils.java:1334` 부근에서 확인해 맞춘다.

- [ ] **Step 2: Case27 — StringUtils 마스킹 타입 오류**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.utils.StringUtils;
import org.junit.jupiter.api.Test;

/** f-log case-27: masking(str, types)의 types가 "1"도 "2"도 아님. */
class Case27StringMaskingInvalidTypeTest {

    @Test
    void stringMaskingInvalidType() throws Exception {
        CommonException e = assertThrows(CommonException.class, () -> StringUtils.masking("01011112222", "9"));

        CaseLog.write("case-27-string-masking-invalid-type", StringUtils.class, "마스킹 실패 types=9", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-27-string-masking-invalid-type.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case27StringMaskingInvalidTypeTest"), log);
    }
}
```

- [ ] **Step 3: Case28 — DateUtils 연도 형식 오류**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.utils.DateUtils;
import org.junit.jupiter.api.Test;

/** f-log case-28: getDaysInMonth("abcd", "05") — 연도가 4자리 숫자가 아님. */
class Case28DateDaysInMonthInvalidYearTest {

    @Test
    void dateDaysInMonthInvalidYear() throws Exception {
        CommonException e = assertThrows(CommonException.class, () -> DateUtils.getDaysInMonth("abcd", "05"));

        CaseLog.write("case-28-date-days-in-month-invalid-year", DateUtils.class, "월별 일수 계산 실패 year=abcd", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-28-date-days-in-month-invalid-year.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case28DateDaysInMonthInvalidYearTest"), log);
    }
}
```

- [ ] **Step 4: Case29 — DateUtils.compareDate 양쪽 다 불량**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.utils.DateUtils;
import org.junit.jupiter.api.Test;

/**
 * f-log case-29: compareDate("bad1","bad2") — 두 인자 모두 8자리 날짜 형식이 아님.
 * (프레임워크 자체에 드모르간 오류가 있어 한쪽만 불량이면 검증을 통과한다 — 이 케이스는
 * 양쪽 다 불량이라 검증에 걸리는 경로다.)
 */
class Case29DateCompareBothInvalidTest {

    @Test
    void dateCompareBothInvalid() throws Exception {
        CommonException e = assertThrows(CommonException.class, () -> DateUtils.compareDate("bad1", "bad2"));

        CaseLog.write("case-29-date-compare-both-invalid", DateUtils.class, "날짜 비교 실패 d1=bad1 d2=bad2", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-29-date-compare-both-invalid.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case29DateCompareBothInvalidTest"), log);
    }
}
```

- [ ] **Step 5: Case30 — EncryptUtils blake2b digestSize 범위 초과**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.exception.CommonException;
import kr.co.openlabs.fico.framework.utils.EncryptUtils;
import org.junit.jupiter.api.Test;

/** f-log case-30: encryptNumberByBlake2b의 digestSize가 허용 범위(10~16) 밖. */
class Case30EncryptBlake2bDigestRangeTest {

    @Test
    void encryptBlake2bDigestRange() throws Exception {
        CommonException e = assertThrows(CommonException.class,
                () -> EncryptUtils.encryptNumberByBlake2b(123L, 20, '0'));

        CaseLog.write("case-30-encrypt-blake2b-digest-range", EncryptUtils.class, "Blake2b 암호화 실패 digestSize=20", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-30-encrypt-blake2b-digest-range.log"));
        assertTrue(log.contains("CommonException"), log);
        assertTrue(log.contains("Case30EncryptBlake2bDigestRangeTest"), log);
    }
}
```

- [ ] **Step 6: Case31 — EncryptUtils AES 복호화 시 Base64 아님(setKey 후)**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.utils.EncryptUtils;
import org.junit.jupiter.api.Test;

/** f-log case-31: setKey 후 decryptAES에 Base64가 아닌 문자열을 넘김. catch가 checked 예외만 잡아 IllegalArgumentException이 그대로 샌다. */
class Case31EncryptAesBadBase64Test {

    @Test
    void encryptAesBadBase64() throws Exception {
        EncryptUtils.setKey("0123456789abcdef");

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> EncryptUtils.decryptAES("not-base64!!"));

        CaseLog.write("case-31-encrypt-aes-bad-base64", EncryptUtils.class, "AES 복호화 실패 cipherText=not-base64!!", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-31-encrypt-aes-bad-base64.log"));
        assertTrue(log.contains("IllegalArgumentException"), log);
        assertTrue(log.contains("Case31EncryptAesBadBase64Test"), log);
    }
}
```

- [ ] **Step 7: Case32 — CompressionUtils 깨진 LZO 데이터**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.utils.CompressionUtils;
import org.junit.jupiter.api.Test;

/** f-log case-32: decompressLzo에 LZO로 압축되지 않은 바이트를 넘김. try/catch 없이 그대로 샌다. */
class Case32CompressionCorruptLzoTest {

    @Test
    void compressionCorruptLzo() throws Exception {
        RuntimeException e = assertThrows(RuntimeException.class,
                () -> CompressionUtils.decompressLzo("hello world".getBytes(), 100));

        CaseLog.write("case-32-compression-corrupt-lzo", CompressionUtils.class, "LZO 압축 해제 실패", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-32-compression-corrupt-lzo.log"));
        assertTrue(log.contains("Case32CompressionCorruptLzoTest"), log);
    }
}
```

- [ ] **Step 8: Case33 — RetryableRestTemplate maxCount=0**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import java.net.URI;
import kr.co.openlabs.fico.framework.internal.RetryTemplateProperties;
import kr.co.openlabs.fico.framework.internal.RetryableRestTemplate;
import org.junit.jupiter.api.Test;
import org.springframework.http.client.SimpleClientHttpRequestFactory;

/** f-log case-33: retry-template.max-count=0 — RetryTemplate.builder().maxAttempts(0)이 실행 전에 검증 실패. */
class Case33RetryTemplateZeroAttemptsTest {

    @Test
    void retryTemplateZeroAttempts() throws Exception {
        RetryableRestTemplate rt = new RetryableRestTemplate(new SimpleClientHttpRequestFactory());
        RetryTemplateProperties props = new RetryTemplateProperties();
        props.setMaxCount(0);
        Field f = RetryableRestTemplate.class.getDeclaredField("retryTemplateProperties");
        f.setAccessible(true);
        f.set(rt, props);

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> rt.getForObject(URI.create("http://127.0.0.1:1"), String.class));

        CaseLog.write("case-33-retry-template-zero-attempts", RetryableRestTemplate.class, "재시도 템플릿 설정 실패 maxCount=0", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-33-retry-template-zero-attempts.log"));
        assertTrue(log.contains("IllegalArgumentException"), log);
        assertTrue(log.contains("Case33RetryTemplateZeroAttemptsTest"), log);
    }
}
```

- [ ] **Step 9: Case34 — CryptoFieldProcessor가 CryptoService 예외를 그대로 전파**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import kr.co.openlabs.fico.framework.extension.crypto.CryptoFieldProcessor;
import kr.co.openlabs.fico.framework.extension.crypto.CryptoService;
import kr.co.openlabs.fico.framework.internal.annotations.EncryptData;
import org.junit.jupiter.api.Test;

/** f-log case-34: @EncryptData 필드를 암호화하는 중 주입된 CryptoService 구현체가 던진 예외가 그대로 전파된다. */
class Case34CryptoFieldProcessorPropagationTest {

    static class Vo {
        @EncryptData("bad-id")
        String secret = "value";
    }

    static class ThrowingCryptoService implements CryptoService {
        @Override
        public String encrypt(String value, String cryptoId) {
            throw new IllegalStateException("unknown cryptoId: " + cryptoId);
        }
        // 인터페이스의 다른 메서드(decrypt 등)가 있으면 최소 구현을 추가한다.
    }

    @Test
    void cryptoFieldProcessorPropagation() throws Exception {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> CryptoFieldProcessor.encrypt(new Vo(), new ThrowingCryptoService()));

        CaseLog.write("case-34-crypto-field-processor-propagation", CryptoFieldProcessor.class, "필드 암호화 실패 cryptoId=bad-id", e);
        String log = java.nio.file.Files.readString(java.nio.file.Path.of("logs/f-log-cases/case-34-crypto-field-processor-propagation.log"));
        assertTrue(log.contains("IllegalStateException"), log);
        assertTrue(log.contains("Case34CryptoFieldProcessorPropagationTest"), log);
    }
}
```

`CryptoService` 인터페이스의 실제 메서드 시그니처(`encrypt(String,String)`가 맞는지, `decrypt`도 있는지)와 `@EncryptData` 어노테이션의 실제 속성명(생성자 인자로 문자열 하나를 받는 형태가 맞는지)을 `CryptoFieldProcessor.java`/`CryptoService.java`/`EncryptData.java`에서 확인해 맞춘다.

- [ ] **Step 10: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case2[6-9]*' --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case3*' -q`
Expected: BUILD SUCCESSFUL. 로그 9개 생성.

- [ ] **Step 11: 골든 YAML 9개**

```yaml
# case-26-string-invalid-padding-direction.yaml
log: logs/f-log-cases/case-26-string-invalid-padding-direction.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case26StringInvalidPaddingDirectionTest.java"]
cause_symbol: stringInvalidPaddingDirection
fix_keywords_any: ["패딩", "padding", "gbn"]
rule: fico_exception_flow
```
```yaml
# case-27-string-masking-invalid-type.yaml
log: logs/f-log-cases/case-27-string-masking-invalid-type.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case27StringMaskingInvalidTypeTest.java"]
cause_symbol: stringMaskingInvalidType
fix_keywords_any: ["masking", "types", "마스킹"]
rule: fico_exception_flow
```
```yaml
# case-28-date-days-in-month-invalid-year.yaml
log: logs/f-log-cases/case-28-date-days-in-month-invalid-year.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case28DateDaysInMonthInvalidYearTest.java"]
cause_symbol: dateDaysInMonthInvalidYear
fix_keywords_any: ["year", "연도", "4자리"]
rule: fico_exception_flow
```
```yaml
# case-29-date-compare-both-invalid.yaml
log: logs/f-log-cases/case-29-date-compare-both-invalid.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case29DateCompareBothInvalidTest.java"]
cause_symbol: dateCompareBothInvalid
fix_keywords_any: ["날짜 형식", "8자리", "compareDate"]
rule: fico_exception_flow
```
```yaml
# case-30-encrypt-blake2b-digest-range.yaml
log: logs/f-log-cases/case-30-encrypt-blake2b-digest-range.log
exception: kr.co.openlabs.fico.framework.exception.CommonException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case30EncryptBlake2bDigestRangeTest.java"]
cause_symbol: encryptBlake2bDigestRange
fix_keywords_any: ["digestSize", "10", "16"]
rule: fico_exception_flow
```
```yaml
# case-31-encrypt-aes-bad-base64.yaml
log: logs/f-log-cases/case-31-encrypt-aes-bad-base64.log
exception: java.lang.IllegalArgumentException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case31EncryptAesBadBase64Test.java"]
cause_symbol: encryptAesBadBase64
fix_keywords_any: ["Base64", "cipherText", "복호화"]
```
```yaml
# case-32-compression-corrupt-lzo.yaml
log: logs/f-log-cases/case-32-compression-corrupt-lzo.log
exception: io.airlift.compress.MalformedInputException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case32CompressionCorruptLzoTest.java"]
cause_symbol: compressionCorruptLzo
fix_keywords_any: ["LZO", "압축", "Malformed"]
rule: fico_fixed_message
```
```yaml
# case-33-retry-template-zero-attempts.yaml
log: logs/f-log-cases/case-33-retry-template-zero-attempts.log
exception: java.lang.IllegalArgumentException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case33RetryTemplateZeroAttemptsTest.java"]
cause_symbol: retryTemplateZeroAttempts
fix_keywords_any: ["max-count", "maxAttempts", "재시도"]
```
```yaml
# case-34-crypto-field-processor-propagation.yaml
log: logs/f-log-cases/case-34-crypto-field-processor-propagation.log
exception: java.lang.IllegalStateException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case34CryptoFieldProcessorPropagationTest.java"]
cause_symbol: cryptoFieldProcessorPropagation
fix_keywords_any: ["cryptoId", "CryptoService", "암호화"]
```

- [ ] **Step 12: YAML 파싱 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online && for f in f-log-cases/case-{04..34..1}*.yaml; do bun -e "const y=Bun.YAML.parse(await Bun.file('$f').text()); if(!y.log||!y.exception||!y.cause_files||!y.cause_symbol||!y.fix_keywords_any) throw new Error('missing field: $f')" && echo "OK $f"; done 2>&1 | tail -35`
Expected: 31개 파일 모두 `OK`.

- [ ] **Step 13: 전체 재실행으로 회귀 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline -q && ls on-test-lab-online/logs/f-log-cases/ | wc -l`
Expected: BUILD SUCCESSFUL, 로그 파일 수 34(기존 3 + 이번 31).

---

## Self-review 메모

- 카탈로그 §A 31개 전부 Task A1(11)+A2(11)+A3(9) = 31로 매핑됨.
- 케이스 10·19는 조사 단계에서 불확실했던 부분(침묵 삼킴, 프레임워크 규약)을 Step 안에 "검증 후 조정" 지시로 명시.
- 케이스 16은 이미 구현 전 단계에서 `SeedKeyConfig`→`EncryptUtils.setKey(null)`로 교체 검증 완료(fico-fwk-core 3.0.1-SNAPSHOT에 crypto 패키지 없음 확인).
- 케이스 14·15·20·21은 리플렉션/컨텍스트 구성이 까다로워 정확한 시그니처 확인 지시를 각 Step에 남김.
- Category B~H(케이스 02,35~100)는 이 계획의 범위 밖 — 후속 계획으로 별도 작성.
