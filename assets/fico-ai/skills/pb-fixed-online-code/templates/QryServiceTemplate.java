package {PackagePath}.service;

import kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException;
import kr.co.koscom.pb.framework.site.ext.utils.PBCommonUtils;
import {PackagePath}.model.vo.{ServiceId}In;
import {PackagePath}.model.vo.{ServiceId}Out;

import lombok.extern.slf4j.Slf4j;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 제목 : {ServiceKoreanName} 서비스
 *
 * @author {AuthorName}
 * @since {CurrentDate}
 *
 * <pre>{@code
 * 서비스아이디 : {ServiceId}Service
 * 서비스한글명 : {ServiceKoreanName} 서비스
 * 설 명 : {ServiceDescription}
 *
 * =================================================================================================
 * <<< 프로그램 변경 정보 >>>
 * -------------------------------------------------------------------------------------------------
 * 변경 일자 : 변경자 : 변경 내역
 * -------------------------------------------------------------------------------------------------
 * {CurrentDate} : {AuthorName} : {ChangeDescription}
 * =================================================================================================
 * }</pre>
 */
@Slf4j
@Service
public class {ServiceId}Service {

    @Autowired
    private {DependencyType} {dependencyName};

    private void preprocess() {
        /* ------------- 업무 전처리 로직 구현 부 - 시작 ------------- */

        /* ------------- 업무 전처리 로직 구현 부 - 종료 ------------- */
    }

    private void checkParameter({ServiceId}In param) {
        /* ------------- 입력 파라미터 체크 로직 구현 부 - 시작 ------------- */

        /* ------------- 입력 파라미터 체크 로직 구현 부 - 종료 ------------- */
    }

    private void postprocess() {
        /* ------------- 업무 후처리 로직 구현 부 - 시작 ------------- */

        /* ------------- 업무 후처리 로직 구현 부 - 종료 ------------- */
    }

    /**
     * 메인 비즈니스 로직 구현
     *
     * @param param {ServiceKoreanName} 요청 정보
     * @return {ServiceKoreanName} 결과 ({ServiceId}Out)
     */
    @Transactional(readOnly = true)
    public {ServiceId}Out {serviceId}({ServiceId}In param) {
        preprocess();
        checkParameter(param);

        /* ------------- 업무 로직 구현 부 - 시작 ------------- */

        // TODO: 업무 로직 구현 (입력값은 param.getInner().getXxx() 로 접근)

        {ServiceId}Out result = new {ServiceId}Out();
        result.setInner({ServiceId}Out.Inner.builder()
                .build());

        /* ------------- 업무 로직 구현 부 - 종료 ------------- */

        PBCommonUtils.setResponseMessage("{ResponseMessageCode}");
        postprocess();

        return result;
    }
}
