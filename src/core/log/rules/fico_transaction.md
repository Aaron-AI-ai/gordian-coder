---
exceptions: "*TransactionException", "*UnexpectedRollbackException", "*CannotCreateTransactionException", "*TransactionSystemException", "*IllegalTransactionStateException"
---
#### fico 트랜잭션은 `@Transactional`이 아니라 `PBTransactionAspect`가 연다
- `@Around("bean(*Service)")`: PB 고정길이 요청(svcId 존재)이면 **Service 진입 시 트랜잭션을 열고**, svcId 5번째 글자가 `Q`/`R`(조회·보고서)이면 **정상 종료도 rollback**, `T`/`U`면 commit. 조회 서비스에서 INSERT/UPDATE가 "사라지는" 현상의 원인이다.
- 중첩 Service 호출은 `TX_ACTIVE` ThreadLocal로 스킵 — 바깥 Service의 트랜잭션에 묶인다.
- svcId가 null(비-PB 요청, 배치, 데몬)이면 aspect가 통째로 스킵되고 `@Transactional`만 적용된다.
- `mapper/ext` Mapper(`ExtLogMapper` 등)는 `SqlSessionTemplate` auto-commit — 트랜잭션 밖이라 rollback돼도 남는다.
- 앱 규칙: `qry/service`는 `@Transactional(readOnly = true)`, `upd/service`는 `@Transactional`. readOnly 트랜잭션 안에서 쓰기 Mapper를 부르면 드라이버에 따라 예외 또는 무시.

확인 절차
1. 스택에서 `PBTransactionAspect.manageTransaction` 프레임 유무로 aspect 적용 여부를 판단한다.
2. 원인 Service의 svcId(`{svcId}Service` 이름의 5번째 글자)와 `@Transactional` 속성을 `f_log_read`로 확인한다.
3. 호출된 Mapper가 `mapper/ext` 아래인지 `f_log_find`로 본다.
4. `readOnly` 트랜잭션 안에서 쓰기 Mapper를 부르는지 `f_log_search`로 해당 Service의 Mapper 호출을 찾는다.
