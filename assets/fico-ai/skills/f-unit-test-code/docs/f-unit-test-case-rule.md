# 단위 테스트 케이스 규칙

대상 클래스의 **public 메서드마다** 아래 케이스를 만든다. 케이스는 코드를 읽어 도출한다(요구사항을 추측하지 않는다).

| 케이스 | 이름 | 도출 방법 |
|---|---|---|
| 정상 1 | `<메서드>_normal1` | 기본 성공 경로. 반환값과 mock 호출(`verify`)을 단언한다. |
| 정상 2 | `<메서드>_normal2` | **정상 1과 다른 입력이나 다른 분기**(예: 값이 0, 목록이 여러 건, 선택 필드 있음/없음). 같은 입력의 복제 금지. |
| 경계값 | `<메서드>_boundary` | 코드의 `<`, `<=`, `>`, `>=`, `==`, 길이·크기 제한, `null`/빈 문자열/빈 목록 검사에서 도출. 경계의 양쪽을 본다(예: `isEmpty()`면 `""`, 길이 제한이면 한도와 한도+1). |
| 예외 | `<메서드>_exception` | 코드의 `throw`(예: `PBOnlineException.create("1001", ...)`)와 mock이 던지는 예외(`when(...).thenThrow(...)`)에서 도출. 코드에 없는 예외 타입은 기대하지 않는다. |

분기가 더 있으면 케이스를 더 만든다(위는 최소). 한 메서드의 `throw`가 여러 개면 `_exception`, `_exception2`처럼 각각 만든다.

## 클래스 종류별

- **Service:** BSM·Mapper를 `@MockitoBean`으로 스텁해 `when(bsm.getAccount(any(AccountIn.class))).thenReturn(...)`. 반환 VO(`Out.getInner()`)의 값과 `verify(bsm)` 호출을 단언한다. 입력 검증 실패 시 BSM이 호출되지 않음(`never()`)도 확인한다.
- **Controller:** Service는 실제 객체. `PBRequest<In>`를 만들어(`setData`, `setCommonHeader(new PBFixedHeader())`) 컨트롤러 메서드를 호출하고 `PBResponse.getData()`를 검증한다. 예외는 Service가 던진 `PBOnlineException`이 그대로 나오는지 본다.
- **Mapper:** mock 없이 실제 DB(프로필)를 조회한다. **Mapper 메서드마다** 아래 케이스를 만들고, 쓰기 케이스는 같은 테스트 안에서 다시 조회해 단언한다. 키는 `UT_` 접두어 + 유일 값. 예외 케이스는 `assertThrows`.
  - select: 정상 2건(서로 다른 키로 찾는 경우 / 목록·페이징 결과), 경계(결과 없음, 선택 파라미터 null, 페이징 첫/마지막 페이지), 예외(필수 파라미터 null 등 → `DataAccessException` 계열).
  - insert/update/delete: 정상 2건(영향 행 수 1 + 다시 조회해 값 확인 / 다른 컬럼 조합), 경계(최대 길이 값, 대상 없는 키의 update/delete가 0건), 예외(중복 키·NOT NULL 위반 → `DuplicateKeyException`/`DataIntegrityViolationException`).
- **VO·상수·단순 위임:** 아래 "건너뛰기" 참고.

## 입력 만들기

- 필수 필드를 빠뜨리지 않는다(VO `Inner`의 `@Builder`/setter 확인). 누락하면 의도하지 않은 예외가 난다.
- 값은 VO의 `@FixedData(length=...)` 길이를 넘기지 않는다(경계값 케이스에서 의도적으로 넘기는 경우만 예외).

## 건너뛰어도 되는 경우와 skip_reason

계획 단계에서 대상 메서드를 건너뛰려면 `skip_reason`을 한 문장으로 적는다. 건너뛸 수 있는 것만:

- Lombok이 만든 getter/setter, 단순 getter·상수 반환 (`skip_reason: "Lombok getter, 분기 없음"`)
- 분기 없이 다른 클래스에 위임만 하는 메서드 (`skip_reason: "분기 없는 위임, 호출 대상이 mock이라 검증할 것이 없음"`)
- Mapper의 일괄 삭제 메서드(`deleteAll`, `truncate*`처럼 조건 없이 테이블을 비우는 것): 롤백되는 트랜잭션 안이라도 다른 데이터소스·자동 커밋이면 실데이터를 지운다. `skip_reason`으로 건너뛸 수 있다 (`skip_reason: "조건 없는 일괄 삭제, 실데이터 보호"`).
- 빈 훅 메서드(`preprocess()`처럼 본문이 없는 private 메서드)는 public 메서드 테스트로 함께 실행되므로 따로 만들지 않는다.

"어려워서", "시간이 걸려서"는 사유가 아니다. 건너뛴 메서드는 리포트에 사유와 함께 남는다.
