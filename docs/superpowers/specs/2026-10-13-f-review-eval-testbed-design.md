# f-review 평가 테스트베드 설계

날짜: 2026-10-13
상태: 승인됨(채팅), 구현 전
관련: `2026-09-17-f-log-eval-testbed-design.md`(f-log 평가 테스트베드, 자매 설계), 메모리 `freview-live-test-loop`

## 1. 목적

f-review(코드 리뷰 기능)가 실제 fico 프로젝트에 심어둔 잠재 버그를 얼마나 정확히 찾아내는지 — 특히 (a) 웹/Java 일반 빈출 버그와 (b) `.fico/kb/fico_framework` 하위 문서가 규정한 fico 프레임워크 사용 규약 위반을 — 반복 검증할 수 있는 장치를 만든다. f-log 테스트베드와 자매 구조이며, 동일한 "정답 YAML + 자동 채점" 패턴을 따른다.

대상 프로젝트: `/Users/koscom/workspace/fico/test-projects` (git 저장소 루트, 원격 `origin` = 내부 GitLab `fico-ai/test-projects.git`, 브랜치 `main`). 리뷰 대상 코드는 그 하위 `on-test-lab/on-test-lab-online`에 둔다.

성공 기준: 채점 스크립트 한 번으로 — whole 모드와 diff 모드 각각에 대해 — f-review 리포트가 정답과 자동 대조되어 케이스별 PASS/FAIL 표와 전체 검출률/오탐률이 나온다.

## 2. 결정 사항(채팅 합의)

| 항목 | 결정 |
|---|---|
| 검증 모드 | **둘 다** — `--files --whole`(파일 전체 리뷰)과 커밋 range(diff 리뷰)를 동일한 정답 YAML로 평가 |
| 규모 | 1차 10케이스(3축) + 대조군(버그 없음) 2개 |
| 버전 관리 | `test-projects`에 커밋을 쌓고 **origin까지 push** (내부 공유 저장소 — 첫 push 때 인증 확인 필요) |
| 베이스라인 범위 | f-log 100케이스 자산(테스트·골든 YAML) + review 패키지 뼈대 + 대조군 2개를 베이스라인 커밋 1개에 포함 |
| 채점 근거 | f-review 마크다운 리포트의 `## <파일>` 섹션 + finding 표(`severity\|category\|line\|rule\|message\|suggestion\|source`)를 직접 파싱 — f-log처럼 프로즈 문장을 긁지 않는다 |
| 채점기 위치 | gordian-coder `scripts/freview-eval.ts` (f-log의 `flog-eval.ts`와 나란히) |

## 3. 왜 이 구조인가 — 조사 근거

- f-review는 `category`(`correctness`/`security`/`performance`/`maintainability`/`tests`/`framework` 6종 고정, `src/core/review/contract.ts` `REQUIRED_CATEGORIES`)와 `severity`(`blocker`/`major`/`minor`/`nit`, 내림차순)를 모든 finding에 반드시 붙인다. 정답 YAML이 이 두 축을 그대로 쓰면 채점이 결정적이다.
- `framework` 카테고리는 **항상 강제 평가**되고(`REQUIRED_CATEGORIES`의 코멘트 "always enforced"), `.fico/config/fico_ai.json`의 `frameworkKb`(import prefix → KB 디렉터리 맵)로 `.fico/kb/fico_framework/*.md`가 리뷰어 컨텍스트에 주입된다 — KB 위배 케이스가 f-review의 1급 검출 대상이라는 뜻이다.
- 리포트(`src/core/review/report/output.ts` `renderReport`)는 파일마다 `## <파일>` 마크다운 헤더 아래 **표**를 낸다. 표 컬럼은 `severity | category | line | rule | message | suggestion | source`. 이미 `parseReportKeys(md)`라는 역파싱 함수가 존재할 만큼 이 표는 기계 판독을 염두에 둔 형식이다.
- 커밋 range 해석(`src/core/review/pipeline/context.ts` `resolveDiffRange`): 단일 bare ref(`..`가 없는 커밋)를 주면 자동으로 `<ref>~1..<ref>`로 변환된다. 즉 **케이스당 커밋 1개**면 diff 모드는 그 커밋 SHA 하나만 넘기면 된다 — 별도의 range 계산이 필요 없다.
- `test-projects/.gitignore`에 `build/ bin/ logs/ .fico/`가 이미 걸려 있어, f-log의 로그 산출물과 f-review의 런 산출물(`.fico/.../runs/`)이 자동으로 커밋에서 빠진다 — 소스·정답 YAML·설정만 깔끔하게 추적된다.

## 4. 구조

```
test-projects/                                     ← git 루트. origin: fico-ai/test-projects.git, branch main
  on-test-lab/on-test-lab-online/
    src/main/java/kr/co/koscom/pb/on/test/lab/online/
      review/                                       ← 이 테스트베드 전용 패키지(신설)
        AcntBalanceQueryService.java                ← case-01: null 체크 없는 매퍼 단건 조회 역참조 (NPE)
        FileExportService.java                      ← case-02: try-with-resources 누락 (자원 누수)
        ExternalAuthClient.java                      ← case-03: API 키 하드코딩
        TxLogQueryService.java                       ← case-04: 문자열 연결 JDBC 쿼리 (SQL 인젝션)
        AcntHeaderReadService.java                    ← case-05: commonHeader null 체크 없이 getXxx() (KB: ControllerAspect.md)
        SettlementExtTxService.java                   ← case-06: @ExtTransactional, extTransactionManager 빈 미등록 (KB)
        AcntExceptionBridgeService.java               ← case-07: CommonException/PBOnlineException 혼용 (KB)
        AcntBalanceQryUpdateService.java              ← case-08: svcId 5번째 글자 Q인데 UPDATE 매퍼 호출 (KB: fico 트랜잭션)
        AcntSummaryVo.java                            ← case-09: @NoArgsConstructor를 생성자 위에 배치 (롬복 규약)
        AcntDetailVo.java                             ← case-10: 롬복 VO에서 getter/setter 수기 작성 (롬복 규약)
        AcntCleanQueryService.java                    ← 대조군: 버그 없음
        AcntCleanVo.java                               ← 대조군: 버그 없음
  f-review-cases/
    case-01.yaml … case-10.yaml
    control-01.yaml, control-02.yaml                 ← findings: [] (오탐 없어야 함)

gordian-coder/scripts/freview-eval.ts                ← 러너 + 채점기 (f-log의 flog-eval.ts와 자매)
```

**커밋 계획**: 베이스라인 커밋 1개(f-log 100케이스 자산 + `review/` 패키지 뼈대 + 대조군 2개 + `f-review-cases/control-*.yaml`) → 케이스별 커밋 10개(각각 해당 클래스 1개에 버그 1개 추가) → 전부 `main`에 쌓고 `origin`에 push.

## 5. 10케이스 설계 (3축)

### A. Java/웹 빈출 (4개)
- **case-01**: 매퍼의 단건 조회(`selectOne` 성격)가 null을 돌려줄 수 있는데, 서비스가 null 체크 없이 바로 `.getXxx()`를 호출 → NPE. 카테고리 `correctness`.
- **case-02**: `InputStream`/`FileInputStream`을 try-with-resources 없이 열고, 정상 경로에서만 닫고 예외 경로에서 닫지 않음 → 자원 누수. 카테고리 `maintainability` 또는 `correctness`(구현 시 실제 f-review 분류 확인 필요).
- **case-03**: 외부 API 호출 클라이언트에 API 키를 `private static final String API_KEY = "sk-..."` 식으로 하드코딩. 카테고리 `security`.
- **case-04**: `"SELECT * FROM TB_LOG WHERE ACNT_NO = '" + acntNo + "'"` 식으로 사용자 입력을 문자열 연결해 JDBC로 직접 실행. 카테고리 `security`.

### B. fico KB 위배 (4개) — 전부 카테고리 `framework`
- **case-05**: 컨트롤러/서비스가 `commonRequest.getCommonHeader()`를 null 체크 없이 바로 `.getUserId()` 등으로 역참조. KB 근거: `fico_framework/fico-fwk-extension/aspect/ControllerAspect.md`(ControllerAspect가 commonHeader null을 검증하는 지점을 우회하는 호출부가 있으면 안 된다는 관례).
- **case-06**: 서비스 메서드에 `@ExtTransactional`을 붙였지만, 스프링 컨텍스트에 `"extTransactionManager"`라는 이름의 `PlatformTransactionManager` 빈이 등록돼 있지 않음(기본 `transactionManager`만 있음) → 런타임에 `NoSuchBeanDefinitionException`을 유발하는 구조. KB 근거: `fico_framework/fico-fwk-extension` 하위 `@ExtTransactional` 문서.
- **case-07**: catch 블록에서 `CommonException`을 잡은 뒤 `PBOnlineException`으로 바꿔 던지거나, 반대로 섞어 쓰는 패턴 — 두 예외 계층이 다른 목적(프레임워크 공통 vs 온라인 고정길이 전문)임을 무시. KB 근거: `fico_framework/framework-site-ext`(PBOnlineException) 문서.
- **case-08**: svcId 규약상 5번째 글자가 `Q`(조회)인 서비스인데, 그 서비스 메서드 안에서 UPDATE/INSERT 매퍼를 호출 — `PBTransactionAspect`가 조회 서비스는 트랜잭션을 rollback하므로 쓰기가 사라지는 fico 특유의 결함. KB 근거: fico 트랜잭션 관례 문서(`fico_transaction.md`가 가리키는 `PBTransactionAspect` 동작과 동일 근거).

### C. 롬복 작성 규약 위반 (2개) — `java_fix_conventions.md`가 검출 대상이 아니라 "이미 있는 결함"을 검증
- **case-09**: `@NoArgsConstructor`를 클래스 선언이 아니라 기존 생성자 위에 붙임(컴파일 에러급 오배치). 카테고리 `correctness`.
- **case-10**: 롬복을 이미 쓰는(`@Getter`/`@Setter` 또는 `@Data`가 있어야 할) VO에서 getter/setter를 손으로 작성해 롬복과 중복·불일치. 카테고리 `maintainability`.

### 대조군 (2개, 번호 없음 — 오탐 측정용)
- **control-01**: case-01과 같은 모양의 조회 서비스지만 null 체크가 올바르게 있음.
- **control-02**: case-09/10과 같은 모양의 VO지만 롬복 사용이 정확함.

각 케이스의 정확한 클래스 내용·버그 위치(줄 번호)·메시지 문구는 구현 계획(writing-plans) 단계에서 코드와 함께 확정한다 — 이 스펙은 "무엇을 검증하는가"까지만 고정한다.

## 6. 정답 파일 형식

```yaml
# f-review-cases/case-05.yaml
file: src/main/java/kr/co/koscom/pb/on/test/lab/online/review/AcntHeaderReadService.java
category: framework              # f-review의 6종 카테고리 중 하나, 정확히 일치해야 PASS
min_severity: major               # blocker > major > minor > nit — 이 등급 이상이면 PASS
line_range: [18, 24]              # 버그가 있는 실제 줄 범위. 채점 시 ±TOLERANCE(기본 3줄) 허용
keywords_any: ["commonHeader", "null", "ControllerAspect"]   # finding의 message 열에 하나 이상 포함
kb_ref: fico_framework/fico-fwk-extension/aspect/ControllerAspect.md   # 선택. KB축 케이스만
commit: case-05                   # git 태그 이름(아래 참고) — diff 모드에서 "case-05~1..case-05"로 환산(resolveDiffRange가 자동 처리)
```

**`commit` 필드는 SHA가 아니라 git 태그 이름이다.** 구현 시 각 케이스 커밋에 동일한 이름의 태그(`git tag case-05`)를 붙인다 — 정답 YAML을 커밋 전에 먼저 쓸 수 있고(SHA는 커밋해야 생기므로), 나중에 히스토리를 리베이스해도 태그만 다시 붙이면 YAML을 고칠 필요가 없다. `case-05~1`처럼 태그에 `~1`을 붙이는 것도 git이 그대로 지원한다.

대조군 파일:
```yaml
# f-review-cases/control-01.yaml
file: src/main/java/kr/co/koscom/pb/on/test/lab/online/review/AcntCleanQueryService.java
expect_clean: true                # 이 파일에 대해 severity가 minor 이상인 finding이 하나도 없어야 PASS
commit: baseline
```

## 7. 러너·채점기 `scripts/freview-eval.ts`

```
bun scripts/freview-eval.ts <target-dir> --mode whole|diff [--model <id>] [--case <id>[,<id-or-glob>...]] [--no-run]
```

1. `<target-dir>/f-review-cases/*.yaml`을 읽는다(`--case`로 선택, f-log 채점기와 동일한 콤마+글롭 문법 재사용).
2. `--no-run`이 아니면 케이스마다 모드에 따라 실행:
   - `whole`: `opencode run --command f-review -- --files=<file> --whole --output=<report>`
   - `diff`: `opencode run --command f-review -- <commit> --output=<report>` (bare ref → f-review가 자체적으로 `<commit>~1..<commit>`으로 해석)
3. 리포트에서 `## <정답의 file>` 섹션을 찾고, 그 안의 표 행들을 파싱한다(`| severity | category | line | rule | message | ... |`).
4. 판정:
   - 버그 케이스: 표 안에 `category` 일치 AND `severity`가 `min_severity` 이상 AND `line`이 `line_range`(±허용폭) 안 AND `message`가 `keywords_any` 중 하나 포함 — 하는 행이 하나라도 있으면 PASS.
   - 대조군(`expect_clean: true`): 그 파일 섹션 자체가 없거나, 있어도 `severity`가 `minor`/`nit`를 넘는 행이 없으면 PASS(오탐 없음).
5. 케이스 × PASS/FAIL 표 출력 + 두 지표: **검출률**(버그 케이스 중 PASS 비율) **오탐률**(대조군 중 FAIL, 즉 가짜 finding이 뜬 비율). 버그 케이스가 하나라도 FAIL이거나 대조군이 하나라도 오탐이면 exit 1.

의존성 추가 없음: 마크다운 표 파싱은 `|`로 split하는 문자열 처리이고, YAML은 f-log와 동일하게 `Bun.YAML`로 읽는다.

## 8. 선행 작업·리스크(범위 밖, 또는 구현 중 확인)

- **push 권한**: `origin`은 내부 GitLab 공유 저장소다. 과거 다른 fico 저장소에서 koscomailab-coder 계정에 push 권한이 없어 `gh auth switch`가 필요했던 사례가 있다(메모리 `freview-live-test-loop`). 구현 착수 시 첫 push 전에 인증을 확인한다.
- **실제 finding 카테고리 분류 확인**: 2·9·10번 케이스의 "예상 카테고리"는 설계자의 추정이며, 실제 f-review가 어떤 카테고리로 분류하는지는 1차 실행 결과로 확정·보정한다(f-log 테스트베드에서도 `rule:` 필드가 실행 후 보정된 전례가 여러 번 있었다).
- **line_range 허용폭(TOLERANCE)**: f-log의 과거 경험상 모델이 보고하는 줄 번호가 실제 결함 줄과 1~3줄 어긋나는 경우가 있었다. 기본값 ±3줄로 시작하고, 1차 실행 후 조정한다.
- **f-log 100케이스 자산과의 공존**: 베이스라인 커밋에 f-log 테스트 코드(`flogcase` 패키지)도 함께 들어가므로, f-review가 이 디렉터리까지 스캔 대상에 넣지 않도록(또는 넣어도 무방하도록) `--files` 글롭 범위를 `review/` 패키지로 명시적으로 좁힌다 — 전체 프로젝트 스캔이 아니라 이 10+2개 파일만 겨냥한다.
