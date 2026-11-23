package {PackagePath}.controller;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

import kr.co.koscom.pb.framework.site.ext.model.fixed.PBRequest;
import kr.co.koscom.pb.framework.site.ext.model.fixed.PBResponse;
import {PackagePath}.model.vo.{ServiceId}In;
import {PackagePath}.model.vo.{ServiceId}Out;
import {PackagePath}.service.{ServiceId}Service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 제목 : {ServiceKoreanName} Controller
 *
 * @author {AuthorName}
 * @since {CurrentDate}
 *
 * <pre>{@code
 * 서비스아이디 : {ServiceId}Controller
 * 서비스한글명 : {ServiceKoreanName} 컨트롤러
 * 설 명 : {ServiceDescription}
 *
 * [API 엔드포인트]
 * - POST /{Collection}/{ServiceId} : {ServiceKoreanName}
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
@RestController
@RequiredArgsConstructor
@Tag(name = "{ServiceId} {ServiceKoreanName}", description = "{ServiceDescription}")
public class {ServiceId}Controller {

    private final {ServiceId}Service {serviceId}Service;

    /**
     * {ServiceKoreanName} API
     *
     * <pre>
     * 서비스아이디 : {ServiceId}
     * 서비스한글명 : {ServiceKoreanName}
     * 설 명 : {ServiceDescription}
     * </pre>
     *
     * @param param PBRequest<{ServiceId}In> 요청 파라미터
     * @return PBResponse<{ServiceId}Out> 응답 데이터
     */
    @PostMapping(value = "/{Collection}/{ServiceId}")
    @Operation(summary = "{ServiceKoreanName}", description = "{ServiceDescription}")
    public PBResponse<{ServiceId}Out> {serviceId}(@RequestBody PBRequest<{ServiceId}In> param) {
        {ServiceId}Out result = {serviceId}Service.{serviceId}(param.getData());
        return PBResponse.success(param.getCommonHeader(), result);
    }
}
