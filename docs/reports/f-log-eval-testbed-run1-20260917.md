# f-log 평가 테스트베드 1차 실행 (2026-09-17)

대상: on-test-lab-online, 케이스 3개. 모델: `openrouter/qwen/qwen3.8-27b`. 스크립트: `scripts/flog-eval.ts`.

## 결과

| case | exception | cause_file | cause_symbol | fix | fix_code | rule | report |
|---|---|---|---|---|---|---|---|
| case-01-npe | PASS | PASS | PASS | PASS | PASS | PASS | .fico/report/f-log/case-01-npe.md |
| case-02-mybatis-binding | PASS | PASS | PASS | PASS | PASS | PASS | .fico/report/f-log/case-02-mybatis-binding.md |
| case-03-bean-conflict | PASS | PASS | PASS | PASS | PASS | FAIL | .fico/report/f-log/case-03-bean-conflict.md |

2/3 cases fully PASS

## 케이스별 소견

### case-01-npe
- 리포트가 짚은 원인 파일/심볼: `TLABQ001Service.java:46`의 `tlabq001()`이 `testLabMapper.selectAcnt()`의 단건 조회 결과 `row`를 null 체크 없이 `row.getAcntNo()`로 역참조한다고 정확히 짚었다. 정답의 `cause_symbol: tlabq001`, `cause_files: TLABQ001Service.java`와 정확히 일치.
- 정답과의 차이: 없음. 신뢰도 93~98(라운드마다 소폭 차이) — 진단 자체는 안정적으로 재현된다.
- 해결 방안 품질: null 가드를 추가하고, 이 서비스가 이미 쓰는 `PBOnlineException.create(4자리 코드)` 관례로 조회 결과 없음을 변환하라고 제안했다. 실제 코드 조각(`if (row == null) { throw PBOnlineException.create(...) }`)과 재현 테스트 갱신 방향까지 함께 제시해 실행 가능한 수준이었다.

### case-02-mybatis-binding
- 리포트가 짚은 원인 파일/심볼: `TestLabMapper.xml:15`의 `selectAcnt` 바인딩 `#{acntNo}`가 파라미터 VO(`TLABQ001In.Inner`)의 실제 필드 `accountNo`(getter `getAccountNo()`)와 불일치해 MyBatis가 파라미터 바인딩 단계에서 `ReflectionException`을 던진다고 정확히 짚었다. 정답의 `cause_files: TestLabMapper.xml`, `cause_symbol: selectAcnt`와 일치.
- 정답과의 차이: 없음. 특히 이 로그는 `ErrorContext`가 찍히기 전에 `BaseExecutor.createCacheKey` 단계에서 실패해 "### The error may involve …selectAcnt" 앵커 줄이 없다 — 남은 단서는 메시지 속 `TLABQ001In$Inner` 클래스명과 `jdk.proxy3.$Proxy20.selectAcnt` 프록시 프레임뿐이다. 이 약한 단서만으로도 f-log는 `TestLabMapper.xml`을 정확히 찾아냈다.
- 해결 방안 품질: XML 바인딩 이름을 `#{accountNo}`로 바꾸라는 제안이 정확했고, KB `fico_mybatis.md`의 "파라미터명 ↔ DTO 필드명 불일치" 항목을 근거로 들었다. 수정 후 XML 조각과 테스트 갱신 방향도 함께 제시.

### case-03-bean-conflict
- 리포트가 짚은 원인 파일/심볼: 서로 다른 패키지(`flogcase.dup.a`, `flogcase.dup.b`)의 두 `DupAcntMapper` 클래스가 모두 `@Repository("dupAcntMapper")`로 같은 빈 이름을 명시해, 컴포넌트 스캔이 두 클래스를 모두 발견하면서 `ConflictingBeanDefinitionException`이 발생한다고 정확히 짚었다. 두 `DupAcntMapper` 중에서는 `dup.b` 쪽(정답 `cause_files`에 두 파일이 모두 등재되어 있어 어느 쪽이든 PASS)을 원인 프레임으로 지목했고, 해법으로 `dup.b`의 빈 이름을 `dupAcntMapperB`로 바꾸는 "빈 이름 고유화"를 냈다(빈 이름 쪽 해법이며 스캔 범위 축소는 제시하지 않음).
- 정답과의 차이: `rule` 컬럼만 FAIL. 정답 YAML은 `rule: fico_wiring`을 기대하지만, 실제 리포트의 "실행 정보 → 적용 룰"에는 `framework_kb.md, fico_error_code.md`만 있고 `fico_wiring.md`는 없다. 원인 진단과 해법 자체는 정답과 일치했으므로 실질적인 오진은 아니다.
- 해결 방안 품질: 근본 원인(빈 이름 충돌) 자체를 제거하는 수정이었고, 증상 회피(예외 무시)가 아니라는 점도 명시했다. 다만 두 빈 이름을 모두 바꾸는 대신 하나만 바꾸는 최소 수정을 택한 점, 그리고 fico_wiring.md가 제시하는 "스캔 범위 좁히기" 대안은 언급하지 않은 점은 아쉽다.

## 발견한 f-log 개선점

1. **룰: `fico_wiring.md`의 `exceptions` 패턴이 `org.springframework.context.annotation.ConflictingBeanDefinitionException`을 놓친다.** case-03 리포트의 "실행 정보" 절은 다음과 같다: `적용 룰: framework_kb.md, fico_error_code.md` — `fico_wiring.md`가 없다. 현재 프런트매터는 `org.springframework.beans.factory.*`, `*BeanCreationException`, `*UnsatisfiedDependencyException`, `*NoSuchBeanDefinitionException`, `*NoUniqueBeanDefinitionException`, `*ApplicationContextException`, `*BeanDefinitionStoreException`만 나열한다. `ConflictingBeanDefinitionException`은 `org.springframework.context.annotation` 패키지에 속하고 Spring에서 `BeanDefinitionStoreException`의 서브클래스이지만, 라우터가 클래스명 접미사 문자열/와일드카드로만 매칭하고 상속 관계나 패키지 경로를 보지 않아서 `*BeanDefinitionStoreException` 패턴이 걸리지 않는다. 진단 자체는 (아마 KB의 일반 스프링 지식으로) 맞았지만 `fico_wiring.md`가 제공하는 "확인 절차"(빈 이름 검색 → 생성자/필드 주입 확인 → 스캔 범위 비교)는 전혀 활용되지 않았다. `exceptions` 목록에 `org.springframework.context.annotation.ConflictingBeanDefinitionException`(또는 `*ConflictingBeanDefinitionException`)을 명시적으로 추가하거나, 라우터가 예외 클래스 계층을 인식하도록 개선해야 한다.
2. **해결 방안의 대안 폭이 좁다(case-03).** `fico_wiring.md`가 실제로 다루는 두 갈래 해법 — "빈 이름 고유화" vs "컴포넌트 스캔 범위 좁히기" — 중 리포트는 전자만 제시했다. 룰이 로드되지 않았으니 당연한 결과이기도 하지만, 룰이 로드됐어도 두 대안을 모두 검토했는지는 이번 실행만으로는 알 수 없다 — 다음 실행에서 fico_wiring 로드 수정 후 재확인이 필요하다.
3. **case-02의 약한 앵커 대응은 강점으로 확인됨(개선점 아님, 기록용).** `### The error may involve` 줄이 없는 로그에서도 클래스명·프록시 프레임만으로 원인 XML을 정확히 찾은 점은 f-log의 탐색 능력이 로그 포맷 변화에 어느 정도 강건함을 보여준다 — 회귀 확인용 벤치마크로 유지할 가치가 있다.

## 채점기 개선점

1. **`rule` 채점이 "그 룰이 로드됐는가"만 보고 "그 룰이 실제로 필요했는가"는 구분하지 않는다.** case-03처럼 원인 진단 자체는 정답과 일치하는데 룰 로딩만 어긋난 경우, 지금 채점기는 이를 다른 항목(exception/cause_file/cause_symbol/fix)과 동일한 무게의 FAIL로 처리한다. 룰 매칭이 라우터의 별도 결함(위 개선점 1)임을 감안하면, `rule` 항목에 대해 "권장(advisory)"과 "필수(hard)"를 구분하거나, 최소한 표에 각주로 원인을 구분해 표시하는 편이 다음 실행 결과를 더 정확히 읽게 해줄 것이다. (이번 보고서는 본문에서 구분해 서술하는 것으로 대신한다.)
2. **`--no-run` 재채점 경로는 이번 실행에서 실사용하지 않았다.** Step 2/3의 리포트가 모두 정상 생성돼 재채점 경로를 밟을 필요가 없었다. 별도로 기존 리포트만 두고 `--no-run`을 검증하는 것이 다음 과제로 남는다.

## 다음
- `fico_wiring.md`의 `exceptions` 패턴에 `*ConflictingBeanDefinitionException`을 추가하고 case-03을 재실행해 `rule` 컬럼이 PASS로 바뀌는지, 그리고 "스캔 범위 좁히기" 대안이 언급되는지 확인한다.
- 채점기의 `rule` 항목을 advisory로 분리할지, 그대로 hard 실패로 둘지 결정한다.
- 다음 케이스 후보: 트랜잭션 롤백 누락(`fico_transaction`), Redis 타임아웃(`fico_redis`) 등 아직 다루지 않은 번들 룰을 겨냥한 케이스.
