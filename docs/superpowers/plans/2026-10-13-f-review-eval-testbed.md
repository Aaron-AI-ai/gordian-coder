# f-review 평가 테스트베드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** f-review(코드 리뷰 기능)가 10개의 숨겨둔 잠재 버그(Java/웹 빈출 4 + fico KB 위배 4 + 롬복 규약 2) + 대조군 2개를 whole-file 모드와 commit-diff 모드 양쪽에서 얼마나 정확히 찾아내는지 자동으로 채점하는 테스트베드를 만든다.

**Architecture:** `test-projects`(git 저장소)의 `on-test-lab/on-test-lab-online` 아래 `review-samples/`에 버그가 심긴 순수 Java 파일(컴파일 대상 아님, 정적 리뷰 전용)을 두고, 케이스마다 독립 커밋+태그를 쌓는다. gordian-coder `scripts/freview-eval.ts`가 `opencode run --command f-review`를 호출해 마크다운 리포트의 finding 표(`severity|category|line|rule|message|suggestion|source`)를 파싱하고 정답 YAML과 대조한다.

**Tech Stack:** Bun(채점기), 순수 Java 21 문법(컴파일되지 않는 정적 샘플), YAML(`Bun.YAML`), Git(케이스별 커밋+태그).

**Spec:** `docs/superpowers/specs/2026-10-13-f-review-eval-testbed-design.md`

## Global Constraints

- 대상 저장소 루트: `/Users/koscom/workspace/fico/test-projects` (git, 원격 `origin` = `http://221.168.33.62:1980/fico-ai/test-projects.git`, 브랜치 `main`). 리뷰 대상 코드 경로: `on-test-lab/on-test-lab-online`.
- **버그 샘플은 `review-samples/`에 둔다(`src/main/java` 아님)** — case-09(`@NoArgsConstructor`를 생성자 위에 배치)는 실제 자바 컴파일 에러를 유발하는 패턴이라, Gradle의 `main`/`test` sourceSet에 들어가면 f-log의 기존 100개 테스트가 깨진다. `review-samples/`는 어느 sourceSet에도 속하지 않아 `gradle build`/`gradle test`가 절대 건드리지 않는다 — **스펙 §4가 `src/main/java/.../review/`로 적어둔 경로를 이 이유로 바꾼다.** 패키지 선언은 실제처럼 `kr.co.koscom.pb.on.test.lab.online.review`를 그대로 쓴다(컴파일되지 않으므로 import가 실제로 resolve되지 않아도 무방 — 다만 실제 존재하는 fico 클래스의 정확한 FQCN을 써서 KB 매칭이 현실적으로 동작하게 한다).
- **베이스라인은 커밋 2개로 나눈다** — 스펙 §2/§4는 "베이스라인 커밋 1개"라고 적었지만, f-log의 기존 100케이스 자산(미추적 상태로 수백 개 파일)을 새 scaffolding과 한 커밋에 묶으면 대조군의 diff 모드(`baseline~1..baseline`)가 그 거대한 더미 전체를 리뷰 대상으로 삼게 되어 무의미해진다. **Ruling: Task 1이 f-log 자산만 담은 커밋 하나, Task 2가 KB 설정+대조군 2개만 담은 커밋 하나(태그 `baseline`)로 나눈다.** 이러면 `baseline~1..baseline` diff가 KB 설정 파일 1개 + Java 파일 2개로만 좁혀진다.
- 각 케이스 커밋은 **그 케이스의 새 파일 1개 + 정답 YAML 1개만** 담는다. 커밋 직후 `git tag <케이스ID>`(가벼운 태그, lightweight)를 붙인다. `<tag>~1`이 git에서 바로 동작하므로 diff 모드는 태그 이름 하나만 넘기면 된다(`resolveDiffRange`가 `<ref>~1..<ref>`로 자동 환산 — `src/core/review/pipeline/context.ts:41-49`에서 확인됨).
- 정답 YAML 필드: 버그 케이스는 `file, category, min_severity, line_range, keywords_any, kb_ref(선택), commit`. 대조군은 `file, expect_clean: true, commit`. `category`는 f-review의 `REQUIRED_CATEGORIES`(`correctness/security/performance/maintainability/tests/framework`) 중 정확히 하나, `min_severity`는 `SEVERITIES`(`blocker/major/minor/nit`, 내림차순) 중 하나.
- 채점 시 줄 번호는 `line_range`에서 ±3줄까지 허용(`LINE_TOLERANCE = 3`).
- f-review 호출은 `-m openrouter/qwen/qwen3.8-27b`를 기본 모델로 쓴다(이번 세션 f-log 평가 전체에서 써 온 값). 대상 프로젝트의 `.fico/config/fico_ai.json`에 `review.deepPasses: 1, maxToolCalls: 15, judgeRounds: 1, judge: true`를 둔다(평가 반복 속도를 위한 선택 — 실제 운영 권장값이 아님, 리뷰 품질을 낮추려는 의도가 아니라 테스트베드 실행 비용을 줄이기 위함).
- 커밋 메시지 끝에 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`를 붙인다.
- 대상 저장소(`test-projects`) 안에서 `git add`/`git commit`/`git tag`/`git push`는 **이 플랜이 명시한 범위에서만** 수행한다 — f-log 때처럼 "대상 안에서 git 금지" 규칙이 아니라, 이번엔 git 작업 자체가 테스트베드의 일부다. 단, `git status --porcelain -uall`로 의도치 않은 파일이 섞이지 않았는지 커밋 전마다 확인한다.

---

## 파일 구조

| 파일 | 역할 |
|---|---|
| `test-projects/on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/*.java` | 버그 샘플 10개 + 대조군 2개 |
| `test-projects/on-test-lab/on-test-lab-online/f-review-cases/*.yaml` | 정답 12개 |
| `test-projects/on-test-lab/on-test-lab-online/.fico/config/fico_ai.json` | f-review KB 매핑 + 실행 옵션 |
| `gordian-coder/scripts/freview-eval.ts` | 러너 + 채점기 |
| `gordian-coder/scripts/__tests__/freview-eval.test.ts` | 채점기 단위 테스트 |
| `gordian-coder/scripts/run-freview-eval.sh` | 편의 래퍼 |

---

### Task 1: f-log 평가 자산을 처음으로 커밋

**Files:**
- Commit (기존 파일 전체, 신규 작성 없음): `test-projects/on-test-lab/on-test-lab-online/**` (f-log 100케이스 테스트·골든·`build.gradle` 등)

**Interfaces:**
- Consumes: 없음(순수 git 작업).
- Produces: `main` 브랜치의 새 커밋 — Task 2 이후 모든 케이스 커밋의 조상(ancestor)이 된다.

- [ ] **Step 1: 의도치 않은 파일이 없는지 확인**

Run:
```bash
cd /Users/koscom/workspace/fico/test-projects
cat .gitignore
cat on-test-lab/on-test-lab-online/.gitignore 2>/dev/null
git status --porcelain -uall | grep -v "^?? on-test-lab/" | head -20
```
Expected: 두 `.gitignore` 모두 `build/ bin/ logs/ .fico/`를 포함(이미 세팅돼 있었음, §3 조사 근거). 마지막 명령 출력이 비어 있어야 한다(= `on-test-lab/` 바깥에 뜻밖의 변경이 없음).

- [ ] **Step 2: 스테이징하고 추적될 파일 수 확인**

Run:
```bash
git add on-test-lab/
git status --porcelain | grep "^A " | wc -l
git status --porcelain | grep "^A " | grep -E "build/|bin/|logs/|\.fico/" | head
```
Expected: 첫 번째 명령은 수백 개(f-log 100케이스 × 평균 3파일 + 설정) 양수. 두 번째 명령은 **빈 출력**(gitignore가 걸러졌는지 재확인).

- [ ] **Step 3: 커밋**

```bash
git commit -m "Add f-log evaluation testbed assets (100 cases, goldens, source)

Pre-existing work from the f-log eval testbed sessions, tracked here for
the first time so the f-review testbed's commit-diff mode has real git
history to build its own commits on top of.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git log --oneline -3
```
Expected: 새 커밋이 `main` HEAD. `git log`에 `Initial commit`(README) 다음으로 이 커밋이 보인다.

---

### Task 2: KB 연결 + 대조군 2개 + `baseline` 태그

**Files:**
- Create: `test-projects/on-test-lab/on-test-lab-online/.fico/config/fico_ai.json`
- Create: `test-projects/on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntCleanQueryService.java`
- Create: `test-projects/on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntCleanVo.java`
- Create: `test-projects/on-test-lab/on-test-lab-online/f-review-cases/control-01.yaml`
- Create: `test-projects/on-test-lab/on-test-lab-online/f-review-cases/control-02.yaml`

**Interfaces:**
- Consumes: Task 1의 커밋(이 Task의 커밋이 그 바로 다음 조상).
- Produces: git 태그 `baseline` — Task 3~5의 모든 케이스 커밋이 이 커밋의 자손이 된다. 대조군 2개의 "버그 없음" 기준선.

- [ ] **Step 1: KB 설정 파일 작성**

`test-projects/on-test-lab/on-test-lab-online/.fico/config/fico_ai.json`:
```json
{
  "review": {
    "frameworkKb": {
      "kr.co.openlabs.fico.framework.extension.*": "../../.fico/kb/fico_framework/fico-fwk-extension/",
      "kr.co.openlabs.fico.framework.*": "../../.fico/kb/fico_framework/fico-fwk-core/",
      "kr.co.koscom.pb.framework.site.ext.*": "../../.fico/kb/fico_framework/framework-site-ext/",
      "kr.co.openlabs.fico.common.*": "../../.fico/kb/fico_framework/fico-common-model/"
    },
    "deepPasses": 1,
    "maxToolCalls": 15,
    "judgeRounds": 1,
    "judge": true
  }
}
```
(`../../`는 `on-test-lab-online` → `on-test-lab` → `test-projects`까지 두 단계 올라가 실제 KB 디렉터리 `test-projects/.fico/kb/fico_framework/`에 닿는다 — `join(cwd, pattern.dir)`가 `..`를 그대로 따라가는 것을 `src/core/review/evidence/framework-kb.ts`에서 확인했다.)

- [ ] **Step 2: 대조군 서비스 작성(버그 없음)**

`test-projects/on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntCleanQueryService.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import java.util.Optional;
import kr.co.koscom.pb.on.test.lab.online.mapper.TestLabMapper;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001In;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001Out;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/**
 * 계좌 잔액 조회 서비스(정상 구현 — f-review 대조군).
 */
@Service
@RequiredArgsConstructor
public class AcntCleanQueryService {

    private final TestLabMapper testLabMapper;

    public String getBalanceLabel(String acntNo) {
        TLABQ001Out.Inner row = testLabMapper.selectAcnt(buildParam(acntNo));
        return Optional.ofNullable(row)
                .map(TLABQ001Out.Inner::getAcntNm)
                .map(String::trim)
                .orElse("조회 결과 없음");
    }

    private TLABQ001In.Inner buildParam(String acntNo) {
        return TLABQ001In.Inner.builder()
                .accountNo(acntNo)
                .build();
    }
}
```

- [ ] **Step 3: 대조군 VO 작성(버그 없음)**

`test-projects/on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntCleanVo.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 계좌 요약 정보 VO(정상 구현 — f-review 대조군).
 */
@Data
@NoArgsConstructor
public class AcntCleanVo {

    private String acntNo;
    private String acntNm;
}
```

- [ ] **Step 4: 대조군 정답 YAML 2개**

`test-projects/on-test-lab/on-test-lab-online/f-review-cases/control-01.yaml`:
```yaml
# f-review 대조군. 필드 의미는 gordian-coder scripts/freview-eval.ts 참조.
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntCleanQueryService.java
expect_clean: true
commit: baseline
```

`test-projects/on-test-lab/on-test-lab-online/f-review-cases/control-02.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntCleanVo.java
expect_clean: true
commit: baseline
```

- [ ] **Step 5: 내용 확인**

Run:
```bash
cd /Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online
sed -n '1,3p' .fico/config/fico_ai.json
sed -n '1p' f-review-cases/control-01.yaml f-review-cases/control-02.yaml
```
Expected: JSON 첫 3줄이 `{`/`  "review": {`/`    "frameworkKb": {`. YAML 두 파일 모두 주석 줄이 보인다(파일이 실제로 생성됐는지 확인).

- [ ] **Step 6: 커밋 + 태그**

```bash
cd /Users/koscom/workspace/fico/test-projects
git add on-test-lab/on-test-lab-online/.fico/config/fico_ai.json \
        on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntCleanQueryService.java \
        on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntCleanVo.java \
        on-test-lab/on-test-lab-online/f-review-cases/control-01.yaml \
        on-test-lab/on-test-lab-online/f-review-cases/control-02.yaml
git commit -m "Add f-review eval scaffolding: KB wiring + 2 clean control cases

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag baseline
git log --oneline -2
git tag -l
```
Expected: `git tag -l`에 `baseline`이 보인다.

---

### Task 3: Java/웹 빈출 케이스 4개 (case-01~04)

**Files:**
- Create: `.../review-samples/.../AcntBalanceQueryService.java`, `FileExportService.java`, `ExternalAuthClient.java`, `TxLogQueryService.java`
- Create: `.../f-review-cases/case-01.yaml` ~ `case-04.yaml`

**Interfaces:**
- Consumes: Task 2의 `baseline` 태그(각 케이스 커밋의 직전 조상).
- Produces: git 태그 `case-01`~`case-04`.

- [ ] **Step 1: case-01 — null 체크 없는 매퍼 단건 조회 역참조 (NPE)**

`.../review/AcntBalanceQueryService.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import kr.co.koscom.pb.on.test.lab.online.mapper.TestLabMapper;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001In;
import kr.co.koscom.pb.on.test.lab.online.qry.model.vo.TLABQ001Out;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/**
 * 계좌 잔액 조회 서비스.
 */
@Service
@RequiredArgsConstructor
public class AcntBalanceQueryService {

    private final TestLabMapper testLabMapper;

    public String getBalanceLabel(String acntNo) {
        TLABQ001Out.Inner row = testLabMapper.selectAcnt(buildParam(acntNo));
        String acntNm = row.getAcntNm().trim();
        return acntNm + " 계좌 잔액 조회 완료";
    }

    private TLABQ001In.Inner buildParam(String acntNo) {
        return TLABQ001In.Inner.builder()
                .accountNo(acntNo)
                .build();
    }
}
```
버그: 19행 `testLabMapper.selectAcnt(...)`가 null을 돌려줄 수 있는데 20행이 체크 없이 `row.getAcntNm()`을 호출.

`.../f-review-cases/case-01.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntBalanceQueryService.java
category: correctness
min_severity: major
line_range: [19, 20]
keywords_any: ["null", "NPE", "역참조"]
commit: case-01
```

- [ ] **Step 2: case-02 — try-with-resources 누락 (자원 누수)**

`.../review/FileExportService.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import org.springframework.stereotype.Service;

/**
 * 계좌 명세서 파일을 읽어 내보내는 서비스.
 */
@Service
public class FileExportService {

    public byte[] readStatementFile(String path) throws IOException {
        InputStream in = new FileInputStream(path);
        byte[] data = in.readAllBytes();
        in.close();
        return data;
    }
}
```
버그: 15행에서 예외가 나면 16행 `in.close()`를 못 타 자원이 누수됨(try-with-resources/finally 없음).

`.../f-review-cases/case-02.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/FileExportService.java
category: maintainability
min_severity: minor
line_range: [15, 18]
keywords_any: ["try-with-resources", "자원", "close", "leak", "누수"]
commit: case-02
```

- [ ] **Step 3: case-03 — API 키 하드코딩**

`.../review/ExternalAuthClient.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

/**
 * 외부 인증 서버 호출 클라이언트.
 */
@Component
public class ExternalAuthClient {

    private static final String API_KEY = "sk-live-4f8a9c2e7b1d4f3a9c8e7b1d4f3a9c8e";

    private final RestTemplate restTemplate = new RestTemplate();

    public String verifyToken(String token) {
        String url = "https://auth.example.com/verify?key=" + API_KEY + "&token=" + token;
        return restTemplate.getForObject(url, String.class);
    }
}
```
버그: 12행 `API_KEY`가 문자열 리터럴로 하드코딩됨.

`.../f-review-cases/case-03.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/ExternalAuthClient.java
category: security
min_severity: major
line_range: [12, 12]
keywords_any: ["API_KEY", "하드코딩", "secret", "자격증명"]
commit: case-03
```

- [ ] **Step 4: case-04 — 문자열 연결 SQL (SQL 인젝션)**

`.../review/TxLogQueryService.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import javax.sql.DataSource;
import org.springframework.stereotype.Service;

/**
 * 거래 로그 조회 서비스.
 */
@Service
public class TxLogQueryService {

    private final DataSource dataSource;

    public TxLogQueryService(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    public ResultSet findLogsByAcntNo(String acntNo) throws SQLException {
        Connection conn = dataSource.getConnection();
        Statement stmt = conn.createStatement();
        String sql = "SELECT * FROM TB_TX_LOG WHERE ACNT_NO = '" + acntNo + "'";
        return stmt.executeQuery(sql);
    }
}
```
버그: 25행이 `acntNo`를 문자열 연결로 그대로 SQL에 삽입(SQL 인젝션), 24행도 `PreparedStatement`가 아니라 `Statement`.

`.../f-review-cases/case-04.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/TxLogQueryService.java
category: security
min_severity: blocker
line_range: [24, 26]
keywords_any: ["SQL", "인젝션", "injection", "PreparedStatement"]
commit: case-04
```

- [ ] **Step 5: 내용 확인(줄 번호가 실제와 맞는지)**

Run:
```bash
cd /Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online
sed -n '20p' review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntBalanceQueryService.java
sed -n '25p' review-samples/kr/co/koscom/pb/on/test/lab/online/review/TxLogQueryService.java
```
Expected: 첫 줄은 `        String acntNm = row.getAcntNm().trim();`, 둘째 줄은 `        String sql = "SELECT * FROM TB_TX_LOG WHERE ACNT_NO = '" + acntNo + "'";` — 골든 YAML의 `line_range`와 실제 줄이 어긋나면 이 Step에서 바로 잡는다.

- [ ] **Step 6: 커밋 4개 + 태그 4개**

```bash
cd /Users/koscom/workspace/fico/test-projects
git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntBalanceQueryService.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-01.yaml
git commit -m "Add f-review case-01: NPE from unguarded mapper result

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag case-01

git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/FileExportService.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-02.yaml
git commit -m "Add f-review case-02: resource leak from missing try-with-resources

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag case-02

git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/ExternalAuthClient.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-03.yaml
git commit -m "Add f-review case-03: hardcoded API key

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag case-03

git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/TxLogQueryService.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-04.yaml
git commit -m "Add f-review case-04: SQL injection via string concatenation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag case-04

git log --oneline -4
git tag -l | sort
```
Expected: `git tag -l`에 `baseline, case-01, case-02, case-03, case-04`가 전부 보인다.

---

### Task 4: fico KB 위배 케이스 4개 (case-05~08)

**Files:**
- Create: `.../review/AcntHeaderReadService.java`, `SettlementExtTxService.java`, `AcntExceptionBridgeService.java`, `AcntBalanceQryUpdateService.java`
- Create: `.../f-review-cases/case-05.yaml` ~ `case-08.yaml`

**Interfaces:**
- Consumes: Task 3의 `case-04` 태그(이 Task의 첫 케이스 커밋의 직전 조상).
- Produces: git 태그 `case-05`~`case-08`.

- [ ] **Step 1: case-05 — `@Async` 경로에서 commonHeader를 null 체크 없이 역참조**

`.../review/AcntHeaderReadService.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import kr.co.openlabs.fico.common.model.CommonRequest;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

/**
 * 계좌 상태를 비동기로 갱신하는 서비스.
 */
@Service
public class AcntHeaderReadService {

    @Async
    public void refreshAcntStatusAsync(CommonRequest<?> commonRequest) {
        String userId = commonRequest.getCommonHeader().getUserId();
        doRefresh(userId);
    }

    private void doRefresh(String userId) {
        // 상태 갱신 로직
    }
}
```
버그: `@Async`로 요청 스레드 밖에서 실행되는 메서드라 `ControllerAspect.onBeforeHandler`(요청 스레드에서만 동작하는 commonHeader null 검증)를 거치지 않는데, 15행이 null 체크 없이 `commonRequest.getCommonHeader()`를 역참조.

`.../f-review-cases/case-05.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntHeaderReadService.java
category: framework
min_severity: major
line_range: [13, 15]
keywords_any: ["commonHeader", "@Async", "ControllerAspect", "null"]
kb_ref: fico_framework/fico-fwk-extension/aspect/ControllerAspect.md
commit: case-05
```

- [ ] **Step 2: case-06 — `@ExtTransactional` 대신 Spring 코어 `@Transactional`을 bean-name 문자열로 직접 지정**

`.../review/SettlementExtTxService.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 정산 내역을 갱신하는 서비스.
 */
@Service
public class SettlementExtTxService {

    @Transactional("extTransactionManager")
    public void updateSettlement(String acntNo, long amount) {
        // 정산 갱신 로직
    }
}
```
버그: 12행이 fico의 `@ExtTransactional`(PBTransactionAspect가 svcId 규약에 맞게 처리) 대신 Spring 코어 `@Transactional`을 빈 이름 문자열로 직접 지정 — fico 트랜잭션 관례 우회.

`.../f-review-cases/case-06.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/SettlementExtTxService.java
category: framework
min_severity: major
line_range: [12, 12]
keywords_any: ["@ExtTransactional", "@Transactional", "extTransactionManager"]
kb_ref: fico_framework/fico-fwk-extension
commit: case-06
```

- [ ] **Step 3: case-07 — `CommonException`/`PBOnlineException` 계층 혼용**

`.../review/AcntExceptionBridgeService.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException;
import kr.co.openlabs.fico.framework.exception.CommonException;
import org.springframework.stereotype.Service;

/**
 * 계좌 예외를 다른 예외 타입으로 변환해 재던지는 서비스.
 */
@Service
public class AcntExceptionBridgeService {

    public void verifyAcnt(String acntNo) {
        try {
            doVerify(acntNo);
        } catch (CommonException e) {
            throw PBOnlineException.create("9999", e);
        }
    }

    private void doVerify(String acntNo) {
        if (acntNo == null || acntNo.isEmpty()) {
            throw new CommonException("계좌번호가 비어 있습니다");
        }
    }
}
```
버그: 17행이 프레임워크 공통 예외(`CommonException`)를 온라인 고정길이 전문 전용 예외(`PBOnlineException`)로 바꿔 던짐 — 두 계층은 서로 다른 목적(공통 프레임워크 vs 온라인 전문 처리)이라 섞으면 안 된다.

`.../f-review-cases/case-07.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntExceptionBridgeService.java
category: framework
min_severity: major
line_range: [16, 18]
keywords_any: ["CommonException", "PBOnlineException", "계층", "exception"]
kb_ref: fico_framework/framework-site-ext
commit: case-07
```

- [ ] **Step 4: case-08 — svcId 5번째 글자 Q(조회)인데 UPDATE 매퍼 호출**

`.../review/AcntBalanceQryUpdateService.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import kr.co.koscom.pb.on.test.lab.online.mapper.TestLabMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/**
 * 서비스아이디 : TLABQ002Service (조회 서비스)
 */
@Service
@RequiredArgsConstructor
public class AcntBalanceQryUpdateService {

    private final TestLabMapper testLabMapper;

    public void syncBalanceOnQuery(String acntNo, long newBalance) {
        testLabMapper.updateBalance(acntNo, newBalance);
    }
}
```
버그: Javadoc의 서비스아이디 `TLABQ002Service`는 5번째 글자가 `Q`(조회)인데, 17행에서 쓰기 매퍼(`updateBalance`)를 호출 — fico의 `PBTransactionAspect`는 조회 서비스(5번째 글자 Q/R)를 정상 종료에도 rollback하므로 이 UPDATE는 반영되지 않는다.

`.../f-review-cases/case-08.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntBalanceQryUpdateService.java
category: framework
min_severity: major
line_range: [17, 17]
keywords_any: ["TLABQ002Service", "조회", "updateBalance", "rollback", "svcId"]
kb_ref: fico_framework/fico-fwk-extension
commit: case-08
```

- [ ] **Step 5: 내용 확인**

Run:
```bash
cd /Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online
sed -n '15p' review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntHeaderReadService.java
sed -n '12p' review-samples/kr/co/koscom/pb/on/test/lab/online/review/SettlementExtTxService.java
sed -n '17p' review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntExceptionBridgeService.java
sed -n '17p' review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntBalanceQryUpdateService.java
```
Expected: 각각 `        String userId = commonRequest.getCommonHeader().getUserId();` / `    @Transactional("extTransactionManager")` / `            throw PBOnlineException.create("9999", e);` / `        testLabMapper.updateBalance(acntNo, newBalance);`.

- [ ] **Step 6: 커밋 4개 + 태그 4개**

```bash
cd /Users/koscom/workspace/fico/test-projects
git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntHeaderReadService.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-05.yaml
git commit -m "Add f-review case-05: commonHeader dereferenced without null-check off the request thread

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag case-05

git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/SettlementExtTxService.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-06.yaml
git commit -m "Add f-review case-06: Spring core @Transactional used instead of fico's @ExtTransactional

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag case-06

git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntExceptionBridgeService.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-07.yaml
git commit -m "Add f-review case-07: CommonException rethrown as PBOnlineException

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag case-07

git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntBalanceQryUpdateService.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-08.yaml
git commit -m "Add f-review case-08: write mapper called from a query-svcId service

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag case-08

git log --oneline -4
```

---

### Task 5: 롬복 작성 규약 위반 케이스 2개 (case-09~10)

**Files:**
- Create: `.../review/AcntSummaryVo.java`, `AcntDetailVo.java`
- Create: `.../f-review-cases/case-09.yaml`, `case-10.yaml`

**Interfaces:**
- Consumes: Task 4의 `case-08` 태그.
- Produces: git 태그 `case-09`, `case-10`.

- [ ] **Step 1: case-09 — `@NoArgsConstructor`를 생성자 위에 배치**

`.../review/AcntSummaryVo.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import lombok.NoArgsConstructor;

/**
 * 계좌 요약 정보 VO.
 */
public class AcntSummaryVo {

    private String acntNo;
    private String acntNm;

    @NoArgsConstructor
    public AcntSummaryVo(String acntNo, String acntNm) {
        this.acntNo = acntNo;
        this.acntNm = acntNm;
    }

    public String getAcntNo() {
        return acntNo;
    }

    public String getAcntNm() {
        return acntNm;
    }
}
```
버그: 13행 — `@NoArgsConstructor`는 클래스 레벨 전용(`@Target(TYPE)`) 애노테이션인데 생성자 위에 배치됨. 실제 컴파일 시 에러.

`.../f-review-cases/case-09.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntSummaryVo.java
category: correctness
min_severity: major
line_range: [13, 14]
keywords_any: ["@NoArgsConstructor", "생성자", "class", "compile", "컴파일"]
commit: case-09
```

- [ ] **Step 2: case-10 — 롬복 VO에서 getter/setter 수기 작성(중복)**

`.../review/AcntDetailVo.java`:
```java
package kr.co.koscom.pb.on.test.lab.online.review;

import lombok.Data;

/**
 * 계좌 상세 정보 VO.
 */
@Data
public class AcntDetailVo {

    private String acntNo;
    private String acntNm;
    private long balance;

    public String getAcntNo() {
        return acntNo;
    }

    public void setAcntNo(String acntNo) {
        this.acntNo = acntNo;
    }
}
```
버그: 8행 `@Data`가 이미 모든 getter/setter를 생성하는데, 15~21행이 `acntNo`의 getter/setter를 손으로 중복 작성 — 롬복과 중복·불일치 위험.

`.../f-review-cases/case-10.yaml`:
```yaml
file: review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntDetailVo.java
category: maintainability
min_severity: minor
line_range: [15, 21]
keywords_any: ["@Data", "getAcntNo", "중복", "Lombok", "redundant"]
commit: case-10
```

- [ ] **Step 3: 내용 확인**

Run:
```bash
cd /Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online
sed -n '13p' review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntSummaryVo.java
sed -n '15,17p' review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntDetailVo.java
```
Expected: 첫 줄 `    @NoArgsConstructor`, 둘째는 `    public String getAcntNo() {` 로 시작하는 3줄.

- [ ] **Step 4: 커밋 2개 + 태그 2개**

```bash
cd /Users/koscom/workspace/fico/test-projects
git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntSummaryVo.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-09.yaml
git commit -m "Add f-review case-09: @NoArgsConstructor placed on a constructor instead of the class

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag case-09

git add on-test-lab/on-test-lab-online/review-samples/kr/co/koscom/pb/on/test/lab/online/review/AcntDetailVo.java \
        on-test-lab/on-test-lab-online/f-review-cases/case-10.yaml
git commit -m "Add f-review case-10: hand-written getter/setter duplicating @Data

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git tag case-10

git log --oneline -2
git tag -l | sort
```
Expected: `git tag -l`에 `baseline, case-01..case-10` 12개 전부.

---

### Task 6: 채점기 `scripts/freview-eval.ts`

**Files:**
- Create: `gordian-coder/scripts/freview-eval.ts`
- Create: `gordian-coder/scripts/__tests__/freview-eval.test.ts`
- Create: `gordian-coder/scripts/run-freview-eval.sh`

**Interfaces:**
- Consumes: Task 1~5가 만든 `f-review-cases/*.yaml`과 git 태그(아직 push 전이라도 로컬 태그로 diff 모드를 테스트할 수 있다).
- Produces: `matchesCaseSelector(id, selector?): boolean`, `parseFileFindings(md, file): FindingRow[]`, `scoreBugCase(c, rows): boolean`, `scoreControlCase(rows): boolean` — Task 7이 CLI로만 쓴다.

- [ ] **Step 1: 실패하는 단위 테스트 작성**

`gordian-coder/scripts/__tests__/freview-eval.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { matchesCaseSelector, parseFileFindings, scoreBugCase, scoreControlCase } from "../freview-eval";

describe("matchesCaseSelector", () => {
  test("no selector matches everything", () => {
    expect(matchesCaseSelector("case-01", undefined)).toBe(true);
  });
  test("exact id must match exactly", () => {
    expect(matchesCaseSelector("case-01", "case-01")).toBe(true);
    expect(matchesCaseSelector("case-02", "case-01")).toBe(false);
  });
  test("glob and comma list", () => {
    expect(matchesCaseSelector("case-05", "case-0*,control-*")).toBe(true);
    expect(matchesCaseSelector("control-02", "case-0*,control-*")).toBe(true);
    expect(matchesCaseSelector("case-10", "case-0*,control-*")).toBe(false);
  });
});

const SAMPLE_REPORT = `# f-review report

## src/main/java/review/AcntBalanceQueryService.java

| severity | category | line | rule | message | suggestion | source |
|---|---|---|---|---|---|---|
| major | correctness | 19 | npe-deref | row가 null일 수 있는데 체크 없이 getAcntNm 호출 | null 체크 추가 | AI |

## src/main/java/review/AcntCleanQueryService.java

(findings 없음 — clean)
`;

describe("parseFileFindings", () => {
  test("extracts the finding rows for the exact file section", () => {
    const rows = parseFileFindings(SAMPLE_REPORT, "src/main/java/review/AcntBalanceQueryService.java");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "major", category: "correctness", line: 19 });
    expect(rows[0].message).toContain("null일 수 있는데");
  });
  test("a section with no table returns empty (clean)", () => {
    expect(parseFileFindings(SAMPLE_REPORT, "src/main/java/review/AcntCleanQueryService.java")).toEqual([]);
  });
  test("a file with no section at all also returns empty", () => {
    expect(parseFileFindings(SAMPLE_REPORT, "no/such/file.java")).toEqual([]);
  });
});

describe("scoreBugCase", () => {
  const c = {
    id: "case-01", kind: "bug" as const,
    file: "src/main/java/review/AcntBalanceQueryService.java",
    category: "correctness", min_severity: "major",
    line_range: [18, 19] as [number, number],
    keywords_any: ["null", "역참조"], commit: "case-01",
  };
  test("passes when category/severity/line/keyword all line up", () => {
    const rows = parseFileFindings(SAMPLE_REPORT, c.file);
    expect(scoreBugCase(c, rows)).toBe(true);
  });
  test("fails when the line is outside tolerance", () => {
    const rows = [{ severity: "major", category: "correctness", line: 99, rule: "x", message: "null 체크", suggestion: "" }];
    expect(scoreBugCase(c, rows)).toBe(false);
  });
  test("fails when severity is weaker than min_severity", () => {
    const rows = [{ severity: "nit", category: "correctness", line: 19, rule: "x", message: "null 체크", suggestion: "" }];
    expect(scoreBugCase(c, rows)).toBe(false);
  });
});

describe("scoreControlCase", () => {
  test("passes with no findings", () => {
    expect(scoreControlCase([])).toBe(true);
  });
  test("passes when only nit-level findings exist", () => {
    expect(scoreControlCase([{ severity: "nit", category: "maintainability", line: 1, rule: "x", message: "", suggestion: "" }])).toBe(true);
  });
  test("fails on a minor-or-worse finding (false positive)", () => {
    expect(scoreControlCase([{ severity: "minor", category: "correctness", line: 1, rule: "x", message: "", suggestion: "" }])).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/koscom/workspace/gordian-coder && bun test scripts/__tests__/freview-eval.test.ts`
Expected: FAIL — `../freview-eval` 모듈이 없어서 import 에러.

- [ ] **Step 3: 채점기 구현**

`gordian-coder/scripts/freview-eval.ts`:
```typescript
#!/usr/bin/env bun
/**
 * f-review 평가 러너 + 채점기 (f-log의 flog-eval.ts와 자매).
 *
 *   bun scripts/freview-eval.ts <target-dir> --mode whole|diff [--model <id>] [--case <id>[,<id-or-glob>...]] [--no-run]
 *
 * <target-dir>/f-review-cases/*.yaml을 읽어 각 케이스를 f-review로 리뷰하고,
 * 마크다운 리포트의 `## <파일>` 섹션 아래 finding 표를 파싱해 정답과 대조한다.
 * 버그 케이스 미검출 또는 대조군 오탐이 하나라도 있으면 exit 1.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SEVERITY_RANK: Record<string, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
const LINE_TOLERANCE = 3;

export interface BugCase {
  id: string;
  kind: "bug";
  file: string;
  category: string;
  min_severity: string;
  line_range: [number, number];
  keywords_any: string[];
  kb_ref?: string;
  commit: string;
}
export interface ControlCase {
  id: string;
  kind: "control";
  file: string;
  expect_clean: true;
  commit: string;
}
export type EvalCase = BugCase | ControlCase;

export interface FindingRow {
  severity: string;
  category: string;
  line: number | null;
  rule: string;
  message: string;
  suggestion: string;
}

// selector: 콤마로 구분한 케이스 ID 목록, 각 항목은 정확한 ID이거나 `*` 와일드카드를 쓸 수 있다.
export function matchesCaseSelector(id: string, selector?: string): boolean {
  if (!selector || !selector.trim()) return true;
  return selector.split(",").map((p) => p.trim()).filter(Boolean).some((pattern) => {
    if (!pattern.includes("*")) return id === pattern;
    const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(id);
  });
}

async function loadCases(target: string, selector?: string): Promise<EvalCase[]> {
  const dir = join(target, "f-review-cases");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const cases: EvalCase[] = [];
  for (const f of files) {
    const id = f.replace(/\.yaml$/, "");
    if (!matchesCaseSelector(id, selector)) continue;
    const y = Bun.YAML.parse(await Bun.file(join(dir, f)).text()) as Record<string, unknown>;
    if (y.expect_clean) {
      cases.push({ id, kind: "control", file: y.file as string, expect_clean: true, commit: y.commit as string });
    } else {
      cases.push({
        id, kind: "bug",
        file: y.file as string,
        category: y.category as string,
        min_severity: y.min_severity as string,
        line_range: y.line_range as [number, number],
        keywords_any: (y.keywords_any ?? []) as string[],
        kb_ref: y.kb_ref as string | undefined,
        commit: y.commit as string,
      });
    }
  }
  return cases;
}

/** 리포트 마크다운에서 `## <file>` 섹션의 finding 표를 파싱한다. 섹션이 없으면 빈 배열(클린). */
export function parseFileFindings(md: string, file: string): FindingRow[] {
  const sections = md.split(/^## /m).slice(1);
  const section = sections.find((s) => s.split("\n")[0].trim() === file);
  if (!section) return [];
  const rows: FindingRow[] = [];
  for (const line of section.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || /^\|[-\s|]+\|$/.test(t)) continue; // 구분선 제외
    const cells = t.split("|").map((c) => c.trim());
    const body = cells.slice(1, -1); // 앞뒤 빈 셀(leading/trailing `|`) 제거
    if (body.length < 5 || !(body[0] in SEVERITY_RANK)) continue; // 헤더/본문 아닌 행 제외
    const lineNum = Number(body[2]);
    rows.push({
      severity: body[0], category: body[1],
      line: Number.isFinite(lineNum) ? lineNum : null,
      rule: body[3], message: body[4], suggestion: body[5] ?? "",
    });
  }
  return rows;
}

export function scoreBugCase(c: BugCase, rows: FindingRow[]): boolean {
  return rows.some((r) =>
    r.category === c.category &&
    SEVERITY_RANK[r.severity] <= SEVERITY_RANK[c.min_severity] &&
    r.line !== null &&
    r.line >= c.line_range[0] - LINE_TOLERANCE && r.line <= c.line_range[1] + LINE_TOLERANCE &&
    c.keywords_any.some((k) => (r.message + " " + r.suggestion).toLowerCase().includes(k.toLowerCase()))
  );
}

export function scoreControlCase(rows: FindingRow[]): boolean {
  return !rows.some((r) => SEVERITY_RANK[r.severity] <= SEVERITY_RANK.minor);
}

function runFReview(target: string, c: EvalCase, mode: "whole" | "diff", report: string, model?: string): void {
  rmSync(join(target, report), { force: true });
  mkdirSync(join(target, ".fico/report/f-review"), { recursive: true });
  const reviewArgs = mode === "whole" ? `--files=${c.file} --whole` : c.commit;
  const cmd = ["opencode", "run", "--command", "f-review", ...(model ? ["-m", model] : []), "--", `${reviewArgs} --output=${report}`];
  console.log(`\n$ ${cmd.join(" ")}`);
  // opencode는 inherited PWD로 프로젝트 루트를 잡는다(getcwd가 아님) — f-log 평가기에서 확인된 동작.
  const r = Bun.spawnSync(cmd, { cwd: target, env: { ...process.env, PWD: target }, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) console.error(`opencode exited ${r.exitCode} for ${c.id}`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const target = args.find((a, i) => !a.startsWith("--") && !["--model", "--case", "--mode"].includes(args[i - 1] ?? ""));
  if (!target) {
    console.error("usage: bun scripts/freview-eval.ts <target-dir> --mode whole|diff [--model <id>] [--case <id>[,<id-or-glob>...]] [--no-run]");
    process.exit(2);
  }
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const mode = flag("--mode");
  if (mode !== "whole" && mode !== "diff") { console.error("--mode whole|diff is required"); process.exit(2); }
  const model = flag("--model");
  const only = flag("--case");
  const noRun = args.includes("--no-run");

  const cases = await loadCases(target, only);
  if (!cases.length) { console.error(`no cases in ${join(target, "f-review-cases")}`); process.exit(2); }

  const rows: string[] = [];
  let failed = 0;
  for (const c of cases) {
    const report = `.fico/report/f-review/${c.id}-${mode}.md`;
    if (!noRun) runFReview(target, c, mode, report, model);
    const full = join(target, report);
    if (!existsSync(full)) { rows.push(`| ${c.id} | – | 리포트 없음 |`); failed++; continue; }
    const md = await Bun.file(full).text();
    const findings = parseFileFindings(md, c.file);
    const pass = c.kind === "bug" ? scoreBugCase(c, findings) : scoreControlCase(findings);
    if (!pass) failed++;
    rows.push(`| ${c.id} | ${pass ? "PASS" : "FAIL"} | ${report} |`);
  }
  console.log(`\n| case | result | report |`);
  console.log(`|---|---|---|`);
  for (const row of rows) console.log(row);
  const bugCases = cases.filter((c) => c.kind === "bug").length;
  console.log(`\n${cases.length - failed}/${cases.length} cases PASS (bug: ${bugCases}, control: ${cases.length - bugCases})`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test scripts/__tests__/freview-eval.test.ts`
Expected: 전부 PASS.

- [ ] **Step 5: 편의 래퍼 스크립트**

`gordian-coder/scripts/run-freview-eval.sh`:
```sh
#!/usr/bin/env sh
# f-review 평가: 플러그인 빌드 → 대상 프로젝트 f-review-cases/*.yaml마다 OpenCode로 f-review 실행 → 채점.
#   ./scripts/run-freview-eval.sh --mode whole                      # 기본 대상·모델, whole 모드 전체
#   ./scripts/run-freview-eval.sh --mode diff --case case-05        # 한 케이스만, diff 모드
#   ./scripts/run-freview-eval.sh --mode whole --no-run             # 재실행 없이 기존 리포트만 채점
#   FREVIEW_TARGET=/path FREVIEW_MODEL=openrouter/qwen/qwen3.8-27b ./scripts/run-freview-eval.sh --mode whole
set -eu
TARGET="${FREVIEW_TARGET:-/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online}"
MODEL="${FREVIEW_MODEL:-openrouter/qwen/qwen3.8-27b}"
cd "$(dirname "$0")/.."
bun run build >/dev/null
exec bun scripts/freview-eval.ts "$TARGET" --model "$MODEL" "$@"
```

Run: `chmod +x scripts/run-freview-eval.sh`

- [ ] **Step 6: 전체 테스트·typecheck·build 확인**

Run:
```bash
bun test
bun run typecheck
bun run build
```
Expected: 전부 통과/에러 없음.

- [ ] **Step 7: 커밋**

```bash
cd /Users/koscom/workspace/gordian-coder
git add scripts/freview-eval.ts scripts/__tests__/freview-eval.test.ts scripts/run-freview-eval.sh
git commit -m "Add the f-review eval runner and scorer

Parses the review report's per-file finding table (severity/category/
line/rule/message) directly, rather than scraping prose like the f-log
scorer does — f-review's markdown output is already tabular.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: push + 실환경 1회 검증

**Files:** 없음(실행·커밋만).

**Interfaces:**
- Consumes: Task 1~6의 모든 결과물.
- Produces: `origin`에 push된 `main` + 태그 12개, 그리고 최초 실행 결과 기록.

- [ ] **Step 1: push 권한 확인**

Run: `cd /Users/koscom/workspace/fico/test-projects && git push origin main --dry-run`
Expected: 인증 에러가 없어야 한다. 에러가 나면(예: 403/권한 없음) **멈추고 사용자에게 보고한다** — 과거 다른 fico 저장소에서 계정 전환(`gh auth switch`)이 필요했던 전례가 있다(스펙 §8).

- [ ] **Step 2: push**

```bash
git push origin main
git push origin --tags
```
Expected: `main`과 태그 12개(`baseline, case-01..case-10`)가 원격에 보인다. `git ls-remote --tags origin`으로 확인.

- [ ] **Step 3: whole 모드 전체 1회 실행**

Run: `cd /Users/koscom/workspace/gordian-coder && ./scripts/run-freview-eval.sh --mode whole`
Expected: 12개 케이스 모두 리포트 생성. 표 출력에서 몇 개가 PASS/FAIL인지 기록 — 전부 PASS가 아니어도 된다(이게 검출률 측정의 목적이다), 다만 **리포트 자체가 하나도 안 생기는 케이스**가 있으면 그건 파이프라인 결함이므로 원인을 확인한다.

- [ ] **Step 4: diff 모드 최소 3케이스(축별 1개) 실행**

Run: `cd /Users/koscom/workspace/gordian-coder && ./scripts/run-freview-eval.sh --mode diff --case 'case-01,case-05,case-09'`
Expected: 세 리포트 모두 생성. `case-01`(Java/웹), `case-05`(KB), `case-09`(롬복) 각 축에서 diff 모드가 whole 모드와 다른 리포트를 내는지(파일 전체가 아니라 그 커밋의 diff만 보는지) 리포트 내용으로 확인한다.

- [ ] **Step 5: 결과를 메모리/보고로 기록**

이 Step은 코드 변경이 아니다 — 실행한 사람(에이전트)이 whole/diff 각각의 검출률·오탐 여부를 한 문단으로 정리해 사용자에게 보고한다. f-log 테스트베드의 Task 6과 동일한 역할(최초 실환경 1회 실행과 결과 기록).

---

## Self-review

- **스펙 §4 파일 구조**: `src/main/java/.../review/` → `review-samples/...`로 바꿈(Global Constraints에 이유 명시). 나머지(정답 YAML 스키마, 채점기 설계, 커밋+태그 전략)는 스펙 그대로.
- **스펙 §2 "베이스라인 커밋 1개"**: 2개로 쪼갬(Global Constraints에 이유 명시) — diff 모드가 대조군을 평가할 수 있으려면 필수적인 분리다.
- **스펙 §5 10케이스**: A축 4개(case-01~04), B축 4개(case-05~08), C축 2개(case-09~10) — 전부 Task 3~5에 매핑됨. 대조군 2개는 Task 2.
- **스펙 §6 정답 형식**: `commit` 필드가 SHA가 아니라 git 태그임을 재확인(스펙 수정분과 일치).
- **스펙 §7 채점기**: 마크다운 표 파싱으로 구현(스펙이 예고한 그대로, f-log의 프로즈-스크래핑과 다름).
- **스펙 §8 리스크**: push 권한 확인을 Task 7 Step 1로, 카테고리 추정 보정을 Task 7 Step 3(실행 결과로 드러남)으로, `review-samples/`가 f-log 자산과 공존하는 문제는 Global Constraints에서 아예 다른 sourceSet으로 분리해 원천 차단.
- **플레이스홀더 스캔**: "TBD"/"추후 보완" 없음. 모든 Step에 실제 코드·명령·예상 출력이 있음.
- **타입/이름 일관성**: `freview-eval.ts`의 `matchesCaseSelector/parseFileFindings/scoreBugCase/scoreControlCase`가 Task 6의 테스트 파일과 구현 파일에서 동일한 이름·시그니처로 쓰임.
