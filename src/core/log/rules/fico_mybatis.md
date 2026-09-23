---
exceptions: "org.apache.ibatis.*", "org.springframework.dao.*", "*MyBatisSystemException", "*PersistenceException", "*DataAccessException", "*DataIntegrityViolationException", "*DuplicateKeyException", "*TooManyResultsException", "*OptimisticLockingFailureException"
---
#### MyBatis 오류는 XML·인터페이스·인터셉터 셋 중 하나
- `MyBatisPagingInterceptor`가 `StatementHandler.prepare`에서 **SQL을 감싼다**(`PagingSqlHelper`: ORACLE11 `ROWNUM`, ORACLE `OFFSET … FETCH`, POSTGRESQL `LIMIT … OFFSET`). 페이징 조회의 문법 오류는 원본 XML이 아니라 래핑 결과다 — 원본에 `ORDER BY`가 없거나 서브쿼리 별칭이 없으면 래핑 후에 깨진다.
- `#{}` 파라미터명 ↔ DTO 필드명(getter) 불일치, XML `<select id>` ↔ Mapper 인터페이스 메서드명 불일치, `resultType` 클래스 경로 오타.
- `DuplicateKeyException`/`DataIntegrityViolationException`은 메시지의 제약 이름(`UK_…`, `FK_…`)이 관측이다 — 어느 컬럼 조합인지 XML의 INSERT 컬럼과 대조한다.
- `TooManyResultsException`: 단건 조회 메서드가 List 결과 — WHERE 조건 누락.
- 상세 규칙은 `mapper_dao_xml.md`.

확인 절차
1. 스택의 Mapper 인터페이스명(`*Mapper.method`)으로 `f_log_search` `id="<method>"`를 `*.xml`에서 찾는다.
2. 그 XML 블록을 `f_log_read`로 읽고, `#{…}` 이름을 파라미터 DTO의 필드와 `f_log_search`로 대조한다.
3. 스택에 `MyBatisPagingInterceptor`가 있으면 원본 SQL을 페이징 래핑에 넣었을 때 유효한지 검토한다.
4. 제약 위반 예외라면 메시지의 제약 이름을 `f_log_search`로 XML의 INSERT/UPDATE 컬럼과 대조한다.
