#### fico 에러코드 읽는 법
- 예외 계층: `CommonException`(core) → `PBBaseException` → `PBOnlineException`/`PBBatchException`/`PBDaemonException`/`PBModuleException`.
- `CommonException.create(code)`는 message가 **null**이다 → 스택 헤더에 메시지가 없고, 에러코드는 **직전 핸들러 로그 줄**(`errorCode=`, `code=`)에만 있다. 관측 목록의 errorCode가 그것이다.
- 4자리 숫자 코드만 고정헤더 msgCode로 나가고, 그 외는 `9000`(`PBCommonUtils.DEFAULT_ERROR_CODE`). `9604`는 입력 전문 포맷 오류, `FWKE0001/0002/0003`은 프레임워크 코드(0002 = commonHeader 누락, 0003 = 일반 Exception 래핑).
- 메시지 텍스트는 DB 테이블 `COM_MSG`(`DBMessageSource`, 기동 시 캐시)에 있다. **저장소에는 없으니 찾지 마라.**
- 앱 규칙: Service는 `PBOnlineException.create()`를 쓴다. `CommonException`을 직접 던지는 Service는 그 자체가 후보다.

확인 절차
1. `f_log_search`로 `create("<errorCode>"` 를 `*.java`에서 찾는다 — throw 지점이 용의 위치다. 여러 곳이면 스택의 in-app 프레임과 겹치는 곳을 고른다.
2. throw 직전 조건식을 `f_log_read`로 읽고, 그 조건의 입력이 어디서 오는지 `f_log_callers`로 거슬러 간다.
3. `withExceptionCode("<code>"`도 같이 검색한다 — 코드가 나중에 덮어써졌을 수 있다.
4. 해당 throw 지점이 최근에 추가·변경됐는지 `f_log_history`로 확인한다 — 새 코드라면 `COM_MSG`에 메시지가 아직 없을 수 있다.
