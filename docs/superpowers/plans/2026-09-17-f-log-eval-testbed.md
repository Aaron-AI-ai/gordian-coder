# f-log 평가 테스트베드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** on-test-lab-online에 고의 버그 3개(NPE, MyBatis 바인딩, 빈 충돌)와 그 로그를 만드는 JUnit 테스트, 케이스별 정답 YAML을 두고, gordian-coder의 `scripts/flog-eval.ts`가 f-log 리포트를 정답과 자동 대조하게 한다.

**Architecture:** 대상 프로젝트(`target`)에는 on-stk-ord 패턴의 Controller/Service/VO/Mapper와 `src/test`의 케이스 테스트가 들어간다. 테스트는 Spring 컨텍스트 없이 예외를 일으켜 `CaseLog`로 fico 프리픽스 로그를 `logs/f-log-cases/<case>.log`에 쓴다. gordian-coder 쪽 단일 Bun 스크립트가 케이스마다 `opencode run --command f-log`를 돌리고 리포트 절을 잘라 채점한다.

**Tech Stack:** Java 21, Gradle(offline 가능), JUnit 5.11, MyBatis 3.5.19, H2 2.3.232, Spring 6.2 / Bun 1.3, TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-17-f-log-eval-testbed-design.md`

## Global Constraints

- `target` = `/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online`. Gradle은 상위 `/Users/koscom/workspace/fico/test-projects/on-test-lab`에서 `./gradlew :on-test-lab-online:<task> --offline`로 실행한다. macOS라 `timeout` 명령이 없다.
- gordian-coder 작업은 워크트리 `/Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis`(브랜치 `worktree-error-log-analysis`)에서만 한다. 커밋 메시지에 `Co-Authored-By` 줄을 넣지 않는다(사용자 규칙).
- `target`은 git 최상위가 `test-projects`이고 전부 미추적 파일이다. **target 쪽은 커밋하지 않는다**(소유자 판단). gordian-coder 쪽만 커밋한다.
- 자바 패키지: `kr.co.koscom.pb.on.test.lab.online`. 케이스 ID: `case-01-npe`, `case-02-mybatis-binding`, `case-03-bean-conflict`.
- 로그 첫 줄 형식(fico log4j2 패턴): `[ERROR::][<host>:<yyyy-MM-dd HH:mm:ss.SSS>][<thread>][<logger>:<method>:<line>] <msg>` 다음 줄부터 `printStackTrace` 출력.
- 정답 YAML 필드는 `log, exception, cause_files, cause_symbol, fix_keywords_any, rule(선택)` 여섯 개만. 라인 번호는 넣지 않는다.
- 리포트 절 헤더(finalize.ts `L` 상수): ko `## 요약 / ## 진입점 → 원인 경로 / ## 원인 상세와 근거 / ## 해결 방안 / ## 실행 정보`, en `## Summary / ## Entry point → cause path / ## Cause and evidence / ## Resolution / ## Run info`.
- 의존성 추가 없음(gordian-coder). target에는 `testImplementation` 두 줄만 추가.
- `failOnVersionConflict()`가 켜져 있어 target에 버전을 적을 때는 이미 해석된 버전과 같아야 한다: mybatis `3.5.19`, h2는 Spring Boot BOM 관리라 버전 생략.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `target/.gitignore` | `build/ bin/ logs/ .fico/` 제외 |
| `target/build.gradle` | 테스트 컴파일에 mybatis·h2 추가 |
| `target/src/main/java/.../qry/model/vo/TLABQ001In.java` | 요청 VO. `Inner.accountNo` |
| `target/src/main/java/.../qry/model/vo/TLABQ001Out.java` | 응답 VO. `Inner.acntNo, acntNm` |
| `target/src/main/java/.../mapper/TestLabMapper.java` | `TLABQ001Out.Inner selectAcnt(TLABQ001In.Inner)` |
| `target/src/main/resources/mapper/postgres/online/TestLabMapper.xml` | `selectAcnt` SQL. **고의 버그: `#{acntNo}`** |
| `target/src/main/java/.../qry/service/TLABQ001Service.java` | 업무 서비스. **고의 버그: null 결과 역참조** |
| `target/src/main/java/.../qry/controller/TLABQ001Controller.java` | `POST /ON/TLABQ001` |
| `target/src/test/java/.../flogcase/CaseLog.java` | 케이스 로그 파일 쓰기 |
| `target/src/test/java/.../flogcase/Case01NpeTest.java` | NPE 유발 |
| `target/src/test/java/.../flogcase/Case02MybatisBindingTest.java` | 순수 MyBatis+H2로 바인딩 오류 유발 |
| `target/src/test/java/.../flogcase/Case03BeanConflictTest.java` | 중복 빈 스캔으로 충돌 유발 |
| `target/src/test/java/.../flogcase/dup/a/DupAcntMapper.java`, `dup/b/DupAcntMapper.java` | 같은 빈 이름의 테스트 전용 클래스 |
| `target/f-log-cases/case-0{1,2,3}-*.yaml` | 정답 |
| `gordian-coder/scripts/flog-eval.ts` | 러너+채점기 |
| `gordian-coder/scripts/__tests__/flog-eval.test.ts` | 절 분할·채점 단위 테스트 |
| `gordian-coder/docs/reports/f-log-eval-testbed-run1-20260917.md` | 첫 실행 결과 |

---

### Task 1: 대상 프로젝트 골격 + Case 01 (NPE)

**Files:**
- Create: `target/.gitignore`
- Create: `target/src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/model/vo/TLABQ001In.java`
- Create: `target/src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/model/vo/TLABQ001Out.java`
- Create: `target/src/main/java/kr/co/koscom/pb/on/test/lab/online/mapper/TestLabMapper.java`
- Create: `target/src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java`
- Create: `target/src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/controller/TLABQ001Controller.java`
- Create: `target/src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/CaseLog.java`
- Test: `target/src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case01NpeTest.java`

**Interfaces:**
- Produces: `TestLabMapper.selectAcnt(TLABQ001In.Inner) : TLABQ001Out.Inner` (단일 추상 메서드 → 람다로 스텁 가능), `new TLABQ001Service(TestLabMapper)`, `TLABQ001Service.tlabq001(TLABQ001In) : TLABQ001Out`, `CaseLog.write(String caseId, Class<?> logger, String msg, Throwable t)`.

- [ ] **Step 1: `.gitignore` 작성**

`target/.gitignore`:
```
build/
bin/
logs/
.fico/
```

- [ ] **Step 2: 실패하는 테스트 작성**

`target/src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case01NpeTest.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001In;
import kr.co.koscom.pb.on.test.lab.online.qry.service.TLABQ001Service;
import org.junit.jupiter.api.Test;

/** f-log case-01: 매퍼가 null을 돌려줬는데 서비스가 그대로 역참조한다. */
class Case01NpeTest {

    @Test
    void serviceDereferencesNullMapperResult() throws Exception {
        TLABQ001Service service = new TLABQ001Service(param -> null); // 조회 결과 없음
        TLABQ001In in = new TLABQ001In();
        in.setInner(TLABQ001In.Inner.builder().accountNo("1234567890").build());

        NullPointerException e = assertThrows(NullPointerException.class, () -> service.tlabq001(in));

        CaseLog.write("case-01-npe", TLABQ001Service.class, "계좌조회 실패 accountNo=1234567890", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-01-npe.log"));
        assertTrue(log.startsWith("[ERROR::]["), log);
        assertTrue(log.contains("java.lang.NullPointerException"), log);
        assertTrue(log.contains("TLABQ001Service.tlabq001("), log);
    }
}
```

- [ ] **Step 3: 컴파일 실패 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:compileTestJava --offline -q`
Expected: FAIL, `package kr.co.koscom.pb.on.test.lab.online.qry.service does not exist` 류의 컴파일 오류.

- [ ] **Step 4: VO 두 개 작성**

`TLABQ001In.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.qry.model.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData.PAD_TYPE;
import kr.co.openlabs.fico.framework.internal.annotations.FixedVo;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/** TLABQ001 계좌명조회 요청 */
@Data
@NoArgsConstructor
@Schema(description = "계좌명조회 요청")
public class TLABQ001In {

    @FixedVo
    private Inner inner;

    @Data
    @Builder
    @AllArgsConstructor
    @NoArgsConstructor
    public static class Inner {
        @Schema(description = "계좌번호", required = true)
        @FixedData(length = 20, padType = PAD_TYPE.RIGHT)
        private String accountNo;
    }
}
```

`TLABQ001Out.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.qry.model.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData.PAD_TYPE;
import kr.co.openlabs.fico.framework.internal.annotations.FixedVo;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/** TLABQ001 계좌명조회 응답 */
@Data
@NoArgsConstructor
@Schema(description = "계좌명조회 응답")
public class TLABQ001Out {

    @FixedVo
    private Inner inner;

    @Data
    @Builder
    @AllArgsConstructor
    @NoArgsConstructor
    public static class Inner {
        @Schema(description = "계좌번호")
        @FixedData(length = 20, padType = PAD_TYPE.RIGHT)
        private String acntNo;

        @Schema(description = "계좌명")
        @FixedData(length = 50, padType = PAD_TYPE.RIGHT)
        private String acntNm;
    }
}
```

- [ ] **Step 5: 매퍼 인터페이스 작성**

`TestLabMapper.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.mapper;

import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001In;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001Out;
import org.apache.ibatis.annotations.Mapper;

/** 테스트랩 계좌 Mapper. 단일 메서드라 테스트에서 람다로 대체할 수 있다. */
@Mapper
public interface TestLabMapper {

    /** 계좌번호로 계좌명 1건 조회. 없으면 null. */
    TLABQ001Out.Inner selectAcnt(TLABQ001In.Inner param);
}
```

- [ ] **Step 6: 서비스 작성 (고의 NPE)**

`TLABQ001Service.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.qry.service;

import kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException;
import kr.co.koscom.pb.on.test.lab.online.mapper.TestLabMapper;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001In;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001Out;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 제목 : 계좌명조회 서비스 (f-log 테스트베드)
 *
 * <pre>
 * 서비스아이디 : TLABQ001Service
 * 설 명 : 계좌번호로 계좌명을 조회한다. f-log case-01의 고의 버그를 담고 있다.
 * </pre>
 */
@Slf4j
@Service
@Transactional(readOnly = true)
@RequiredArgsConstructor
public class TLABQ001Service {

    private final TestLabMapper testLabMapper;

    private void checkParameter(TLABQ001In param) {
        if (param == null || param.getInner() == null) {
            throw PBOnlineException.create("1000", "parameter");
        }
        if (param.getInner().getAccountNo() == null || param.getInner().getAccountNo().isEmpty()) {
            throw PBOnlineException.create("1001", "accountNo");
        }
    }

    public TLABQ001Out tlabq001(TLABQ001In param) {
        checkParameter(param);
        log.debug("Querying account name: {}", param.getInner().getAccountNo());

        TLABQ001Out.Inner row = testLabMapper.selectAcnt(param.getInner());

        // f-log case-01: row가 null(조회 결과 없음)일 때 그대로 역참조한다.
        TLABQ001Out out = new TLABQ001Out();
        out.setInner(TLABQ001Out.Inner.builder()
                .acntNo(row.getAcntNo())
                .acntNm(row.getAcntNm().trim())
                .build());
        return out;
    }
}
```

- [ ] **Step 7: 컨트롤러 작성**

`TLABQ001Controller.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.qry.controller;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import kr.co.koscom.pb.framework.site.ext.model.fixed.PBRequest;
import kr.co.koscom.pb.framework.site.ext.model.fixed.PBResponse;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001In;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001Out;
import kr.co.koscom.pb.on.test.lab.online.qry.service.TLABQ001Service;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** 계좌명조회 Controller. POST /ON/TLABQ001 */
@RestController
@RequiredArgsConstructor
@Tag(name = "TLABQ001 계좌명조회", description = "f-log 테스트베드")
public class TLABQ001Controller {

    private final TLABQ001Service tlabq001Service;

    @PostMapping(value = "/ON/TLABQ001")
    @Operation(summary = "계좌명조회")
    public PBResponse<TLABQ001Out> tlabq001(@RequestBody PBRequest<TLABQ001In> param) {
        TLABQ001Out result = tlabq001Service.tlabq001(param.getData());
        return PBResponse.success(param.getCommonHeader(), result);
    }
}
```

- [ ] **Step 8: CaseLog 헬퍼 작성**

`CaseLog.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.InetAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * f-log 케이스 로그 기록기. fico log4j2 패턴
 * {@code [%-5level:%X{trace_id}:%X{fico-user-id}][${hostName}:%d{yyyy-MM-dd HH:mm:ss.SSS}][%thread][%logger:%method:%L] %msg%n}
 * 첫 줄 뒤에 스택트레이스를 붙여 {@code logs/f-log-cases/<caseId>.log}에 덮어쓴다.
 * 실제 log4j2를 쓰지 않는 이유: 설정의 {@code ${spring:...}} lookup이 Spring 컨텍스트를 요구한다.
 */
public final class CaseLog {

    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS");

    private CaseLog() {}

    public static void write(String caseId, Class<?> logger, String msg, Throwable t) throws IOException {
        Path file = Path.of("logs", "f-log-cases", caseId + ".log");
        Files.createDirectories(file.getParent());

        StackTraceElement caller = Thread.currentThread().getStackTrace()[2];
        StringWriter trace = new StringWriter();
        t.printStackTrace(new PrintWriter(trace));

        String header = String.format("[ERROR::][%s:%s][%s][%s:%s:%d] %s%n",
                InetAddress.getLocalHost().getHostName(), LocalDateTime.now().format(TS),
                Thread.currentThread().getName(), logger.getName(), caller.getMethodName(), caller.getLineNumber(), msg);
        Files.writeString(file, header + trace);
    }
}
```

- [ ] **Step 9: 테스트 통과 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests '*Case01NpeTest' -q && head -3 on-test-lab-online/logs/f-log-cases/case-01-npe.log`
Expected: BUILD SUCCESSFUL. 로그 첫 줄이 `[ERROR::][…][Test worker][kr.co.koscom.pb.on.test.lab.online.qry.service.TLABQ001Service:serviceDereferencesNullMapperResult:NN] 계좌조회 실패 accountNo=1234567890`, 둘째 줄 `java.lang.NullPointerException: Cannot invoke "...TLABQ001Out$Inner.getAcntNo()" because "row" is null`, 셋째 줄 `\tat kr.co.koscom.pb.on.test.lab.online.qry.service.TLABQ001Service.tlabq001(TLABQ001Service.java:NN)`.

- [ ] **Step 10: 전체 컴파일(앱 코드) 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:compileJava --offline -q`
Expected: 출력 없음(성공). target은 커밋하지 않는다.

---

### Task 2: Case 02 (MyBatis 바인딩)

**Files:**
- Modify: `target/build.gradle` (dependencies 블록)
- Create: `target/src/main/resources/mapper/postgres/online/TestLabMapper.xml`
- Test: `target/src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case02MybatisBindingTest.java`

**Interfaces:**
- Consumes: Task 1의 `TestLabMapper`, `TLABQ001In.Inner`, `TLABQ001Out.Inner`, `CaseLog.write`.
- Produces: XML `selectAcnt` 구문(`#{acntNo}`가 고의 버그, 정답은 `#{accountNo}`).

- [ ] **Step 1: 실패하는 테스트 작성**

`Case02MybatisBindingTest.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import kr.co.koscom.pb.on.test.lab.online.mapper.TestLabMapper;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001In;
import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.exceptions.PersistenceException;
import org.apache.ibatis.io.Resources;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactory;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** f-log case-02: XML의 #{acntNo}가 파라미터 필드 accountNo와 맞지 않는다. Spring 없이 순수 MyBatis + H2. */
class Case02MybatisBindingTest {

    private static final String XML = "mapper/postgres/online/TestLabMapper.xml";

    @Test
    void mapperParameterNameMismatch() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog;DB_CLOSE_DELAY=-1");
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE IF NOT EXISTS tlab_acnt (acnt_no VARCHAR(20) PRIMARY KEY, acnt_nm VARCHAR(50))");
        }

        Configuration cfg = new Configuration(new Environment("flog", new JdbcTransactionFactory(), ds));
        cfg.setMapUnderscoreToCamelCase(true);
        try (InputStream in = Resources.getResourceAsStream(XML)) {
            new XMLMapperBuilder(in, cfg, XML, cfg.getSqlFragments()).parse();
        }
        SqlSessionFactory factory = new SqlSessionFactoryBuilder().build(cfg);

        PersistenceException e;
        try (SqlSession session = factory.openSession()) {
            TestLabMapper mapper = session.getMapper(TestLabMapper.class);
            TLABQ001In.Inner param = TLABQ001In.Inner.builder().accountNo("1234567890").build();
            e = assertThrows(PersistenceException.class, () -> mapper.selectAcnt(param));
        }

        CaseLog.write("case-02-mybatis-binding", TestLabMapper.class, "계좌명조회 SQL 실패 accountNo=1234567890", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-02-mybatis-binding.log"));
        assertTrue(log.contains("There is no getter for property named 'acntNo'"), log);
        assertTrue(log.contains("TestLabMapper.selectAcnt"), log);
    }
}
```

- [ ] **Step 2: 컴파일 실패 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:compileTestJava --offline -q 2>&1 | head -5`
Expected: FAIL. `package org.apache.ibatis.builder.xml does not exist` 또는 `package org.h2.jdbcx does not exist`(둘 다 테스트 컴파일 클래스패스에 없음).

- [ ] **Step 3: build.gradle에 테스트 의존성 추가**

`target/build.gradle`의 `dependencies { ... }` 블록 끝, `runtimeOnly 'org.postgresql:postgresql:42.6.0'` 다음 줄에 추가:
```groovy

    // f-log 테스트베드: Spring 없이 순수 MyBatis + H2로 케이스 로그 생성
    testImplementation 'org.mybatis:mybatis:3.5.19'
    testImplementation 'com.h2database:h2'
```

- [ ] **Step 4: 매퍼 XML 작성 (고의 버그)**

`target/src/main/resources/mapper/postgres/online/TestLabMapper.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="kr.co.koscom.pb.on.test.lab.online.mapper.TestLabMapper">

    <resultMap id="acntResultMap" type="kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001Out$Inner">
        <id property="acntNo" column="acnt_no"/>
        <result property="acntNm" column="acnt_nm"/>
    </resultMap>

    <!-- f-log case-02: 파라미터 VO(TLABQ001In.Inner)의 필드는 accountNo인데 #{acntNo}로 바인딩한다. -->
    <select id="selectAcnt" parameterType="kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001In$Inner" resultMap="acntResultMap">
        SELECT acnt_no,
               acnt_nm
          FROM tlab_acnt
         WHERE acnt_no = #{acntNo}
    </select>

</mapper>
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests '*Case02MybatisBindingTest' -q && sed -n 1,4p on-test-lab-online/logs/f-log-cases/case-02-mybatis-binding.log`
Expected: BUILD SUCCESSFUL. 로그 둘째 줄 `org.apache.ibatis.exceptions.PersistenceException:` 로 시작하고 본문에 `### Error querying database.  Cause: org.apache.ibatis.reflection.ReflectionException: There is no getter for property named 'acntNo' in 'class kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001In$Inner'` 와 `### The error may exist in mapper/postgres/online/TestLabMapper.xml`, `### The error may involve kr.co.koscom.pb.on.test.lab.online.mapper.TestLabMapper.selectAcnt` 가 있다.

- [ ] **Step 6: 두 케이스 함께 통과 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline -q && ls on-test-lab-online/logs/f-log-cases/`
Expected: `case-01-npe.log  case-02-mybatis-binding.log`

---

### Task 3: Case 03 (빈 충돌)

**Files:**
- Create: `target/src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/dup/a/DupAcntMapper.java`
- Create: `target/src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/dup/b/DupAcntMapper.java`
- Test: `target/src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case03BeanConflictTest.java`

**Interfaces:**
- Consumes: Task 1의 `CaseLog.write`.
- Produces: 없음(로그 파일만).

- [ ] **Step 1: 실패하는 테스트 작성**

`Case03BeanConflictTest.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.ConflictingBeanDefinitionException;

/**
 * f-log case-03: 서로 다른 패키지의 두 클래스가 같은 빈 이름 "dupAcntMapper"를 선언한다.
 * 2026-09-17 실제 기동 실패(common-bcm bm/ac SelHigherAcntMapper)와 같은 예외 형태.
 * src/test 아래라 실제 앱의 컴포넌트 스캔에는 잡히지 않는다.
 */
class Case03BeanConflictTest {

    @Test
    void twoBeansWithSameAnnotatedName() throws Exception {
        ConflictingBeanDefinitionException e;
        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            e = assertThrows(ConflictingBeanDefinitionException.class, () -> {
                ctx.scan("kr.co.koscom.pb.on.test.lab.online.flogcase.dup");
                ctx.refresh();
            });
        }

        CaseLog.write("case-03-bean-conflict", SpringApplication.class, "Application run failed", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-03-bean-conflict.log"));
        assertTrue(log.contains("ConflictingBeanDefinitionException: Annotation-specified bean name 'dupAcntMapper'"), log);
        assertTrue(log.contains("flogcase.dup.a.DupAcntMapper") && log.contains("flogcase.dup.b.DupAcntMapper"), log);
    }
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests '*Case03BeanConflictTest' -q 2>&1 | grep -m1 -E 'Expected .* to be thrown|FAILED'`
Expected: `Expected org.springframework.context.annotation.ConflictingBeanDefinitionException to be thrown, but nothing was thrown.` (스캔할 클래스가 없어 충돌 없음).

- [ ] **Step 3: 중복 빈 두 개 작성**

`dup/a/DupAcntMapper.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase.dup.a;

import org.springframework.stereotype.Repository;

/** f-log case-03: dup.b.DupAcntMapper와 같은 빈 이름을 쓴다. */
@Repository("dupAcntMapper")
public class DupAcntMapper {
}
```

`dup/b/DupAcntMapper.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase.dup.b;

import org.springframework.stereotype.Repository;

/** f-log case-03: dup.a.DupAcntMapper와 같은 빈 이름을 쓴다. */
@Repository("dupAcntMapper")
public class DupAcntMapper {
}
```

- [ ] **Step 4: 세 케이스 모두 통과 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline -q && ls on-test-lab-online/logs/f-log-cases/ && sed -n 2,3p on-test-lab-online/logs/f-log-cases/case-03-bean-conflict.log`
Expected: 로그 3개. case-03 둘째 줄 `org.springframework.context.annotation.ConflictingBeanDefinitionException: Annotation-specified bean name 'dupAcntMapper' for bean class [kr.co.koscom.pb.on.test.lab.online.flogcase.dup.b.DupAcntMapper] conflicts with existing, non-compatible bean definition of same name and class [kr.co.koscom.pb.on.test.lab.online.flogcase.dup.a.DupAcntMapper]`, 셋째 줄 `\tat org.springframework.context.annotation.ClassPathBeanDefinitionScanner.checkCandidate(...)`. (a/b 순서는 파일시스템 순서라 뒤바뀔 수 있다.)

---

### Task 4: 정답 YAML 3개

**Files:**
- Create: `target/f-log-cases/case-01-npe.yaml`
- Create: `target/f-log-cases/case-02-mybatis-binding.yaml`
- Create: `target/f-log-cases/case-03-bean-conflict.yaml`

**Interfaces:**
- Produces: Task 5의 `GoldenCase` 형태와 1:1 대응하는 6필드 YAML. 파일명(확장자 제외)이 케이스 ID.

- [ ] **Step 1: 세 파일 작성**

`case-01-npe.yaml`:
```yaml
# f-log 정답. 필드 의미는 gordian-coder scripts/flog-eval.ts 참조.
log: logs/f-log-cases/case-01-npe.log
exception: java.lang.NullPointerException
cause_files:
  - src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java
cause_symbol: tlabq001
fix_keywords_any: ["null", "Optional", "PBOnlineException", "1001"]
rule: npe
```

`case-02-mybatis-binding.yaml`:
```yaml
log: logs/f-log-cases/case-02-mybatis-binding.log
exception: org.apache.ibatis.exceptions.PersistenceException
cause_files:
  - src/main/resources/mapper/postgres/online/TestLabMapper.xml
cause_symbol: selectAcnt
fix_keywords_any: ["acntNo", "accountNo", "파라미터", "parameter"]
rule: fico_mybatis
```

`case-03-bean-conflict.yaml`:
```yaml
log: logs/f-log-cases/case-03-bean-conflict.log
exception: org.springframework.context.annotation.ConflictingBeanDefinitionException
cause_files:
  - src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/dup/a/DupAcntMapper.java
  - src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/dup/b/DupAcntMapper.java
cause_symbol: dupAcntMapper
fix_keywords_any: ["빈 이름", "bean name", "@Repository", "스캔", "scan"]
rule: fico_wiring
```

- [ ] **Step 2: 파싱 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online && for f in f-log-cases/*.yaml; do bun -e "const y=Bun.YAML.parse(await Bun.file('$f').text()); console.log('$f', Object.keys(y).length, y.cause_files.length)"; done`
Expected:
```
f-log-cases/case-01-npe.yaml 6 1
f-log-cases/case-02-mybatis-binding.yaml 6 1
f-log-cases/case-03-bean-conflict.yaml 6 2
```

---

### Task 5: `scripts/flog-eval.ts` 러너+채점기

**Files:**
- Create: `gordian-coder(worktree)/scripts/flog-eval.ts`
- Test: `gordian-coder(worktree)/scripts/__tests__/flog-eval.test.ts`

**Interfaces:**
- Consumes: Task 4 YAML, f-log 리포트 md(절 헤더는 Global Constraints 참조), `opencode run --command f-log [-m <model>] -- "<args>"`.
- Produces:
  ```ts
  export interface GoldenCase { id: string; log: string; exception: string; cause_files: string[]; cause_symbol: string; fix_keywords_any: string[]; rule?: string }
  export function splitSections(md: string): Record<string, string>   // "## 제목" → 본문. 제목은 trim, 본문은 다음 "## "까지
  export function score(c: GoldenCase, md: string): Record<"exception"|"cause_file"|"cause_symbol"|"fix"|"rule", boolean>
  ```
  `import.meta.main`일 때만 CLI 실행.

- [ ] **Step 1: 실패하는 테스트 작성**

`scripts/__tests__/flog-eval.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { score, splitSections, type GoldenCase } from "../flog-eval";

const REPORT = `# f-log 리포트

## 요약
NullPointerException — TLABQ001Service.tlabq001에서 매퍼 결과 null 역참조.

## 스택 원문
\`\`\`
java.lang.NullPointerException: Cannot invoke ...
\`\`\`

## 진입점 → 원인 경로
- 진입점: Case01NpeTest.serviceDereferencesNullMapperResult
- 원인 프레임: src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java tlabq001

## 원인 상세와 근거
selectAcnt가 null을 반환했는데 row.getAcntNo()를 호출.

## 해결 방안
row == null이면 PBOnlineException.create("1001", accountNo)를 던진다.

## 실행 정보
- 적용 룰: npe, fico_exception_flow
`;

const CASE: GoldenCase = {
  id: "case-01-npe",
  log: "logs/f-log-cases/case-01-npe.log",
  exception: "java.lang.NullPointerException",
  cause_files: ["src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java"],
  cause_symbol: "tlabq001",
  fix_keywords_any: ["null", "Optional"],
  rule: "npe",
};

describe("flog-eval", () => {
  test("splitSections keys by '## ' header and keeps body until the next header", () => {
    const s = splitSections(REPORT);
    expect(Object.keys(s)).toEqual(["요약", "스택 원문", "진입점 → 원인 경로", "원인 상세와 근거", "해결 방안", "실행 정보"]);
    expect(s["해결 방안"]).toContain("PBOnlineException");
    expect(s["해결 방안"]).not.toContain("적용 룰");
  });

  test("score passes every check on a matching report", () => {
    expect(score(CASE, REPORT)).toEqual({ exception: true, cause_file: true, cause_symbol: true, fix: true, rule: true });
  });

  test("cause_file accepts a basename-only mention, case-insensitively", () => {
    const md = REPORT.replace("src/main/java/kr/co/koscom/pb/on/test/lab/online/qry/service/TLABQ001Service.java", "tlabq001service.java");
    expect(score(CASE, md).cause_file).toBe(true);
  });

  test("fix fails when no keyword appears in the resolution section only", () => {
    const md = REPORT.replace("row == null이면 PBOnlineException.create(\"1001\", accountNo)를 던진다.", "매퍼 결과를 검사한다.");
    const r = score(CASE, md);
    expect(r.fix).toBe(false);
    expect(r.exception).toBe(true);
  });

  test("rule check passes when the case declares no rule; english headers are recognised", () => {
    const en = `## Summary\nNPE\n## Entry point → cause path\nTLABQ001Service.java tlabq001\n## Cause and evidence\nnull\n## Resolution\nadd a null check\n## Run info\n- rules: none\n`;
    const { rule, ...rest } = CASE;
    expect(score(rest, en)).toEqual({ exception: false, cause_file: true, cause_symbol: true, fix: true, rule: true });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis && bun test scripts/__tests__/flog-eval.test.ts 2>&1 | tail -3`
Expected: FAIL, `Cannot find module "../flog-eval"`.

- [ ] **Step 3: 스크립트 작성**

`scripts/flog-eval.ts`:
```ts
#!/usr/bin/env bun
/**
 * f-log 평가 러너 + 채점기.
 *
 *   bun scripts/flog-eval.ts <target-dir> [--model <provider/model>] [--case <id>] [--no-run]
 *
 * <target-dir>/f-log-cases/<id>.yaml 마다 target-dir에서 `opencode run --command f-log`를 돌려
 * .fico/report/f-log/<id>.md 를 만들고, 리포트 절을 정답과 대조해 PASS/FAIL 표를 찍는다.
 * FAIL 또는 리포트 없음이 하나라도 있으면 exit 1. --no-run 은 기존 리포트만 채점한다.
 * 설계: docs/superpowers/specs/2026-09-17-f-log-eval-testbed-design.md §6
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

export interface GoldenCase {
  id: string;
  log: string;
  exception: string;
  cause_files: string[];
  cause_symbol: string;
  fix_keywords_any: string[];
  rule?: string;
}

// 리포트 절 헤더 (finalize.ts L 상수의 ko/en). 순서: summary, path, cause, fix, run
const SECTIONS = {
  summary: ["요약", "Summary"],
  path: ["진입점 → 원인 경로", "Entry point → cause path"],
  cause: ["원인 상세와 근거", "Cause and evidence"],
  fix: ["해결 방안", "Resolution"],
  run: ["실행 정보", "Run info"],
};

export function splitSections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { key = h[1]; out[key] = ""; continue; }
    if (key !== null) out[key] += line + "\n";
  }
  return out;
}

function pick(sections: Record<string, string>, names: string[]): string {
  return names.map((n) => sections[n] ?? "").join("\n").toLowerCase();
}

export function score(c: GoldenCase, md: string) {
  const s = splitSections(md);
  const where = pick(s, [...SECTIONS.summary, ...SECTIONS.path, ...SECTIONS.cause]);
  const fix = pick(s, SECTIONS.fix);
  const run = pick(s, SECTIONS.run);
  const has = (hay: string, needle: string) => hay.includes(needle.toLowerCase());
  return {
    exception: has(where, c.exception),
    cause_file: c.cause_files.some((f) => has(where, f) || has(where, basename(f))),
    cause_symbol: has(where, c.cause_symbol),
    fix: c.fix_keywords_any.some((k) => has(fix, k)),
    rule: c.rule ? has(run, c.rule) : true,
  };
}

async function loadCases(target: string, only?: string): Promise<GoldenCase[]> {
  const dir = join(target, "f-log-cases");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const cases: GoldenCase[] = [];
  for (const f of files) {
    const id = f.replace(/\.yaml$/, "");
    if (only && id !== only) continue;
    const y = Bun.YAML.parse(await Bun.file(join(dir, f)).text()) as Omit<GoldenCase, "id">;
    cases.push({ id, ...y });
  }
  return cases;
}

function runFLog(target: string, c: GoldenCase, report: string, model?: string): void {
  // finalize는 같은 --output 이 이미 있으면 log-<runId>.md 로 비켜 쓴다(I-5). 미리 지운다.
  rmSync(join(target, report), { force: true });
  mkdirSync(join(target, ".fico/report/f-log"), { recursive: true });
  const cmd = ["opencode", "run", "--command", "f-log", ...(model ? ["-m", model] : []), "--", `--file=${c.log} --output=${report}`];
  console.log(`\n$ ${cmd.join(" ")}`);
  const r = Bun.spawnSync(cmd, { cwd: target, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) console.error(`opencode exited ${r.exitCode} for ${c.id}`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--model" && args[i - 1] !== "--case");
  if (!target) { console.error("usage: bun scripts/flog-eval.ts <target-dir> [--model <id>] [--case <id>] [--no-run]"); process.exit(2); }
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const model = flag("--model");
  const only = flag("--case");
  const noRun = args.includes("--no-run");

  const cases = await loadCases(target, only);
  if (!cases.length) { console.error(`no cases in ${join(target, "f-log-cases")}`); process.exit(2); }

  const rows: string[] = [];
  let failed = 0;
  for (const c of cases) {
    const report = `.fico/report/f-log/${c.id}.md`;
    if (!noRun) runFLog(target, c, report, model);
    const full = join(target, report);
    if (!existsSync(full)) { rows.push(`| ${c.id} | – | – | – | – | – | 리포트 없음 |`); failed++; continue; }
    const r = score(c, await Bun.file(full).text());
    const cell = (b: boolean) => (b ? "PASS" : "FAIL");
    if (Object.values(r).some((b) => !b)) failed++;
    rows.push(`| ${c.id} | ${cell(r.exception)} | ${cell(r.cause_file)} | ${cell(r.cause_symbol)} | ${cell(r.fix)} | ${cell(r.rule)} | ${report} |`);
  }
  console.log("\n| case | exception | cause_file | cause_symbol | fix | rule | report |");
  console.log("|---|---|---|---|---|---|---|");
  for (const row of rows) console.log(row);
  console.log(`\n${cases.length - failed}/${cases.length} cases fully PASS`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis && bun test scripts/__tests__/flog-eval.test.ts 2>&1 | tail -4 && bun run typecheck`
Expected: `5 pass, 0 fail`, tsc 출력 없음. `tsconfig.json`의 include는 `src/**/*`뿐이라 tsc가 `scripts/`를 보지 않는다 — 타입 확인은 `bunx tsc --noEmit --target esnext --module esnext --moduleResolution bundler --types bun-types --strict scripts/flog-eval.ts`로 별도 실행하고 출력 없음을 확인한다.

- [ ] **Step 5: `--no-run` 채점 경로 확인 (실 리포트 없이)**

Run:
```bash
cd /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis
T=/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online
bun scripts/flog-eval.ts $T --no-run; echo "exit=$?"
```
Expected: 3행 모두 `리포트 없음`, `0/3 cases fully PASS`, `exit=1`.

- [ ] **Step 6: 커밋**

```bash
cd /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis
git add scripts/flog-eval.ts scripts/__tests__/flog-eval.test.ts
git commit -m "Add flog-eval, the f-log golden-case runner and scorer"
```

---

### Task 6: 실환경 1회 실행과 결과 기록

**Files:**
- Create: `gordian-coder(worktree)/docs/reports/f-log-eval-testbed-run1-20260917.md`
- Modify: `gordian-coder(worktree)/docs/guides/f-log-usage.md` (끝에 "평가 테스트베드" 절 추가)

**Interfaces:**
- Consumes: Task 1–5 전부. OpenCode 글로벌 설정이 이 워크트리의 `dist`를 가리키므로 실행 전 `bun run build` 필수.

- [ ] **Step 1: 플러그인 빌드와 로그 재생성**

Run:
```bash
cd /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis && bun run build 2>&1 | tail -1
cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline -q && ls on-test-lab-online/logs/f-log-cases/
```
Expected: `adapters/opencode/index.js … (entry point)`, 로그 3개.

- [ ] **Step 2: 케이스 1개로 호출 방식 검증**

Run:
```bash
cd /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis
T=/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online
bun scripts/flog-eval.ts $T --case case-01-npe 2>&1 | tee /tmp/flog-eval-case01.txt | tail -8
```
Expected: `.fico/report/f-log/case-01-npe.md`가 생기고 표에 case-01 행이 PASS/FAIL로 채워진다. 리포트가 안 생기면 `opencode run --command f-log`의 인자 전달(`--` 뒤 문자열)이 문제이니 `$T`에서 `opencode run --command f-log -- "--file=logs/f-log-cases/case-01-npe.log --output=.fico/report/f-log/case-01-npe.md"`를 직접 실행해 출력을 본다. 모델 기본값이 안 맞으면 `--model` 지정(예: 설치 스크립트 기본값 Qwen-Inference 계열).

- [ ] **Step 3: 전체 실행**

Run: `bun scripts/flog-eval.ts $T 2>&1 | tee /tmp/flog-eval-run1.txt | tail -8`
Expected: 3행 표와 `N/3 cases fully PASS`. FAIL은 정상 결과다 — 이 테스트베드의 목적이 f-log의 빈틈을 찾는 것이다.

- [ ] **Step 4: 결과 보고서 작성**

`docs/reports/f-log-eval-testbed-run1-20260917.md` — 아래 틀을 실제 값으로 채운다(표는 Step 3 출력 그대로 붙인다):
```markdown
# f-log 평가 테스트베드 1차 실행 (2026-09-17)

대상: on-test-lab-online, 케이스 3개. 모델: <실제 사용 모델>. 스크립트: `scripts/flog-eval.ts`.

## 결과

<Step 3의 표>

## 케이스별 소견

### case-01-npe
- 리포트가 짚은 원인 파일/심볼: <리포트 "진입점 → 원인 경로" 절 요약>
- 정답과의 차이: <없음 | 무엇이 달랐는지>
- 해결 방안 품질: <한두 문장>

### case-02-mybatis-binding
(같은 형식. 특히 XML 파일을 용의 파일로 찾았는지.)

### case-03-bean-conflict
(같은 형식. 특히 두 DupAcntMapper 중 어느 쪽을 지목했고 빈 이름/스캔 범위 중 어떤 해법을 냈는지.)

## 발견한 f-log 개선점
1. <구체 항목 — 파서/플랜/룰/프롬프트 중 어디인지>

## 채점기 개선점
1. <예: 기준이 너무 느슨/엄격했던 항목>

## 다음
- <다음 케이스 후보 또는 위 개선점 착수 순서>
```

- [ ] **Step 5: 사용 가이드에 절 추가**

`docs/guides/f-log-usage.md` 끝에 추가:
```markdown

## 평가 테스트베드

`scripts/flog-eval.ts`는 대상 프로젝트의 `f-log-cases/<id>.yaml`(정답)마다 f-log를 실행해 리포트를 자동 채점한다.

```bash
bun scripts/flog-eval.ts /path/to/target [--model provider/model] [--case case-01-npe] [--no-run]
```

정답 YAML 필드: `log`(로그 경로), `exception`(체인 중 하나의 FQCN), `cause_files`(하나 이상 등장), `cause_symbol`(메서드/SQL id), `fix_keywords_any`(해결 방안 절에 하나 이상), `rule`(선택, 실행 정보의 적용 룰). 첫 대상 프로젝트는 `on-test-lab-online`이며 `gradle test`가 케이스 로그를 다시 만든다. 설계: `docs/superpowers/specs/2026-09-17-f-log-eval-testbed-design.md`.
```

- [ ] **Step 6: 커밋**

```bash
cd /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis
git add docs/reports/f-log-eval-testbed-run1-20260917.md docs/guides/f-log-usage.md
git commit -m "Record the first f-log test-bed run and document flog-eval"
```

---

## Self-review 메모

- 스펙 §3 구조: Task 1–5가 파일 전부를 만든다. `.gitignore`는 Task 1.
- §4 세 케이스: Task 1·2·3. CaseLog 형식은 Global Constraints와 Task 1 Step 8 코드가 일치.
- §5 YAML: Task 4. 필드명은 Task 5 `GoldenCase`와 동일(`cause_files`, `fix_keywords_any`).
- §6 러너: Task 5. 절 헤더 문자열은 finalize.ts와 동일. `--no-run` 경로는 Step 5에서 확인.
- §7 부팅 수정은 범위 밖 — 이 계획에 없음(의도).
- 첫 실환경 실행(성공 기준)은 Task 6.
