package {PackagePath}.mapper;

import java.util.List;

import org.apache.ibatis.annotations.Mapper;

import kr.co.openlabs.fico.framework.model.PagingInfo;
import {PackagePath}.model.dto.{MethodName}Parameter;
import {PackagePath}.model.dto.{MethodName}Result;

/**
 * {EntityName} Mapper Interface
 *
 * @author FICO AI
 * @since {CurrentDate}
 */
@Mapper
public interface {EntityName}Mapper {

    /**
     * {QueryDescription}
     *
     * @param param {MethodName}Parameter
     * @param pagingInfo PagingInfo
     * @return List<{MethodName}Result>
     */
    List<{MethodName}Result> {methodName}({MethodName}Parameter param, PagingInfo pagingInfo);

}
