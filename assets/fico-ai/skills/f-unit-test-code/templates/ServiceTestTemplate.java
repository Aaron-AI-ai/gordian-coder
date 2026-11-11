package {PackagePath};

// 예제: SONAQ001Service(계좌상세조회) 기준. 대상 클래스의 실제 import·필드·메서드로 바꿔 쓴다.
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;

import kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException;
import kr.co.koscom.pb.on.stk.ord.bsm.model.vo.AccountIn;
import kr.co.koscom.pb.on.stk.ord.bsm.model.vo.AccountOut;
import kr.co.koscom.pb.on.stk.ord.bsm.service.AccountBSM;
import kr.co.koscom.pb.on.stk.ord.online.qry.model.vo.SONAQ001In;
import kr.co.koscom.pb.on.stk.ord.online.qry.model.vo.SONAQ001Out;
import kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean; // Spring Boot 3.4 미만: org.springframework.boot.test.mock.mockito.MockBean
import org.springframework.transaction.annotation.Transactional;

/**
 * {TargetClass} 단위 테스트.
 * 대상은 실제 빈, 대상이 쓰는 외부 모듈(BSM)·Mapper·Redis·외부 API 클라이언트는 @MockitoBean.
 */
@SpringBootTest // 컨텍스트를 띄워 대상 Service를 실제 빈으로 주입한다
@Transactional // 테스트마다 롤백되어 상태가 남지 않는다
class {ClassName} {

    @Autowired
    private {TargetClass} target; // 예: SONAQ001Service

    @MockitoBean
    private AccountBSM accountBSM; // 다른 모듈 클래스는 전부 mock

    @BeforeEach
    void setUp() {
        reset(accountBSM); // 테스트마다 mock 상태를 초기화한다
    }

    @AfterEach
    void tearDown() {
        reset(accountBSM); // 다음 테스트로 스텁·호출 기록이 넘어가지 않게 한다
    }

    private SONAQ001In input(String accountNo) {
        SONAQ001In in = new SONAQ001In();
        in.setInner(SONAQ001In.Inner.builder().accountNo(accountNo).build());
        return in;
    }

    private AccountOut account(String accountNo, String name, BigDecimal balance) {
        AccountOut out = new AccountOut();
        out.setAccountNo(accountNo);
        out.setAccountName(name);
        out.setBalance(balance);
        return out;
    }

    // 정상 1: 기본 경로
    @Test
    void sonaq001_normal1() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenReturn(account("1234567890", "홍길동", new BigDecimal("1000")));

        SONAQ001Out result = target.sonaq001(input("1234567890"));

        assertEquals("1234567890", result.getInner().getAccountNo());
        assertEquals("홍길동", result.getInner().getAccountName());
        assertEquals(new BigDecimal("1000"), result.getInner().getBalance());
        verify(accountBSM).getAccount(any(AccountIn.class));
    }

    // 정상 2: 정상 1과 다른 입력·값(잔액 0)
    @Test
    void sonaq001_normal2() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenReturn(account("9876543210", "김철수", BigDecimal.ZERO));

        SONAQ001Out result = target.sonaq001(input("9876543210"));

        assertEquals("9876543210", result.getInner().getAccountNo());
        assertEquals(BigDecimal.ZERO, result.getInner().getBalance());
    }

    // 경계값: checkParameter의 isEmpty() 경계(빈 문자열) — BSM은 호출되지 않아야 한다
    @Test
    void sonaq001_boundary() {
        PBOnlineException e = assertThrows(PBOnlineException.class, () -> target.sonaq001(input("")));

        assertEquals("1001", e.getErrorCode()); // 코드가 실제로 던지는 코드값으로 맞춘다
        verify(accountBSM, never()).getAccount(any(AccountIn.class));
    }

    // 예외: BSM이 null을 돌려줄 때 던지는 PBOnlineException
    @Test
    void sonaq001_exception() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenReturn(null);

        assertThrows(PBOnlineException.class, () -> target.sonaq001(input("1234567890")));
        verify(accountBSM).getAccount(any(AccountIn.class));
    }
}
