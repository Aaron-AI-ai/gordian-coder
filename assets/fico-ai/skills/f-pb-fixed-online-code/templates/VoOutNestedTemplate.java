package {PackagePath}.model.vo;

import io.swagger.v3.oas.annotations.media.Schema;

import kr.co.openlabs.fico.framework.internal.annotations.FixedData;
import kr.co.openlabs.fico.framework.internal.annotations.FixedData.PAD_TYPE;
import kr.co.openlabs.fico.framework.internal.annotations.FixedList;
import kr.co.openlabs.fico.framework.internal.annotations.FixedVo;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * {ServiceKoreanName} Output VO
 *
 * @author FICO AI
 * @since {CurrentDate}
 */
@Data
@NoArgsConstructor
@Schema(description = "{ServiceKoreanName} 응답")
public class {ServiceId}Out {

    @FixedVo
    private Inner inner;

    @Data
    @Builder
    @AllArgsConstructor
    @NoArgsConstructor
    public static class Inner {

        @Schema(description = "{Description}")
        @FixedData(length = {Length}, padType = PAD_TYPE.{PadType}, padChar = '{PadChar}')
        private String {FieldName};

        @Schema(description = "{Description}")
        @FixedVo
        private {ServiceId}{FieldName} {FieldName};

        @Schema(description = "{Description}")
        @FixedList(size = {Size})
        private List<{ServiceId}{FieldName}> {FieldName};

    }

    @Data
    @Builder
    @AllArgsConstructor
    @NoArgsConstructor
    public static class {ServiceId}{FieldName} {

        @Schema(description = "{Description}")
        @FixedData(length = {Length}, padType = PAD_TYPE.{PadType}, padChar = '{PadChar}')
        private String {FieldName};

    }

    @Data
    @Builder
    @AllArgsConstructor
    @NoArgsConstructor
    public static class {ServiceId}{FieldName} {

        @Schema(description = "{Description}")
        @FixedData(length = {Length}, padType = PAD_TYPE.{PadType}, padChar = '{PadChar}')
        private String {FieldName};

    }

}
