package {PackagePath};

// 예제: AccountMapper(계좌) 기준. 대상 Mapper의 실제 import·메서드·DTO로 바꿔 쓴다.
// Mapper 테스트는 mock 없이 프로젝트 테스트 프로필의 실제 DB를 조회한다. 모든 쓰기는 테스트 트랜잭션 안에서 롤백된다.
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import kr.co.koscom.pb.on.stk.ord.bsm.model.dto.AccountParameter;
import kr.co.koscom.pb.on.stk.ord.bsm.model.dto.AccountResult;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

/**
 * {TargetClass} 단위 테스트 (실제 DB).
 * Mapper는 mock하지 않고 Spring이 만든 실제 빈을 쓴다. 테스트 데이터 키는 UT_ 접두어 + 유일 값.
 */
@SpringBootTest // 컨텍스트를 띄워 실제 Mapper 빈을 주입한다
@ActiveProfiles("test") // 계획의 note에 적은 프로필로 바꾼다 (예: test-oracle). 프로필 자리표시자를 남기지 않는다
// 기본 트랜잭션 매니저만 롤백한다. 대상 Mapper가 기본이 아닌 데이터소스(secondary, ext 등)에 붙어 있으면
// @Transactional("<그 데이터소스의 transactionManager 빈 이름>")으로 바꾼다 (이름은 계획 note에 적는다).
@Transactional // 모든 쓰기가 테스트 끝에 롤백된다. @Commit·@Rollback(false)·Propagation 변경 금지
class {ClassName} {

    private static final String KEY1 = "UT_ACC_0001";
    private static final String KEY2 = "UT_ACC_0002";

    @Autowired
    private {TargetClass} mapper; // 실제 Mapper 빈 (mock 어노테이션 금지)

    // 같은 SELECT를 반복 호출하거나 MyBatis 밖(JdbcTemplate 등)에서 데이터를 바꾼 뒤 다시 확인할 때 1차 캐시를 비운다.
    // 예: long a = mapper.selectNextSeq(); sqlSession.clearCache(); long b = mapper.selectNextSeq();
    // Mapper의 insert/update/delete는 캐시를 자동으로 비우므로 이 예제의 tearDown(mapper.delete)에는 필요 없다.
    @Autowired
    private SqlSessionTemplate sqlSession;

    private AccountParameter param(String accountNo, String name) {
        AccountParameter p = new AccountParameter();
        p.setAccountNo(accountNo);
        p.setAccountName(name);
        p.setCustomerNo("UT_CUST_0001");
        return p;
    }

    @BeforeEach
    void setUp() {
        // 시드 행은 Mapper로 넣는다 (같은 테스트 트랜잭션 안)
        assertEquals(1, mapper.insert(param(KEY1, "UT홍길동")));
        assertEquals(1, mapper.insert(param(KEY2, "UT김철수")));
    }

    @AfterEach
    void tearDown() {
        // 어차피 롤백되지만 규칙상 직접 지우고 사라졌는지 확인한다
        mapper.delete(param(KEY1, null));
        mapper.delete(param(KEY2, null));
        assertNull(mapper.selectByAccountNo(param(KEY1, null)));
        assertNull(mapper.selectByAccountNo(param(KEY2, null)));
    }

    // select 정상 1: 키로 한 건 조회
    @Test
    void selectByAccountNo_normal1() {
        AccountResult result = mapper.selectByAccountNo(param(KEY1, null));

        assertNotNull(result);
        assertEquals(KEY1, result.getAccountNo());
        assertEquals("UT홍길동", result.getAccountName());
    }

    // select 정상 2: 다른 키 / 고객번호로 목록
    @Test
    void selectByAccountNo_normal2() {
        assertEquals("UT김철수", mapper.selectByAccountNo(param(KEY2, null)).getAccountName());

        List<AccountResult> list = mapper.selectByCustomerNo(param(null, null));
        assertTrue(list.size() >= 2);
    }

    // select 경계: 결과 없음
    @Test
    void selectByAccountNo_boundary() {
        assertNull(mapper.selectByAccountNo(param("UT_NOT_EXISTS", null)));
    }

    // select 예외: 필수 파라미터 null
    @Test
    void selectByAccountNo_exception() {
        assertThrows(DataAccessException.class, () -> mapper.selectByAccountNo(null));
    }

    // insert 정상 1: 영향 행 수 1 + 다시 조회해 값 확인
    @Test
    void insert_normal1() {
        assertEquals(1, mapper.insert(param("UT_ACC_0003", "UT신규")));

        assertEquals("UT신규", mapper.selectByAccountNo(param("UT_ACC_0003", null)).getAccountName());
    }

    // insert 정상 2: 다른 컬럼 조합
    @Test
    void insert_normal2() {
        AccountParameter p = param("UT_ACC_0004", "UT다른이름");
        p.setCustomerNo("UT_CUST_0002");

        assertEquals(1, mapper.insert(p));
        assertEquals("UT_CUST_0002", mapper.selectByAccountNo(param("UT_ACC_0004", null)).getCustomerNo());
    }

    // insert 경계: 컬럼 최대 길이 값
    @Test
    void insert_boundary() {
        String maxName = "가".repeat(20); // 실제 컬럼 길이로 맞춘다

        assertEquals(1, mapper.insert(param("UT_ACC_0005", maxName)));
        assertEquals(maxName, mapper.selectByAccountNo(param("UT_ACC_0005", null)).getAccountName());
    }

    // insert 예외: 시드와 같은 키 → 중복 키
    @Test
    void insert_exception() {
        assertThrows(DuplicateKeyException.class, () -> mapper.insert(param(KEY1, "UT중복")));
    }

    // update 정상 1: 영향 행 수 1 + 다시 조회
    @Test
    void update_normal1() {
        assertEquals(1, mapper.update(param(KEY1, "UT변경")));

        assertEquals("UT변경", mapper.selectByAccountNo(param(KEY1, null)).getAccountName());
    }

    // update 정상 2: 다른 행 (다른 컬럼 조합)
    @Test
    void update_normal2() {
        assertEquals(1, mapper.update(param(KEY2, "UT다른변경")));

        assertEquals("UT다른변경", mapper.selectByAccountNo(param(KEY2, null)).getAccountName());
        assertEquals("UT홍길동", mapper.selectByAccountNo(param(KEY1, null)).getAccountName()); // 다른 행은 그대로
    }

    // update 경계: 대상 없는 키는 0건
    @Test
    void update_boundary() {
        assertEquals(0, mapper.update(param("UT_NOT_EXISTS", "UT변경")));
    }

    // update 예외: NOT NULL 컬럼에 null → DataIntegrityViolationException 계열 (DataAccessException으로 받아도 된다)
    @Test
    void update_exception() {
        AccountParameter p = param(KEY1, null);
        p.setCustomerNo(null);

        assertThrows(DataAccessException.class, () -> mapper.update(p));
    }

    // delete 정상 1: 지우고 다시 조회해 없음 확인
    @Test
    void delete_normal1() {
        assertEquals(1, mapper.delete(param(KEY1, null)));

        assertNull(mapper.selectByAccountNo(param(KEY1, null)));
    }

    // delete 정상 2: 다른 행을 지워도 첫 행은 남는다
    @Test
    void delete_normal2() {
        assertEquals(1, mapper.delete(param(KEY2, null)));

        assertNull(mapper.selectByAccountNo(param(KEY2, null)));
        assertNotNull(mapper.selectByAccountNo(param(KEY1, null)));
    }

    // delete 경계: 대상 없는 키는 0건
    @Test
    void delete_boundary() {
        assertEquals(0, mapper.delete(param("UT_NOT_EXISTS", null)));
    }

    // delete 예외: 필수 파라미터 null
    @Test
    void delete_exception() {
        assertThrows(DataAccessException.class, () -> mapper.delete(null));
    }
}
