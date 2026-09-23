# f-log 100케이스 확장 — Phase 2 (Category B: MyBatis·SQL·DataSource·Wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카탈로그의 케이스 35~50(16개 — Category B 나머지 14개 + Category C 첫 2개)을 on-test-lab-online에 JUnit 케이스로 만들고 정답 YAML을 붙인다. 지금까지 34개(01~34) 완료됨. 이 계획이 끝나면 50개.

**Architecture:** MyBatis 케이스(35~40)는 케이스-03/02와 같은 패턴 — 순수 MyBatis(`XMLMapperBuilder`) + H2 인메모리, 케이스별로 독립된 XML/인터페이스/테이블. SQL 케이스(41~45)는 MyBatis 없이 순수 JDBC(H2 `Connection`/`Statement`)로 더 단순하게 재현한다(SQL 문법·제약조건 오류는 MyBatis가 개입할 이유가 없음). DataSource 케이스(46~48)는 HikariCP + Spring `JdbcTemplate`. Wiring 케이스(49~50)는 Category A에서 이미 검증된 `AnnotationConfigApplicationContext` 패턴 재사용. `cause_files`는 전부 해당 테스트 파일 자신(케이스 01~34와 같은 전례).

**Tech Stack:** Java 21, Gradle(offline), JUnit 5.11, MyBatis 3.5.19, H2 2.3.232(소스 직접 확인), HikariCP 5.1.0(소스 직접 확인), spring-jdbc 6.2.14(소스 직접 확인), Spring 6.2(`AnnotationConfigApplicationContext`). 전부 on-test-lab-online의 기존 의존성.

**Spec:** `docs/superpowers/specs/2026-09-18-f-log-eval-100-cases-catalog.md` §B(35~48), §C(49~50) · 상위 스펙 `docs/superpowers/specs/2026-09-17-f-log-eval-testbed-design.md`

## Global Constraints

- `target` = `/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online`. Gradle: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:<task> --offline`. `--tests`는 대괄호 구간(`[4-9]`) 미지원, `*` 와일드카드만 된다. macOS엔 `timeout` 없음.
- **target은 절대 커밋하지 않는다.** 대상 저장소는 전부 미추적 상태. **target 안에서는 git 명령을 단 하나도 실행하지 않는다 — 읽기 전용 `git status`/`git diff`조차 금지.** (이전 Phase에서 두 번 반복된 실수: 파일 확인은 `ls`/`cat`/`find`로만 한다.)
- 패키지 `kr.co.koscom.pb.on.test.lab.online.flogcase`, 파일 `Case NN....Test.java`(NN 두 자리). 헬퍼가 필요하면 같은 파일의 `private static` 중첩 클래스로 — 새 파일을 늘리지 않는다. MyBatis 케이스의 XML만 예외로 `src/test/resources/mapper/flogcase/caseNN.xml`에 둔다(프로덕션 `src/main`은 건드리지 않는다. 단, 40번은 XML 파일조차 필요 없다 — 아래 참조).
- 로그 파일 `logs/f-log-cases/case-NN-<slug>.log`. `CaseLog.write(caseId, loggerClass, msg, throwable)`(Task 1)는 그대로 재사용, 수정 금지.
- 골든 YAML `f-log-cases/case-NN-<slug>.yaml`, 필드는 정확히 `log, exception, cause_files, cause_symbol, fix_keywords_any, rule(선택)` 6개. `rule` 필드는 실제 f-log 룰의 `exceptions` 패턴과 맞아야 한다 — Phase 1 최종 리뷰에서 `CommonException`처럼 범용 타입에 특정 룰을 기대하면 안 된다는 교훈이 있었다. 이번 16개는 구체적 예외 타입(`TooManyResultsException`, `JdbcSQLSyntaxErrorException` 등)이라 문제 될 여지가 적지만, `rule` 필드를 넣기 전에 해당 룰 파일(`src/core/log/rules/fico_*.md`)의 `exceptions:` 줄을 실제로 열어 패턴이 그 예외 타입에 매칭되는지 `grep`으로 직접 확인한다(추측 금지).
- 각 테스트는 `assertThrows`로 예외 발생을 확인한 뒤 `CaseLog.write`로 기록하고, 로그 내용에 대한 구체적 assertion을 최소 2개 넣는다(예외 클래스명, 메시지 일부, 테스트 클래스명 중 서로 다른 것 2개 — 한쪽이 상시 참이 되는 `||` 조합은 쓰지 않는다, Phase 1 Task A2의 결함 전례). `gradle test`는 항상 green.
- 케이스마다 **독립된 H2 인메모리 DB**를 쓴다(`jdbc:h2:mem:flogNN;DB_CLOSE_DELAY=-1` 처럼 케이스 번호를 이름에 넣어 케이스 간 테이블 충돌을 피한다).
- 커밋 메시지에 `Co-Authored-By` 줄을 넣지 않는다.

## 실측 검증 근거(구현 전 소스 코드 직접 확인, 추측 없음)

- MyBatis 3.5.19 소스(`org/apache/ibatis/...`): `ResultMapException`은 `BaseTypeHandler.getResult`가 컬럼 값 변환 실패 시(`SQLException` 래핑), `TooManyResultsException`은 `DefaultSqlSession.selectOne`이 결과 2건 이상일 때, `BindingException`("Invalid bound statement (not found): ...")은 `MapperMethod` 생성 시 XML statement id가 없을 때, `ExecutorException`("No constructor found in ...")은 `DefaultResultSetHandler.createByConstructorSignature`가 기본 생성자 없는 클래스에 컬럼 수와 맞는 생성자를 못 찾을 때, `BuilderException`("Error creating document instance...")은 `XPathParser`가 깨진 XML을 파싱할 때. `ForEachSqlNode`는 빈 컬렉션 가드가 없어 `IN ()`을 그대로 렌더링한다.
- H2 2.3.232 소스(`org/h2/...`): `DbException.getJdbcSQLException`이 SQLState 클래스 앞 2자리로 분기 — `42`(구문 오류)→`JdbcSQLSyntaxErrorException`, `23`(제약조건, NOT NULL=23502·중복키=23505 둘 다)→`JdbcSQLIntegrityConstraintViolationException`, `22`(데이터, VALUE_TOO_LONG=22001)→`JdbcSQLDataException`. `Value.convertToBlob`류의 정밀도 변환 경로는 `ASSIGN_TO` 모드(일반 INSERT)에서 길이 초과 시 예외를 던진다(자르지 않음) — 기본 설정으로 충분.
- HikariCP 5.1.0 소스: 풀 타임아웃은 표준 JDBC `java.sql.SQLTransientConnectionException`("Connection is not available, request timed out after Nms")을 던진다(Hikari 전용 타입 아님). `HikariConfig.setInitializationFailTimeout(-1)`로 두면 풀 생성 시점이 아니라 실제 `getConnection()` 시점에 연결 실패가 난다.
- spring-jdbc 6.2.14 소스: `DataSourceUtils.getConnection`이 커넥션 획득 실패를 `CannotGetJdbcConnectionException`으로 래핑 — `JdbcTemplate`의 모든 메서드가 이 경로를 거친다.

---

## 파일 구조

| 파일(모두 target 안, 미커밋) | 케이스 |
|---|---|
| `flogcase/Case35...Test.java` ~ `Case40...Test.java` | 35~40 (Task B1, MyBatis) |
| `src/test/resources/mapper/flogcase/case35.xml`, `case36.xml`, `case38.xml`, `case39.xml` | 35,36,38,39용 (37·40은 XML 파일 불필요, 아래 참조) |
| `flogcase/Case41...Test.java` ~ `Case45...Test.java` | 41~45 (Task B2, 순수 SQL) |
| `flogcase/Case46...Test.java` ~ `Case50...Test.java` | 46~50 (Task B3, DataSource+Wiring) |
| `f-log-cases/case-35-...yaml` ~ `case-50-...yaml` | 16개 |

---

### Task B1: MyBatis 매핑·바인딩 오류 (케이스 35~40, 6개)

**Files:**
- Create (target): `flogcase/Case35MybatisResultMappingTest.java`
- Create (target): `src/test/resources/mapper/flogcase/case35.xml`
- Create (target): `flogcase/Case36MybatisTooManyResultsTest.java`
- Create (target): `src/test/resources/mapper/flogcase/case36.xml`
- Create (target): `flogcase/Case37MybatisUnknownStatementTest.java`
- Create (target): `flogcase/Case38MybatisNoConstructorTest.java`
- Create (target): `src/test/resources/mapper/flogcase/case38.xml`
- Create (target): `flogcase/Case39MybatisForeachEmptyListTest.java`
- Create (target): `src/test/resources/mapper/flogcase/case39.xml`
- Create (target): `flogcase/Case40MybatisXmlParseErrorTest.java`
- Create (target): `f-log-cases/case-35-mybatis-result-mapping.yaml` ~ `case-40-mybatis-xml-parse-error.yaml` (6개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1). 케이스-02의 H2+`XMLMapperBuilder` 부트스트랩 패턴(같은 파일에 이미 있음, 그대로 참고).
- Produces: 없음(다음 태스크와 파일 공유 없음).

- [ ] **Step 1: Case35 — VARCHAR 컬럼을 Integer 필드로 매핑**

`src/test/resources/mapper/flogcase/case35.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="kr.co.koscom.pb.on.test.lab.online.flogcase.Case35MybatisResultMappingTest$Mapper35">
    <resultMap id="row35" type="kr.co.koscom.pb.on.test.lab.online.flogcase.Case35MybatisResultMappingTest$Row35">
        <id property="code" column="code"/>
        <!-- f-log case-35: val 컬럼은 VARCHAR인데 Integer 필드로 매핑한다. -->
        <result property="val" column="val"/>
    </resultMap>
    <select id="selectRow" resultMap="row35">
        SELECT code, val FROM tlab_c35 WHERE code = #{code}
    </select>
</mapper>
```

`flogcase/Case35MybatisResultMappingTest.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import org.apache.ibatis.annotations.Mapper;
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

/** f-log case-35: VARCHAR 컬럼 값 "abc"를 Integer 필드로 매핑 — 타입 변환 실패. */
class Case35MybatisResultMappingTest {

    @Mapper
    public interface Mapper35 {
        Row35 selectRow(String code);
    }

    public static class Row35 {
        public String code;
        public Integer val;
    }

    private static final String XML = "mapper/flogcase/case35.xml";

    @Test
    void mybatisResultMapping() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog35;DB_CLOSE_DELAY=-1");
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c35 (code VARCHAR(10) PRIMARY KEY, val VARCHAR(10))");
            s.execute("INSERT INTO tlab_c35 VALUES ('A1', 'abc')");
        }

        Configuration cfg = new Configuration(new Environment("flog35", new JdbcTransactionFactory(), ds));
        try (InputStream in = Resources.getResourceAsStream(XML)) {
            new XMLMapperBuilder(in, cfg, XML, cfg.getSqlFragments()).parse();
        }
        SqlSessionFactory factory = new SqlSessionFactoryBuilder().build(cfg);

        PersistenceException e;
        try (SqlSession session = factory.openSession()) {
            Mapper35 mapper = session.getMapper(Mapper35.class);
            e = assertThrows(PersistenceException.class, () -> mapper.selectRow("A1"));
        }

        CaseLog.write("case-35-mybatis-result-mapping", Mapper35.class, "결과 매핑 실패 code=A1 val=abc", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-35-mybatis-result-mapping.log"));
        assertTrue(log.contains("ResultMapException") || log.contains("PersistenceException"), log);
        assertTrue(log.contains("Case35MybatisResultMappingTest"), log);
    }
}
```
비고: `ResultMapException`은 `PersistenceException`으로 감싸지지 않고 직접 던져질 수도 있다(MyBatis 버전에 따라 `selectRow` 호출 경로가 다름) — `assertThrows(PersistenceException.class, ...)`가 실패하면 `RuntimeException.class`로 넓히고 실제 클래스명을 로그 assertion에서 확인한다.

- [ ] **Step 2: Case36 — selectOne인데 2행**

`src/test/resources/mapper/flogcase/case36.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="kr.co.koscom.pb.on.test.lab.online.flogcase.Case36MybatisTooManyResultsTest$Mapper36">
    <select id="selectOneRow" resultType="string">
        SELECT name FROM tlab_c36 ORDER BY name
    </select>
</mapper>
```

`flogcase/Case36MybatisTooManyResultsTest.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.exceptions.TooManyResultsException;
import org.apache.ibatis.io.Resources;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactory;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** f-log case-36: 단건 조회를 의도한 매퍼 메서드(selectOne)가 2행을 돌려받는다. */
class Case36MybatisTooManyResultsTest {

    @Mapper
    public interface Mapper36 {
        String selectOneRow(); // 단건 반환 타입 — MyBatis가 selectOne으로 처리
    }

    private static final String XML = "mapper/flogcase/case36.xml";

    @Test
    void mybatisTooManyResults() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog36;DB_CLOSE_DELAY=-1");
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c36 (name VARCHAR(20))");
            s.execute("INSERT INTO tlab_c36 VALUES ('a'), ('b')");
        }

        Configuration cfg = new Configuration(new Environment("flog36", new JdbcTransactionFactory(), ds));
        try (InputStream in = Resources.getResourceAsStream(XML)) {
            new XMLMapperBuilder(in, cfg, XML, cfg.getSqlFragments()).parse();
        }
        SqlSessionFactory factory = new SqlSessionFactoryBuilder().build(cfg);

        TooManyResultsException e;
        try (SqlSession session = factory.openSession()) {
            Mapper36 mapper = session.getMapper(Mapper36.class);
            e = assertThrows(TooManyResultsException.class, mapper::selectOneRow);
        }

        CaseLog.write("case-36-mybatis-too-many-results", Mapper36.class, "단건 조회 실패 결과 2건", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-36-mybatis-too-many-results.log"));
        assertTrue(log.contains("TooManyResultsException"), log);
        assertTrue(log.contains("Case36MybatisTooManyResultsTest"), log);
    }
}
```

- [ ] **Step 3: Case37 — 매퍼 메서드에 대응하는 XML statement 없음**

`flogcase/Case37MybatisUnknownStatementTest.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.binding.BindingException;
import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactory;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** f-log case-37: 매퍼 인터페이스에 존재하는 메서드인데 XML에 같은 id의 statement가 없다. */
class Case37MybatisUnknownStatementTest {

    @Mapper
    public interface Mapper37 {
        void selectMissing(); // XML에 id="selectMissing" 없음 — 고의
    }

    private static final String XML_TEXT = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            + "<!DOCTYPE mapper PUBLIC \"-//mybatis.org//DTD Mapper 3.0//EN\" \"http://mybatis.org/dtd/mybatis-3-mapper.dtd\">\n"
            + "<mapper namespace=\"kr.co.koscom.pb.on.test.lab.online.flogcase.Case37MybatisUnknownStatementTest$Mapper37\">\n"
            + "</mapper>\n";

    @Test
    void mybatisUnknownStatement() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog37;DB_CLOSE_DELAY=-1");

        Configuration cfg = new Configuration(new Environment("flog37", new JdbcTransactionFactory(), ds));
        try (var in = new ByteArrayInputStream(XML_TEXT.getBytes(StandardCharsets.UTF_8))) {
            new XMLMapperBuilder(in, cfg, "mapper/flogcase/case37.xml", cfg.getSqlFragments()).parse();
        }
        SqlSessionFactory factory = new SqlSessionFactoryBuilder().build(cfg);

        BindingException e;
        try (SqlSession session = factory.openSession()) {
            Mapper37 mapper = session.getMapper(Mapper37.class);
            e = assertThrows(BindingException.class, mapper::selectMissing);
        }

        CaseLog.write("case-37-mybatis-unknown-statement", Mapper37.class, "매퍼 메서드 바인딩 실패 selectMissing", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-37-mybatis-unknown-statement.log"));
        assertTrue(log.contains("BindingException"), log);
        assertTrue(log.contains("Invalid bound statement"), log);
    }
}
```
XML은 파일로 두지 않고 `ByteArrayInputStream`으로 직접 넘긴다(빈 매퍼 하나 등록하는 용도라 실제 파일이 필요 없다).

- [ ] **Step 4: Case38 — 불변 결과 클래스의 생성자와 컬럼 수 불일치**

`src/test/resources/mapper/flogcase/case38.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="kr.co.koscom.pb.on.test.lab.online.flogcase.Case38MybatisNoConstructorTest$Mapper38">
    <!-- f-log case-38: resultType은 3-인자 생성자(Row38)뿐인데 쿼리는 컬럼 2개만 반환한다. -->
    <select id="selectTwoColumns" resultType="kr.co.koscom.pb.on.test.lab.online.flogcase.Case38MybatisNoConstructorTest$Row38">
        SELECT id, name FROM tlab_c38 WHERE id = #{id}
    </select>
</mapper>
```

`flogcase/Case38MybatisNoConstructorTest.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import org.apache.ibatis.annotations.Mapper;
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

/** f-log case-38: 기본 생성자가 없는 불변 결과 클래스의 유일한 생성자(3-인자)가 쿼리의 컬럼 수(2)와 맞지 않는다. */
class Case38MybatisNoConstructorTest {

    @Mapper
    public interface Mapper38 {
        Row38 selectTwoColumns(String id);
    }

    /** 기본 생성자 없음 — 3-인자 생성자뿐. */
    public static class Row38 {
        public final String id;
        public final String name;
        public final String extra;

        public Row38(String id, String name, String extra) {
            this.id = id;
            this.name = name;
            this.extra = extra;
        }
    }

    private static final String XML = "mapper/flogcase/case38.xml";

    @Test
    void mybatisNoConstructor() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog38;DB_CLOSE_DELAY=-1");
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c38 (id VARCHAR(10) PRIMARY KEY, name VARCHAR(20))");
            s.execute("INSERT INTO tlab_c38 VALUES ('A1', 'hello')");
        }

        Configuration cfg = new Configuration(new Environment("flog38", new JdbcTransactionFactory(), ds));
        try (InputStream in = Resources.getResourceAsStream(XML)) {
            new XMLMapperBuilder(in, cfg, XML, cfg.getSqlFragments()).parse();
        }
        SqlSessionFactory factory = new SqlSessionFactoryBuilder().build(cfg);

        Exception e;
        try (SqlSession session = factory.openSession()) {
            Mapper38 mapper = session.getMapper(Mapper38.class);
            e = assertThrows(PersistenceException.class, () -> mapper.selectTwoColumns("A1"));
        }

        CaseLog.write("case-38-mybatis-no-constructor", Mapper38.class, "결과 객체 생성 실패 type=Row38 columns=2", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-38-mybatis-no-constructor.log"));
        assertTrue(log.contains("No constructor found") || log.contains("ExecutorException"), log);
        assertTrue(log.contains("Case38MybatisNoConstructorTest"), log);
    }
}
```

- [ ] **Step 5: Case39 — `<foreach>`에 빈 리스트**

`src/test/resources/mapper/flogcase/case39.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="kr.co.koscom.pb.on.test.lab.online.flogcase.Case39MybatisForeachEmptyListTest$Mapper39">
    <select id="selectByIds" resultType="string">
        SELECT id FROM tlab_c39 WHERE id IN
        <foreach item="i" collection="list" open="(" separator="," close=")">
            #{i}
        </foreach>
    </select>
</mapper>
```

`flogcase/Case39MybatisForeachEmptyListTest.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
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

/** f-log case-39: id 목록이 빈 리스트로 전달되면 <foreach>가 IN ()을 그대로 렌더링해 SQL 문법 오류가 난다. */
class Case39MybatisForeachEmptyListTest {

    @Mapper
    public interface Mapper39 {
        List<String> selectByIds(@org.apache.ibatis.annotations.Param("list") List<String> ids);
    }

    private static final String XML = "mapper/flogcase/case39.xml";

    @Test
    void mybatisForeachEmptyList() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog39;DB_CLOSE_DELAY=-1");
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c39 (id VARCHAR(10) PRIMARY KEY)");
        }

        Configuration cfg = new Configuration(new Environment("flog39", new JdbcTransactionFactory(), ds));
        try (InputStream in = Resources.getResourceAsStream(XML)) {
            new XMLMapperBuilder(in, cfg, XML, cfg.getSqlFragments()).parse();
        }
        SqlSessionFactory factory = new SqlSessionFactoryBuilder().build(cfg);

        PersistenceException e;
        try (SqlSession session = factory.openSession()) {
            Mapper39 mapper = session.getMapper(Mapper39.class);
            e = assertThrows(PersistenceException.class, () -> mapper.selectByIds(List.of()));
        }

        CaseLog.write("case-39-mybatis-foreach-empty-list", Mapper39.class, "조회 실패 ids=빈 목록", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-39-mybatis-foreach-empty-list.log"));
        assertTrue(log.contains("Syntax error") || log.contains("SyntaxError"), log);
        assertTrue(log.contains("Case39MybatisForeachEmptyListTest"), log);
    }
}
```

- [ ] **Step 6: Case40 — 깨진 XML 파싱**

`flogcase/Case40MybatisXmlParseErrorTest.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.ibatis.builder.BuilderException;
import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** f-log case-40: 매퍼 XML의 태그가 닫히지 않아 파싱 단계에서 실패한다. */
class Case40MybatisXmlParseErrorTest {

    // 고의로 <select> 태그를 닫지 않음.
    private static final String BROKEN_XML = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            + "<!DOCTYPE mapper PUBLIC \"-//mybatis.org//DTD Mapper 3.0//EN\" \"http://mybatis.org/dtd/mybatis-3-mapper.dtd\">\n"
            + "<mapper namespace=\"kr.co.koscom.pb.on.test.lab.online.flogcase.Case40MybatisXmlParseErrorTest$Mapper40\">\n"
            + "    <select id=\"broken\" resultType=\"string\">\n"
            + "        SELECT 1\n";
    // </select></mapper> 없음

    public interface Mapper40 {
        String broken();
    }

    @Test
    void mybatisXmlParseError() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog40;DB_CLOSE_DELAY=-1");
        Configuration cfg = new Configuration(new Environment("flog40", new JdbcTransactionFactory(), ds));

        BuilderException e;
        try (var in = new ByteArrayInputStream(BROKEN_XML.getBytes(StandardCharsets.UTF_8))) {
            e = assertThrows(BuilderException.class,
                    () -> new XMLMapperBuilder(in, cfg, "mapper/flogcase/case40.xml", cfg.getSqlFragments()).parse());
        }

        CaseLog.write("case-40-mybatis-xml-parse-error", XMLMapperBuilder.class, "매퍼 XML 파싱 실패 case40.xml", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-40-mybatis-xml-parse-error.log"));
        assertTrue(log.contains("BuilderException"), log);
        assertTrue(log.contains("Case40MybatisXmlParseErrorTest"), log);
    }
}
```

- [ ] **Step 7: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case3[5-9]*' --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case40*' -q`
Expected: BUILD SUCCESSFUL. `logs/f-log-cases/`에 `case-35-*`~`case-40-*` 로그 6개.

- [ ] **Step 8: 룰 파일 확인 후 골든 YAML 6개 작성**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_mybatis.md`
(`org.apache.ibatis.*`가 포함돼 있으면 35~40 전부 `org.apache.ibatis` 패키지 예외이므로 매칭된다 — 실제 출력을 보고 아래 `rule:` 값이 맞는지 확인 후 진행. 안 맞으면 `rule:` 줄을 빼고 보고서에 남긴다.)

```yaml
# case-35-mybatis-result-mapping.yaml
log: logs/f-log-cases/case-35-mybatis-result-mapping.log
exception: org.apache.ibatis.exceptions.PersistenceException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case35MybatisResultMappingTest.java"]
cause_symbol: mybatisResultMapping
fix_keywords_any: ["타입", "Integer", "변환"]
rule: fico_mybatis
```
```yaml
# case-36-mybatis-too-many-results.yaml
log: logs/f-log-cases/case-36-mybatis-too-many-results.log
exception: org.apache.ibatis.exceptions.TooManyResultsException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case36MybatisTooManyResultsTest.java"]
cause_symbol: mybatisTooManyResults
fix_keywords_any: ["selectOne", "단건", "2건", "List"]
rule: fico_mybatis
```
```yaml
# case-37-mybatis-unknown-statement.yaml
log: logs/f-log-cases/case-37-mybatis-unknown-statement.log
exception: org.apache.ibatis.binding.BindingException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case37MybatisUnknownStatementTest.java"]
cause_symbol: mybatisUnknownStatement
fix_keywords_any: ["statement", "selectMissing", "XML"]
rule: fico_mybatis
```
```yaml
# case-38-mybatis-no-constructor.yaml
log: logs/f-log-cases/case-38-mybatis-no-constructor.log
exception: org.apache.ibatis.executor.ExecutorException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case38MybatisNoConstructorTest.java"]
cause_symbol: mybatisNoConstructor
fix_keywords_any: ["생성자", "constructor", "컬럼"]
rule: fico_mybatis
```
```yaml
# case-39-mybatis-foreach-empty-list.yaml
log: logs/f-log-cases/case-39-mybatis-foreach-empty-list.log
exception: org.apache.ibatis.exceptions.PersistenceException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case39MybatisForeachEmptyListTest.java"]
cause_symbol: mybatisForeachEmptyList
fix_keywords_any: ["빈 리스트", "empty", "foreach", "IN ()"]
rule: fico_datasource
```
```yaml
# case-40-mybatis-xml-parse-error.yaml
log: logs/f-log-cases/case-40-mybatis-xml-parse-error.log
exception: org.apache.ibatis.builder.BuilderException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case40MybatisXmlParseErrorTest.java"]
cause_symbol: mybatisXmlParseError
fix_keywords_any: ["태그", "tag", "XML", "닫히지"]
rule: fico_mybatis
```
(39는 SQL 문법 오류 계열이라 `fico_datasource`가 더 맞을 수 있다 — `fico_datasource.md`와 `fico_mybatis.md` 양쪽의 `exceptions:` 를 확인해 실제 매칭되는 쪽으로 정한다.)

---

### Task B2: 순수 SQL/H2 오류 (케이스 41~45, 5개, MyBatis 불필요)

**Files:**
- Create (target): `flogcase/Case41SqlSyntaxTest.java`
- Create (target): `flogcase/Case42SqlUnknownColumnTest.java`
- Create (target): `flogcase/Case43SqlDuplicateKeyTest.java`
- Create (target): `flogcase/Case44SqlNotNullViolationTest.java`
- Create (target): `flogcase/Case45SqlDataTooLongTest.java`
- Create (target): `f-log-cases/case-41-sql-syntax.yaml` ~ `case-45-sql-data-too-long.yaml` (5개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1). H2 `JdbcDataSource` + `Connection`/`Statement` 직접 사용(MyBatis 없음).

- [ ] **Step 1: Case41 — SQL 문법 오류**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import org.h2.jdbc.JdbcSQLSyntaxErrorException;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** f-log case-41: SQL 키워드 오타(SELEC). */
class Case41SqlSyntaxTest {

    @Test
    void sqlSyntax() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog41;DB_CLOSE_DELAY=-1");

        JdbcSQLSyntaxErrorException e;
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            e = assertThrows(JdbcSQLSyntaxErrorException.class, () -> s.execute("SELEC 1"));
        }

        CaseLog.write("case-41-sql-syntax", Statement.class, "SQL 실행 실패: SELEC 1", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-41-sql-syntax.log"));
        assertTrue(log.contains("JdbcSQLSyntaxErrorException"), log);
        assertTrue(log.contains("Case41SqlSyntaxTest"), log);
    }
}
```

- [ ] **Step 2: Case42 — 존재하지 않는 컬럼 참조**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import org.h2.jdbc.JdbcSQLSyntaxErrorException;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** f-log case-42: 존재하지 않는 컬럼을 SELECT. */
class Case42SqlUnknownColumnTest {

    @Test
    void sqlUnknownColumn() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog42;DB_CLOSE_DELAY=-1");

        JdbcSQLSyntaxErrorException e;
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c42 (id VARCHAR(10))");
            e = assertThrows(JdbcSQLSyntaxErrorException.class, () -> s.execute("SELECT no_such_col FROM tlab_c42"));
        }

        CaseLog.write("case-42-sql-unknown-column", Statement.class, "SQL 실행 실패: 없는 컬럼 no_such_col", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-42-sql-unknown-column.log"));
        assertTrue(log.contains("JdbcSQLSyntaxErrorException"), log);
        assertTrue(log.contains("no_such_col") || log.contains("Column"), log);
    }
}
```

- [ ] **Step 3: Case43 — PK 중복**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import org.h2.jdbc.JdbcSQLIntegrityConstraintViolationException;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** f-log case-43: 같은 PK를 두 번 INSERT. */
class Case43SqlDuplicateKeyTest {

    @Test
    void sqlDuplicateKey() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog43;DB_CLOSE_DELAY=-1");

        JdbcSQLIntegrityConstraintViolationException e;
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c43 (id VARCHAR(10) PRIMARY KEY)");
            s.execute("INSERT INTO tlab_c43 VALUES ('A1')");
            e = assertThrows(JdbcSQLIntegrityConstraintViolationException.class,
                    () -> s.execute("INSERT INTO tlab_c43 VALUES ('A1')"));
        }

        CaseLog.write("case-43-sql-duplicate-key", Statement.class, "SQL 실행 실패: PK 중복 id=A1", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-43-sql-duplicate-key.log"));
        assertTrue(log.contains("JdbcSQLIntegrityConstraintViolationException"), log);
        assertTrue(log.contains("Case43SqlDuplicateKeyTest"), log);
    }
}
```

- [ ] **Step 4: Case44 — NOT NULL 위반**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import org.h2.jdbc.JdbcSQLIntegrityConstraintViolationException;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** f-log case-44: NOT NULL 컬럼에 null을 INSERT. */
class Case44SqlNotNullViolationTest {

    @Test
    void sqlNotNullViolation() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog44;DB_CLOSE_DELAY=-1");

        JdbcSQLIntegrityConstraintViolationException e;
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c44 (id VARCHAR(10) PRIMARY KEY, name VARCHAR(20) NOT NULL)");
            e = assertThrows(JdbcSQLIntegrityConstraintViolationException.class,
                    () -> s.execute("INSERT INTO tlab_c44 (id, name) VALUES ('A1', NULL)"));
        }

        CaseLog.write("case-44-sql-not-null-violation", Statement.class, "SQL 실행 실패: name NOT NULL 위반", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-44-sql-not-null-violation.log"));
        assertTrue(log.contains("JdbcSQLIntegrityConstraintViolationException"), log);
        assertTrue(log.contains("NAME") || log.contains("NULL"), log);
    }
}
```

- [ ] **Step 5: Case45 — VARCHAR 길이 초과**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import org.h2.jdbc.JdbcSQLDataException;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** f-log case-45: VARCHAR(20) 컬럼에 30자를 INSERT. */
class Case45SqlDataTooLongTest {

    @Test
    void sqlDataTooLong() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog45;DB_CLOSE_DELAY=-1");
        String tooLong = "A".repeat(30);

        JdbcSQLDataException e;
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c45 (id VARCHAR(10) PRIMARY KEY, name VARCHAR(20))");
            e = assertThrows(JdbcSQLDataException.class,
                    () -> s.execute("INSERT INTO tlab_c45 (id, name) VALUES ('A1', '" + tooLong + "')"));
        }

        CaseLog.write("case-45-sql-data-too-long", Statement.class, "SQL 실행 실패: name 길이 초과(30자, 제한 20자)", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-45-sql-data-too-long.log"));
        assertTrue(log.contains("JdbcSQLDataException"), log);
        assertTrue(log.contains("Case45SqlDataTooLongTest"), log);
    }
}
```

- [ ] **Step 6: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case4[1-5]*' -q`
Expected: BUILD SUCCESSFUL. 로그 5개.

- [ ] **Step 7: 룰 확인 후 골든 YAML 5개**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_datasource.md` (H2/JDBC 예외 패턴이 실제로 있는지 확인).

```yaml
# case-41-sql-syntax.yaml
log: logs/f-log-cases/case-41-sql-syntax.log
exception: org.h2.jdbc.JdbcSQLSyntaxErrorException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case41SqlSyntaxTest.java"]
cause_symbol: sqlSyntax
fix_keywords_any: ["SELEC", "SQL", "구문", "syntax"]
rule: fico_datasource
```
```yaml
# case-42-sql-unknown-column.yaml
log: logs/f-log-cases/case-42-sql-unknown-column.log
exception: org.h2.jdbc.JdbcSQLSyntaxErrorException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case42SqlUnknownColumnTest.java"]
cause_symbol: sqlUnknownColumn
fix_keywords_any: ["no_such_col", "컬럼", "column"]
rule: fico_datasource
```
```yaml
# case-43-sql-duplicate-key.yaml
log: logs/f-log-cases/case-43-sql-duplicate-key.log
exception: org.h2.jdbc.JdbcSQLIntegrityConstraintViolationException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case43SqlDuplicateKeyTest.java"]
cause_symbol: sqlDuplicateKey
fix_keywords_any: ["PK", "중복", "duplicate", "primary key"]
rule: fico_mybatis
```
```yaml
# case-44-sql-not-null-violation.yaml
log: logs/f-log-cases/case-44-sql-not-null-violation.log
exception: org.h2.jdbc.JdbcSQLIntegrityConstraintViolationException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case44SqlNotNullViolationTest.java"]
cause_symbol: sqlNotNullViolation
fix_keywords_any: ["NOT NULL", "null", "name"]
rule: fico_mybatis
```
```yaml
# case-45-sql-data-too-long.yaml
log: logs/f-log-cases/case-45-sql-data-too-long.log
exception: org.h2.jdbc.JdbcSQLDataException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case45SqlDataTooLongTest.java"]
cause_symbol: sqlDataTooLong
fix_keywords_any: ["길이", "length", "VARCHAR", "초과"]
rule: fico_mybatis
```
(43~45의 `rule` 후보는 `fico_mybatis`와 `fico_datasource` 둘 다 가능성 있다 — Step 7 앞부분에서 두 룰 파일의 `exceptions:` 를 모두 확인해 `org.h2.jdbc.*` 또는 `*IntegrityConstraintViolationException`류가 실제로 어느 쪽에 있는지 보고 맞는 쪽으로 정한다. 어느 쪽에도 없으면 `rule:` 줄을 빼고 보고서에 남긴다 — Phase 1의 교훈과 같다.)

---

### Task B3: DataSource/HikariCP + Spring 와이어링 (케이스 46~50, 5개)

**Files:**
- Create (target): `flogcase/Case46DatasourceBadUrlTest.java`
- Create (target): `flogcase/Case47DatasourcePoolExhaustedTest.java`
- Create (target): `flogcase/Case48JdbcEmptyResultTest.java`
- Create (target): `flogcase/Case49WiringNoSuchBeanTest.java`
- Create (target): `flogcase/Case50WiringNoUniqueTest.java`
- Create (target): `f-log-cases/case-46-datasource-bad-url.yaml` ~ `case-50-wiring-no-unique.yaml` (5개)

**Interfaces:**
- Consumes: `CaseLog.write`(Task 1). 46~48은 HikariCP+`JdbcTemplate`. 49~50은 Category A에서 검증된 `AnnotationConfigApplicationContext` 패턴(케이스 15/19/20 참고).

- [ ] **Step 1: Case46 — HikariCP 잘못된 URL**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.core.JdbcTemplate;

/** f-log case-46: HikariCP 데이터소스에 존재하지 않는 JDBC URL을 설정. */
class Case46DatasourceBadUrlTest {

    @Test
    void datasourceBadUrl() throws Exception {
        HikariConfig cfg = new HikariConfig();
        cfg.setJdbcUrl("jdbc:h2:tcp://127.0.0.1:1/nowhere"); // 아무도 듣지 않는 포트
        cfg.setInitializationFailTimeout(-1); // 풀 생성 시점이 아니라 첫 getConnection에서 실패하게
        cfg.setConnectionTimeout(1000);

        CannotGetJdbcConnectionException e;
        try (HikariDataSource ds = new HikariDataSource(cfg)) {
            JdbcTemplate jdbc = new JdbcTemplate(ds);
            e = assertThrows(CannotGetJdbcConnectionException.class, () -> jdbc.execute("SELECT 1"));
        }

        CaseLog.write("case-46-datasource-bad-url", JdbcTemplate.class, "DB 커넥션 획득 실패 url=jdbc:h2:tcp://127.0.0.1:1/nowhere", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-46-datasource-bad-url.log"));
        assertTrue(log.contains("CannotGetJdbcConnectionException"), log);
        assertTrue(log.contains("Case46DatasourceBadUrlTest"), log);
    }
}
```

- [ ] **Step 2: Case47 — 커넥션 풀 고갈**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLTransientConnectionException;
import org.junit.jupiter.api.Test;

/** f-log case-47: maxPoolSize=1인 풀에서 커넥션 하나를 붙잡은 채로 또 요청. */
class Case47DatasourcePoolExhaustedTest {

    @Test
    void datasourcePoolExhausted() throws Exception {
        HikariConfig cfg = new HikariConfig();
        cfg.setJdbcUrl("jdbc:h2:mem:flog47;DB_CLOSE_DELAY=-1");
        cfg.setMaximumPoolSize(1);
        cfg.setConnectionTimeout(500);

        SQLTransientConnectionException e;
        try (HikariDataSource ds = new HikariDataSource(cfg); Connection held = ds.getConnection()) {
            e = assertThrows(SQLTransientConnectionException.class, ds::getConnection);
        }

        CaseLog.write("case-47-datasource-pool-exhausted", HikariDataSource.class, "커넥션 풀 고갈 maxPoolSize=1 timeout=500ms", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-47-datasource-pool-exhausted.log"));
        assertTrue(log.contains("SQLTransientConnectionException"), log);
        assertTrue(log.contains("Case47DatasourcePoolExhaustedTest"), log);
    }
}
```

- [ ] **Step 3: Case48 — queryForObject 0행**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

/** f-log case-48: queryForObject가 0행을 만나 단건 결과를 만들 수 없다. */
class Case48JdbcEmptyResultTest {

    @Test
    void jdbcEmptyResult() throws Exception {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:flog48;DB_CLOSE_DELAY=-1");
        try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tlab_c48 (id VARCHAR(10) PRIMARY KEY, name VARCHAR(20))");
        }
        JdbcTemplate jdbc = new JdbcTemplate(ds);

        EmptyResultDataAccessException e = assertThrows(EmptyResultDataAccessException.class,
                () -> jdbc.queryForObject("SELECT name FROM tlab_c48 WHERE id = ?", String.class, "NOPE"));

        CaseLog.write("case-48-jdbc-empty-result", JdbcTemplate.class, "단건 조회 실패 id=NOPE 결과 0행", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-48-jdbc-empty-result.log"));
        assertTrue(log.contains("EmptyResultDataAccessException"), log);
        assertTrue(log.contains("Case48JdbcEmptyResultTest"), log);
    }
}
```

- [ ] **Step 4: Case49 — 스캔 밖 빈을 생성자로 필수 주입**

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
import org.springframework.stereotype.Repository;

/** f-log case-49: @Repository 빈이 컴포넌트 스캔 범위 밖이라 생성자 주입이 실패한다. */
class Case49WiringNoSuchBeanTest {

    @Repository
    static class OutsideScanRepo {
    }

    static class Svc49 {
        private final OutsideScanRepo repo;

        Svc49(OutsideScanRepo repo) {
            this.repo = repo;
        }
    }

    @Configuration
    static class Cfg {
        // OutsideScanRepo는 @ComponentScan 대상이 아니라 빈으로 등록되지 않음 — 고의.
        @Bean
        Svc49 svc49(OutsideScanRepo repo) {
            return new Svc49(repo);
        }
    }

    @Test
    void wiringNoSuchBean() throws Exception {
        UnsatisfiedDependencyException e = assertThrows(UnsatisfiedDependencyException.class,
                () -> new AnnotationConfigApplicationContext(Cfg.class));

        CaseLog.write("case-49-wiring-no-such-bean", Svc49.class, "빈 생성 실패 type=OutsideScanRepo", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-49-wiring-no-such-bean.log"));
        assertTrue(log.contains("UnsatisfiedDependencyException") || log.contains("NoSuchBeanDefinitionException"), log);
        assertTrue(log.contains("Case49WiringNoSuchBeanTest"), log);
    }
}
```

- [ ] **Step 5: Case50 — 인터페이스 구현체 2개를 타입으로 주입**

```java
package kr.co.koscom.pb.on.test.lab.online.flogcase;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.NoUniqueBeanDefinitionException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** f-log case-50: 한 인터페이스의 구현체가 2개인데 @Qualifier 없이 타입으로 주입한다. */
class Case50WiringNoUniqueTest {

    interface Notifier50 {
        void notify(String msg);
    }

    static class EmailNotifier50 implements Notifier50 {
        public void notify(String msg) {}
    }

    static class SmsNotifier50 implements Notifier50 {
        public void notify(String msg) {}
    }

    static class Svc50 {
        Svc50(Notifier50 notifier) {} // 어느 구현체인지 구분자 없음 — 고의
    }

    @Configuration
    static class Cfg {
        @Bean
        Notifier50 emailNotifier50() {
            return new EmailNotifier50();
        }

        @Bean
        Notifier50 smsNotifier50() {
            return new SmsNotifier50();
        }

        @Bean
        Svc50 svc50(Notifier50 notifier) {
            return new Svc50(notifier);
        }
    }

    @Test
    void wiringNoUnique() throws Exception {
        Exception e = assertThrows(Exception.class, () -> new AnnotationConfigApplicationContext(Cfg.class));

        CaseLog.write("case-50-wiring-no-unique", Svc50.class, "빈 주입 실패 type=Notifier50 구현체 2개", e);
        String log = Files.readString(Path.of("logs/f-log-cases/case-50-wiring-no-unique.log"));
        assertTrue(log.contains("NoUniqueBeanDefinitionException"), log);
        assertTrue(log.contains("Case50WiringNoUniqueTest"), log);
    }
}
```
`assertThrows(Exception.class, ...)`로 넓게 잡은 뒤 로그 assertion에서 `NoUniqueBeanDefinitionException`을 확인한다 — 실제로는 `UnsatisfiedDependencyException`에 감싸여 던져질 수 있어(케이스 15/49와 같은 패턴), 최상위 타입을 좁게 잡으면 실패할 수 있다.

- [ ] **Step 6: 컴파일·실행 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case4[6-9]*' --tests 'kr.co.koscom.pb.on.test.lab.online.flogcase.Case50*' -q`
Expected: BUILD SUCCESSFUL. 로그 5개.

- [ ] **Step 7: 룰 확인 후 골든 YAML 5개**

Run 먼저: `grep -n 'exceptions:' /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_datasource.md /Users/koscom/workspace/gordian-coder/.claude/worktrees/error-log-analysis/src/core/log/rules/fico_wiring.md`

```yaml
# case-46-datasource-bad-url.yaml
log: logs/f-log-cases/case-46-datasource-bad-url.log
exception: org.springframework.jdbc.CannotGetJdbcConnectionException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case46DatasourceBadUrlTest.java"]
cause_symbol: datasourceBadUrl
fix_keywords_any: ["URL", "커넥션", "connection", "jdbcUrl"]
rule: fico_datasource
```
```yaml
# case-47-datasource-pool-exhausted.yaml
log: logs/f-log-cases/case-47-datasource-pool-exhausted.log
exception: java.sql.SQLTransientConnectionException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case47DatasourcePoolExhaustedTest.java"]
cause_symbol: datasourcePoolExhausted
fix_keywords_any: ["maximumPoolSize", "풀", "pool", "timeout"]
rule: fico_datasource
```
```yaml
# case-48-jdbc-empty-result.yaml
log: logs/f-log-cases/case-48-jdbc-empty-result.log
exception: org.springframework.dao.EmptyResultDataAccessException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case48JdbcEmptyResultTest.java"]
cause_symbol: jdbcEmptyResult
fix_keywords_any: ["queryForObject", "0행", "empty", "결과 없음"]
```
```yaml
# case-49-wiring-no-such-bean.yaml
log: logs/f-log-cases/case-49-wiring-no-such-bean.log
exception: org.springframework.beans.factory.UnsatisfiedDependencyException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case49WiringNoSuchBeanTest.java"]
cause_symbol: wiringNoSuchBean
fix_keywords_any: ["스캔", "scan", "OutsideScanRepo", "빈 등록"]
rule: fico_wiring
```
```yaml
# case-50-wiring-no-unique.yaml
log: logs/f-log-cases/case-50-wiring-no-unique.log
exception: org.springframework.beans.factory.NoUniqueBeanDefinitionException
cause_files: ["src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/Case50WiringNoUniqueTest.java"]
cause_symbol: wiringNoUnique
fix_keywords_any: ["Qualifier", "구현체", "Notifier50", "고유"]
rule: fico_wiring
```
(48은 `fico_mybatis`/`fico_datasource` 어느 쪽에도 `EmptyResultDataAccessException`이 없을 가능성이 높다 — 확인 후 없으면 `rule:` 생략, 위 YAML처럼.)

- [ ] **Step 8: 16개 전체 재실행으로 회귀 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects/on-test-lab && ./gradlew :on-test-lab-online:test --offline -q && ls on-test-lab-online/logs/f-log-cases/ | wc -l`
Expected: BUILD SUCCESSFUL, 로그 파일 수 50(기존 34 + 이번 16).

---

## Self-review 메모

- 카탈로그 §B(35~48)·§C 첫 2행(49~50) = 16행 전부 Task B1(6)+B2(5)+B3(5)로 매핑됨.
- 39·43·44·45·48의 `rule` 필드는 실제 룰 파일 확인을 태스크 스텝에 명시(Phase 1 최종 리뷰의 `CommonException` 교훈 반영) — 구현자가 확인 없이 추측해 넣지 않도록 강제.
- 46~48 HikariCP/spring-jdbc 동작은 소스 코드로 직접 검증(SQLTransientConnectionException 표준 타입, CannotGetJdbcConnectionException 래핑 경로, initializationFailTimeout 옵션).
- 케이스 간 H2 DB 이름을 전부 다르게(`flog35`~`flog50`) 해 충돌 방지.
- Category C의 나머지(51~59)는 이 계획 범위 밖 — 후속 계획.
