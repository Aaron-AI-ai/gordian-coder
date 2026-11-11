package {PackagePath};

// 예제: SONAQ001Controller(POST /ON/SONAQ001) 기준. 대상 클래스의 실제 import·메서드로 바꿔 쓴다.
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;

import kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException;
import kr.co.koscom.pb.framework.site.ext.model.fixed.PBFixedHeader;
import kr.co.koscom.pb.framework.site.ext.model.fixed.PBRequest;
import kr.co.koscom.pb.framework.site.ext.model.fixed.PBResponse;
import kr.co.koscom.pb.on.stk.ord.bsm.model.vo.AccountIn;
import kr.co.koscom.pb.on.stk.ord.bsm.model.vo.AccountOut;
import kr.co.koscom.pb.on.stk.ord.bsm.service.AccountBSM;
import kr.co.koscom.pb.on.stk.ord.online.qry.controller.SONAQ001Controller;
import kr.co.koscom.pb.on.stk.ord.online.qry.model.vo.SONAQ001In;
import kr.co.koscom.pb.on.stk.ord.online.qry.model.vo.SONAQ001Out;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean; // Spring Boot 3.4 미만: org.springframework.boot.test.mock.mockito.MockBean
import org.springframework.transaction.annotation.Transactional;

/**
 * {TargetClass} 단위 테스트.
 * Controller와 그 아래 같은 모듈 Service는 실제 빈이고, Service가 쓰는 BSM(다른 모듈)만 @MockitoBean이다.
 * 컨트롤러 메서드를 직접 호출해 요청 -> 응답을 검증한다.
 */
@SpringBootTest // 컨텍스트를 띄워 Controller·Service를 실제 빈으로 주입한다
@Transactional // 테스트마다 롤백되어 상태가 남지 않는다
class {ClassName} {

    @Autowired
    private {TargetClass} target; // 예: SONAQ001Controller

    @MockitoBean
    private AccountBSM accountBSM; // Service가 부르는 다른 모듈 클래스는 mock

    @BeforeEach
    void setUp() {
        reset(accountBSM); // 테스트마다 mock 상태를 초기화한다
    }

    @AfterEach
    void tearDown() {
        reset(accountBSM); // 다음 테스트로 스텁·호출 기록이 넘어가지 않게 한다
    }

    private PBRequest<SONAQ001In> request(String accountNo) {
        SONAQ001In in = new SONAQ001In();
        in.setInner(SONAQ001In.Inner.builder().accountNo(accountNo).build());
        PBRequest<SONAQ001In> req = new PBRequest<>();
        req.setCommonHeader(new PBFixedHeader()); // PBResponse.success가 요청 헤더를 복사하므로 null이면 NPE
        req.setData(in);
        return req;
    }

    private AccountOut account(String accountNo, String name, BigDecimal balance) {
        AccountOut out = new AccountOut();
        out.setAccountNo(accountNo);
        out.setAccountName(name);
        out.setBalance(balance);
        return out;
    }

    // 정상 1: 기본 경로, 응답 본문 검증
    @Test
    void sonaq001_normal1() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenReturn(account("1234567890", "홍길동", new BigDecimal("1000")));

        PBResponse<SONAQ001Out> res = target.sonaq001(request("1234567890"));

        assertEquals("1234567890", res.getData().getInner().getAccountNo());
        assertEquals("홍길동", res.getData().getInner().getAccountName());
        verify(accountBSM).getAccount(any(AccountIn.class));
    }

    // 정상 2: 정상 1과 다른 입력·값
    @Test
    void sonaq001_normal2() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenReturn(account("9876543210", "김철수", BigDecimal.ZERO));

        PBResponse<SONAQ001Out> res = target.sonaq001(request("9876543210"));

        assertEquals("9876543210", res.getData().getInner().getAccountNo());
        assertEquals(BigDecimal.ZERO, res.getData().getInner().getBalance());
    }

    // 경계값: Service의 빈 문자열 검사 경계
    @Test
    void sonaq001_boundary() {
        assertThrows(PBOnlineException.class, () -> target.sonaq001(request("")));
    }

    // 예외: BSM이 null을 돌려줄 때 Service가 던지는 PBOnlineException이 Controller를 통과해 나온다
    @Test
    void sonaq001_exception() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenReturn(null);

        assertThrows(PBOnlineException.class, () -> target.sonaq001(request("1234567890")));
    }
}
