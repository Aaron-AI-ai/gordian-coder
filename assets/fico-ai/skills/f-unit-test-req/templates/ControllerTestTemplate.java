package {PackagePath};

// 요구사항 기반(TDD) 예제: 대상 코드는 뼈대(시그니처)만 있고, 기대값은 요구사항에서 정한다. 예제: SONAQ001Controller(POST /ON/SONAQ001) 기준. 대상 클래스의 실제 import·메서드로 바꿔 쓴다.
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;

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
 * 프록시 호출이라 프레임워크 Aspect가 감싼다(형식 규칙 "Controller 테스트: 프레임워크 Aspect").
 * 이 예제는 PBExceptionHandlerAspect가 켜진 프로젝트(scanBasePackages에 "kr.co.koscom.pb") 기준이다:
 * 예외는 Controller 밖으로 나오지 않고 오류 응답(data null, 헤더 msgCode)으로 반환된다.
 * 꺼진 프로젝트라면 예외 케이스를 assertThrows(PBOnlineException.class, ...)로 단언한다.
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
        // 페이징 대상이면 여기서 req.setFixedPagingInfo(paging)로 넣는다. 별도 객체를 saveToRequestScope()하면 Aspect가 덮어쓴다.
        return req;
    }

    private AccountOut account(String accountNo, String name, BigDecimal balance) {
        AccountOut out = new AccountOut();
        out.setAccountNo(accountNo);
        out.setAccountName(name);
        out.setBalance(balance);
        return out;
    }

    // [요구사항] <요구사항 항목 또는 ID와 원문 한 줄>
    // [시나리오] 정상 1: 기본 경로, 응답 본문 검증
    // [기대] <요구사항이 말하는 결과(반환값·예외·호출)>
    @Test
    void sonaq001_normal1() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenReturn(account("1234567890", "홍길동", new BigDecimal("1000")));

        PBResponse<SONAQ001Out> res = target.sonaq001(request("1234567890"));

        assertEquals("1234567890", res.getData().getInner().getAccountNo());
        assertEquals("홍길동", res.getData().getInner().getAccountName());
        verify(accountBSM).getAccount(any(AccountIn.class));
    }

    // [요구사항] <요구사항 항목 또는 ID와 원문 한 줄>
    // [시나리오] 정상 2: 정상 1과 다른 입력·값
    // [기대] <요구사항이 말하는 결과(반환값·예외·호출)>
    @Test
    void sonaq001_normal2() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenReturn(account("9876543210", "김철수", BigDecimal.ZERO));

        PBResponse<SONAQ001Out> res = target.sonaq001(request("9876543210"));

        assertEquals("9876543210", res.getData().getInner().getAccountNo());
        assertEquals(BigDecimal.ZERO, res.getData().getInner().getBalance());
    }

    // [요구사항] <요구사항 항목 또는 ID와 원문 한 줄>
    // [시나리오] 경계값: 빈 계좌번호 — 조회 결과 없음(1001) 오류 응답
    // [기대] <요구사항이 말하는 결과(반환값·예외·호출)>
    @Test
    void sonaq001_boundary() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenReturn(null);

        PBResponse<SONAQ001Out> res = target.sonaq001(request(""));

        assertNull(res.getData());
        assertEquals("1001", res.getCommonHeader().getMsgCode());
    }

    // [요구사항] <요구사항 항목 또는 ID와 원문 한 줄>
    // [시나리오] 예외: BSM이 null을 돌려주면 PBOnlineException(1001)이 오류 응답으로 반환된다
    // [기대] <요구사항이 말하는 결과(반환값·예외·호출)>
    @Test
    void sonaq001_exception() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenReturn(null);

        PBResponse<SONAQ001Out> res = target.sonaq001(request("1234567890"));

        assertNull(res.getData()); // assertThrows가 아니다: 예외는 Controller 밖으로 나오지 않는다
        assertEquals("1001", res.getCommonHeader().getMsgCode());
        verify(accountBSM).getAccount(any(AccountIn.class));
    }

    // [요구사항] <요구사항 항목 또는 ID와 원문 한 줄>
    // [시나리오] 예외: BSM 런타임 예외는 기본 오류 코드 9000 응답이 된다
    // [기대] <요구사항이 말하는 결과(반환값·예외·호출)>
    @Test
    void sonaq001_exception2() {
        when(accountBSM.getAccount(any(AccountIn.class))).thenThrow(new RuntimeException("db down"));

        PBResponse<SONAQ001Out> res = target.sonaq001(request("1234567890"));

        assertNull(res.getData());
        assertEquals("9000", res.getCommonHeader().getMsgCode());
    }
}
