package {PackagePath}.mapper;

import org.apache.ibatis.annotations.Mapper;

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
     * @return {ReturnType}
     */
    {ReturnType} {methodName}({MethodName}Parameter param);

}
