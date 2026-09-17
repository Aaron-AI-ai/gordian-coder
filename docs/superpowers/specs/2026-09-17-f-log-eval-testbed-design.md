# f-log 평가 테스트베드 설계

날짜: 2026-09-17
상태: 승인됨(채팅), 구현 전
관련: `2026-09-16-f-log-design.md`(f-log 본체), 메모리 `p_flog_error_log_analysis`

## 1. 목적

f-log가 실제 fico 온라인 프로젝트의 에러 로그를 받아 **원인 파일·원인 심볼·해결 방안**을 정확히 짚는지 반복 검증할 수 있는 장치를 만든다. 대상 프로젝트는 `/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online`(이하 `target`).

성공 기준: `gradle test` 한 번으로 케이스별 로그가 재생성되고, 채점 스크립트 한 번으로 f-log 리포트가 정답과 자동 대조되어 PASS/FAIL 표가 나온다.

## 2. 결정 사항(채팅 합의)

| 항목 | 결정 |
|---|---|
| 판정 방식 | 케이스별 정답 YAML + 자동 대조 스크립트 |
| 로그 생성 | JUnit 테스트가 케이스별 로그 파일을 직접 생성. 서버 기동·HTTP 없음 |
| 초기 범위 | 3케이스(NPE, MyBatis 바인딩, 빈 충돌)로 골간 검증 후 확장 |
| 채점기 위치 | gordian-coder `scripts/flog-eval.ts` (다른 대상 프로젝트에도 재사용) |

## 3. 구조

```
target/                                      ← OpenCode cwd. f-log가 용의 파일을 찾는 레포
  src/main/java/kr/co/koscom/pb/on/test/lab/online/
    qry/controller/TLABQ001Controller.java   ← on-stk-ord SONAQ001Controller 패턴
    qry/service/TLABQ001Service.java         ← 케이스별 고의 버그 경로
    qry/model/vo/TLABQ001In.java
    qry/model/vo/TLABQ001Out.java
    mapper/TestLabMapper.java
  src/main/resources/mapper/postgres/online/TestLabMapper.xml
  src/test/java/kr/co/koscom/pb/on/test/lab/online/flogcase/
    CaseLog.java                             ← fico 프리픽스로 <case>.log 쓰는 헬퍼
    Case01NpeTest.java
    Case02MybatisBindingTest.java
    Case03BeanConflictTest.java
    dup/a/DupAcntMapper.java                 ← 테스트 전용 중복 빈
    dup/b/DupAcntMapper.java
  f-log-cases/
    case-01-npe.yaml
    case-02-mybatis-binding.yaml
    case-03-bean-conflict.yaml
  logs/f-log-cases/<case>.log                ← gradle test 산출물 (.gitignore)
  .fico/report/f-log/<case>.md               ← f-log 산출물 (.gitignore)

gordian-coder/scripts/flog-eval.ts           ← 러너 + 채점기 (Bun 단일 파일)
```

`target`의 git 최상위는 `/Users/koscom/workspace/fico/test-projects`(README 1개만 커밋된 상태)이고 `on-test-lab-online` 아래는 전부 미추적 파일이다. f-log의 파일 목록은 `git ls-files --cached --others --exclude-standard`라 미추적도 잡히므로 용의 파일 매핑은 동작한다. 단 `.gitignore`가 없어 `build/`·`bin/`·`logs/`도 목록에 섞이므로 `target/.gitignore`(`build/ bin/ logs/ .fico/`)를 함께 추가한다. 스택 없는 핸들러 라인 검색은 `git grep`(추적 파일만)이라 미추적 상태에선 비지만, 3케이스 모두 스택트레이스가 있어 영향 없다.

## 4. 에러 유발 코드와 테스트

모든 케이스는 **Spring 컨텍스트 없이** 실행한다. 이유 두 가지.
- 현재 앱은 `common-bcm`의 `bm.mapper`/`ac.mapper` 양쪽 `SelHigherAcntMapper` 빈 충돌로 부팅이 안 된다.
- `application.yml`의 `redis.eager-initialization: true`와 외부 IP 때문에 컨텍스트 로드가 네트워크에 의존한다.

컨트롤러·VO는 실제 앱 구조를 갖추기 위해 만들되, 테스트는 서비스·매퍼를 직접 호출한다.

### Case 01 — NPE (`npe`)
- 버그: `TLABQ001Service.tlabq001()`이 `mapper.selectAcnt()` 결과가 null인데 `.getAcntNm()`을 호출.
- 테스트: null을 돌려주는 `TestLabMapper` 익명 구현을 서비스에 주입하고 호출. `NullPointerException` 발생을 assert.
- 정답: 원인 파일 `TLABQ001Service.java`, 심볼 `tlabq001`, 해결 키워드 `null 체크|Optional|PBOnlineException`.

### Case 02 — MyBatis 바인딩 (`fico_mybatis`)
- 버그: `TestLabMapper.xml`의 `selectAcnt`가 `#{acntNo}`를 쓰는데 파라미터 VO 필드는 `accountNo`.
- 테스트: H2 in-memory `DataSource` + `SqlSessionFactoryBuilder`로 순수 MyBatis 세션 생성(테이블 1개 DDL 포함), 매퍼 호출. `PersistenceException`(원인 `ReflectionException`/`BindingException`) 발생을 assert.
- 정답: 원인 파일 `TestLabMapper.xml`, 심볼 `selectAcnt`, 해결 키워드 `acntNo|accountNo|파라미터|parameter`.
- 검증 포인트: f-log가 Java 프레임 밖의 XML 파일을 용의 파일로 찾는지.

### Case 03 — 빈 충돌 (`fico_wiring`)
- 버그: `flogcase/dup/a`와 `flogcase/dup/b`에 `@Repository("dupAcntMapper")` 같은 이름 클래스 2개.
- 테스트: `new AnnotationConfigApplicationContext()`로 `flogcase.dup` 패키지를 `scan()` → `ConflictingBeanDefinitionException` 발생을 assert. `src/test` 아래라 실제 앱 스캔에 잡히지 않는다.
- 정답: 원인 파일 두 `DupAcntMapper.java` 중 하나 이상, 심볼 `dupAcntMapper`, 해결 키워드 `빈 이름|bean name|@Repository|스캔 범위|scan`.
- 오늘(2026-09-17) 실제로 겪은 기동 실패와 같은 예외 형태다.

### CaseLog 헬퍼
```java
CaseLog.write("case-01-npe", TLABQ001Service.class, "계좌조회 실패", e);
```
`logs/f-log-cases/<case>.log`를 덮어쓰며, 첫 줄은 fico log4j2 패턴
`[ERROR::][<host>:<yyyy-MM-dd HH:mm:ss.SSS>][<thread>][<logger>:<method>:<line>] <msg>`,
이어서 `Throwable.printStackTrace` 출력. 실제 log4j2를 쓰지 않는 이유는 `${spring:...}` lookup이 컨텍스트를 요구하기 때문이며, f-log 파서가 보는 형식은 동일하다.

테스트는 예외 **발생**을 assert하므로 `gradle test`는 항상 green이다.

## 5. 정답 파일 형식

```yaml
# f-log-cases/case-02-mybatis-binding.yaml
log: logs/f-log-cases/case-02-mybatis-binding.log
exception: org.apache.ibatis.exceptions.PersistenceException   # 리포트 요약/원인 절에 등장해야 하는 예외 타입(체인 중 하나)
cause_files:                                                    # 하나 이상이 "진입점 → 원인 경로" 또는 "원인 상세와 근거"에 등장
  - src/main/resources/mapper/postgres/online/TestLabMapper.xml
cause_symbol: selectAcnt                                        # 같은 두 절에 등장해야 하는 메서드/SQL id
fix_keywords_any: ["acntNo", "accountNo", "파라미터", "parameter"]  # "해결 방안" 절에 하나 이상
rule: fico_mybatis                                              # 선택. "실행 정보"의 적용 룰에 포함
```

라인 번호는 넣지 않는다. 코드가 한 줄만 바뀌어도 정답이 깨지므로 파일+심볼로 판정한다.

## 6. 러너·채점기 `scripts/flog-eval.ts`

```
bun scripts/flog-eval.ts <target-dir> [--model <id>] [--case <id>] [--no-run]
```

1. `<target-dir>/f-log-cases/*.yaml`을 읽는다(`--case`로 하나만).
2. `--no-run`이 아니면 케이스마다 `target-dir`에서 실행:
   `opencode run --command f-log [-m <model>] -- "--file=<log> --output=.fico/report/f-log/<case>.md"`
   (f-review 실환경 루프에서 검증된 호출 방식. 첫 구현 때 f-log에서도 동작하는지 확인이 1순위.)
3. 리포트를 `## ` 헤더 기준으로 절로 나눈다. 대상 절: `요약`, `진입점 → 원인 경로`, `원인 상세와 근거`, `해결 방안`, `실행 정보`(영문 리포트면 `Summary`, `Entry point → cause path`, `Cause and evidence`, `Resolution`, `Run info`).
4. 항목별 판정: `exception` 포함, `cause_files` 중 하나 포함(경로는 basename 일치도 허용), `cause_symbol` 포함, `fix_keywords_any` 중 하나 포함, `rule` 포함(선택). 대소문자 무시.
5. 케이스 × 항목 PASS/FAIL 표를 stdout에 출력하고, FAIL이 하나라도 있으면 exit 1.

의존성 추가 없음: YAML은 필드가 평면적이라 `Bun.YAML`(Bun 1.2+ 내장)로 읽는다. 리포트 절 분할과 키워드 대조는 문자열 처리다.

## 7. 선행 작업(범위 밖, 별도 진행)

앱 부팅 실패 수정. `@SpringBootApplication(scanBasePackages = "kr.co.koscom.pb")`가 `common-bcm`의 `bm.mapper`와 `ac.mapper` 양쪽 `SelHigherAcntMapper`를 다 끌어오는 것이 원인. `common-bcm` 소스에서 어느 쪽이 의도된 빈인지 확인한 뒤 스캔 범위 축소 또는 `@MapperScan` 조정으로 잡는다. 이 테스트베드의 3케이스 실행에는 필요 없다.

## 8. 확장

케이스 추가 = 서비스에 버그 경로 1개 + 테스트 1개 + yaml 1개. 러너·채점기는 수정하지 않는다. 7번이 끝나면 `@SpringBootTest` 기반 케이스(`fico_transaction`, `fico_fixed_message`, `fico_error_code`)로 확장한다.

## 9. 범위 밖

- HTTP 기반 케이스, 실 log4j2 appender 사용
- 라인 번호 판정, LLM 심사(judge) 결과의 정량 채점
- on-test-lab의 batch/bsm/daemon 모듈
