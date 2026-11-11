# CommonUtils User Guide

## Overview

`CommonUtils` is a common utility class provided by the fico-fwk-extension framework.
It offers features frequently used by business services such as `CommonResponse` composition, response message configuration, and GUID (TraceId-compatible) generation.

- Package: `kr.co.openlabs.fico.framework.extension.utils`
- All methods are `static`; no instantiation required (`@UtilityClass`)

```java
import kr.co.openlabs.fico.framework.extension.utils.CommonUtils;
```

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. Response object composition

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Wrap business data into a `CommonResponse` and return it from a Service/Controller" | [`createCommonResponse(T)`](#createcommonresponset-data) |
| "Build a response that reuses the `CommonHeader` from the incoming `CommonRequest`" | [`createCommonResponse(CommonRequest, T)`](#createcommonresponsecommonrequest-request-t-data) |
| "Return a response containing only the header (no data payload)" | [`createCommonResponse(CommonRequest)`](#createcommonresponsecommonrequest-request) |

### B. Response message configuration

| Situation | Function |
|-----------|----------|
| "Set a custom response message directly on a specific `CommonResponse` object" | [`setResponseMessage(CommonResponse, ...)`](#setresponsemessagecommonresponset-commonresponse-boolean-issucess-string-code-string-args) |
| "Set the response message inside a Service and have the next `createCommonResponse` pick it up automatically" | [`setResponseMessage(boolean, ...)`](#setresponsemessageboolean-issucess-string-code-string-args) |

### C. GUID / TraceId-compatible identifier generation

| Situation | Function |
|-----------|----------|
| "Generate a 32-byte HEX GUID compatible with the OpenTelemetry TraceId propagator", "Need a system-unique identifier carrying a 3-digit category prefix" | [`generateGuid`](#generateguidinteger-prefix) |

> 💡 **What is NOT in CommonUtils' scope?** Generic string/date conversion, validation, DB access, and exception handling are not the role of this utility. Use `StringUtils`, `DateUtils`, `MessageUtils`, etc. for those concerns.

---

## 1. CommonResponse Creation

All `createCommonResponse(...)` overloads internally call `setResponseInfo()`, which:

1. Reads the current `CommonRequest` from `RequestScope` (key: `CommonRequest.COMMON_REQUEST_KEY`).
2. If the response has no `CommonHeader`, copies the one from the request.
3. Reads `ResponseMessage` from `RequestScope` (key: `RESPONSE_MESSAGE_KEY`) — populated by [`setResponseMessage(boolean, ...)`](#setresponsemessageboolean-issucess-string-code-string-args).
4. If no message has been set, applies a **default success message** based on paging state:
   - `BIZM0003` ("조회가 계속됩니다.") — when `pagingInfo.hasNextPage == true`
   - `BIZM0002` ("조회가 완료되었습니다.") — when `pagingInfo` exists and no next page
   - `BIZM0001` ("처리되었습니다.") — when there is no paging info

> ⚠️ Steps 1–4 only run when a `CommonRequest` exists in scope (i.e., online HTTP request context). In batch/daemon contexts the response is returned as-built.

---

### `createCommonResponse(T data)`

Creates a `CommonResponse` containing the given data payload.

The `CommonHeader` and `ResponseMessage` are populated automatically from request scope per the rules above.

```java
// In a Service:
CommonResponse<String> response = CommonUtils.createCommonResponse("OK");
```

| Parameter | Description |
|-----------|-------------|
| `data`    | Response data payload |

| Returns | Description |
|---------|-------------|
| `CommonResponse<T>` | Response with `data` set; header/message populated from request scope |

---

### `createCommonResponse(CommonRequest<?> request, T data)`

Creates a `CommonResponse` using the `CommonHeader` of the given request and a data payload.

Use this overload when the request is explicitly available — e.g., outside an HTTP request scope, or when you prefer to be explicit instead of relying on scope lookup.

```java
CommonResponse<TestModel> response =
        CommonUtils.createCommonResponse(commonRequest, testModel);
```

| Parameter | Description |
|-----------|-------------|
| `request` | Originating `CommonRequest`; its `CommonHeader` is copied into the response |
| `data`    | Response data payload |

| Returns | Description |
|---------|-------------|
| `CommonResponse<T>` | Response with header from `request` and `data` set |

---

### `createCommonResponse(CommonRequest<?> request)`

Creates a `CommonResponse` carrying only the request's `CommonHeader` (no data payload).

Use this when the response is purely a status/acknowledgement that needs the request header echoed back.

```java
CommonResponse<Void> response = CommonUtils.createCommonResponse(commonRequest);
```

| Parameter | Description |
|-----------|-------------|
| `request` | Originating `CommonRequest` |

| Returns | Description |
|---------|-------------|
| `CommonResponse<T>` | Response with header from `request`, no data |

---

## 2. Response Message Configuration

### `setResponseMessage(CommonResponse<T> commonResponse, boolean isSucess, String code, String... args)`

Sets the response message **directly** on a specific `CommonResponse` instance.

Use this overload when the response object is already in hand and the message must be set explicitly (does not depend on `RequestScope`).

```java
CommonResponse<TestModel> response = CommonUtils.createCommonResponse(testModel);
CommonUtils.setResponseMessage(response, true, "BIZM0003");
```

**Behavior:**
1. If the response's `message` is `null`, builds a new `ResponseMessage` and attaches it.
2. Sets `code = code`.
3. Resolves the message text via `MessageUtils.getMessage(code, args)`.
4. Sets `successCd = 0` (when `isSucess == true`) or `1` (otherwise).

| Parameter | Description |
|-----------|-------------|
| `commonResponse` | Target `CommonResponse` instance |
| `isSucess` | Business success flag — `true` → `successCd=0`, `false` → `successCd=1` |
| `code`     | Message code (resolved via `MessageUtils` → `dbMessageSource`) |
| `args`     | Positional substitution parameters for the message template |

---

### `setResponseMessage(boolean isSucess, String code, String... args)`

Sets the response message in **request scope**, to be picked up by the next `createCommonResponse(...)` call.

> ⚠️ **Online (HTTP request) environment only.** Because it stores values in `RequestScope`, it has no effect in batch / daemon contexts. In those contexts, use the `(CommonResponse, ...)` overload above to set the message on the response object directly.

```java
// In a Service:
CommonUtils.setResponseMessage(true, "FWKE0001", "test");

// Later in the Controller:
return CommonUtils.createCommonResponse(result);
// → the message set above is applied to the response
```

**Behavior:**
1. Builds a `ResponseMessage` (`code`, resolved text via `MessageUtils.getMessage`, `successCd`).
2. Stores it in `RequestScope` under `RESPONSE_MESSAGE_KEY`.
3. `setResponseInfo` (invoked by `createCommonResponse`) reads it back and applies it to the response.

| Parameter | Description |
|-----------|-------------|
| `isSucess` | Business success flag — `true` → `successCd=0`, `false` → `successCd=1` |
| `code`     | Message code |
| `args`     | Positional substitution parameters |

---

## 3. GUID Generation

### `generateGuid(Integer prefix)`

Generates a 32-byte HEX GUID compatible with the OpenTelemetry `TraceId` propagator specification.

Composition: `prefix (3 digits)` + `current datetime (YYYYMMDDhh24miss + millisecond → 17 digits)` + `random alphanumerics (12 chars)` = **32 characters**.

```java
String guid = CommonUtils.generateGuid(123);
// e.g. "12320231213181757838afc2ab2b581f"
```

**Behavior:**
- If `prefix` is `null`, or its string length is not exactly 3, returns the invalid TraceId (`"00000000000000000000000000000000"`).
- Otherwise concatenates the prefix, current datetime (`YYYYMMDDhh24miss` + millisecond) and a 12-character random secret string.

| Parameter | Description |
|-----------|-------------|
| `prefix`  | A 3-digit integer used to distinguish GUIDs by purpose/system |

| Returns | Description |
|---------|-------------|
| `String` | 32-byte HEX string on success; `TraceId.getInvalid()` (`"00000000000000000000000000000000"`) on invalid prefix |
