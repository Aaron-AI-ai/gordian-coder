---
exceptions: "*HttpMessageNotReadableException", "*HttpMessageNotWritableException", "*CharacterCodingException", "*MalformedInputException", "*CubeOneCryptoException"
---
#### 고정길이 전문 파싱 (`PBFixedDataConverter`, 에러코드 9604)
- charset: Content-Type의 charset 최우선, 없으면 converter 설정값. 바이트 길이 기준이라 한글 길이 계산이 틀리면 뒤 필드가 전부 밀린다.
- 헤더는 `PBFixedHeader.HEADER_LENGTH`바이트 고정 — body 시작 오프셋(`dataOfst`)이 헤더 값과 다르면 파싱 실패.
- In VO의 `@FixedData/@FixedString/@FixedList/@FixedLong` 길이 합이 전문 길이와 맞아야 한다. 필드 하나의 길이 오타가 전체를 깨뜨린다.
- 헤더 `cmprTp`(압축) → `PayloadCompressionHandler`, `encrpTp`(암호화) → CubeOne. 이 두 값이 요청과 실제 페이로드 상태와 다르면 복호화/압축 해제 단계에서 난다.
- 저널 로그 `PHASE_ERROR`에는 `errorType`/`errorMessage`만 남는다 — 스택이 없으면 여기서 온 로그다.

확인 절차
1. URI로 컨트롤러를 찾고(`f_log_search` `@PostMapping`) In VO 클래스를 연다(`f_log_read`).
2. VO의 `@Fixed*` 길이를 합산해 전문 길이와 비교한다.
3. `f_log_search`로 `charset`이 설정되는 곳(`PBFixedDataConverter`, `application*.yml`)을 확인한다.
4. 스택이 없고 `PHASE_ERROR` 저널만 있으면 `f_log_search`로 그 저널을 남기는 코드 위치를 찾아 `errorType`을 확인한다.
