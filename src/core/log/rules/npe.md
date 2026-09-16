---
exceptions: "java.lang.NullPointerException"
---
#### NPE: 역참조 대상이 아니라 그 값의 생산자를 찾는다
- JDK 14+ helpful NPE 메시지(`because "x.y" is null`)가 관측이면 `x.y`의 생산자가 원인이다. 메시지가 없으면 원인 줄을 읽어 역참조 후보를 나열한다.
- fico 특유의 null 원인: `CommonException.create(code)`의 `getMessage()`는 null(문자열 연결에서 NPE); optional ext Mapper 빈이 null; `commonHeader`가 null(`FWKE0002` 이전); 요청 스코프 밖에서 `RequestScopeUtils.getAttribute` → null; Mapper 단건 조회 결과 없음 → null 반환.
- `Map.get`/`Optional.get` 없이 `.get(...)` 결과를 바로 역참조하는 패턴.

확인 절차
1. 원인 프레임 ±10줄을 `f_log_read`로 읽어 역참조 대상을 특정한다.
2. 그 값을 만드는 메서드를 `f_log_callers`/`f_log_search`로 찾아 null을 돌려주는 경로를 확인한다.
3. 최근 변경이면 `f_log_blame`으로 그 줄의 커밋을 본다.
4. `Map.get`/`Optional.get` 패턴이면 `f_log_search`로 호출부 주변에 null 체크가 있는지 확인한다.
5. optional ext Mapper 빈이 원인 후보면 `f_log_read`로 null 체크 유무를 확인한다.
6. 반복되는 패턴이면 `f_log_related`로 같은 클래스의 유사 역참조 지점을 찾는다.
