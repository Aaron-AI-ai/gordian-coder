# PBCommonUtils User Guide

## Overview

`PBCommonUtils` is a common utility class provided by the PB (PowerBase) framework.
It offers features frequently used by business services such as PB fixed-length message response composition, environment detection, message resolution, time formatting, and VO meta-information lookup.

- Package: `kr.co.koscom.pb.framework.site.ext.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.koscom.pb.framework.site.ext.utils.PBCommonUtils;
```

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. Response message configuration

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Set a custom response message in a business Service", "Compose response message using developer-provided data" | [`setResponseMessage`](#setresponsemessagestring-msgcode-string-args) |
| "Set response message using only a message code" | [`resolveVarMsg`](#resolvevarmsgstring-msgcode-string-args) |
| "Create an error response from exception info when an Exception occurs" | [`createErrorResponse`](#2-error-response-composition) |

### B. Environment context lookup

| Situation | Function |
|-----------|----------|
| "Check whether the environment is production", "Branch logic by production vs. non-production" | [`isProduct`](#5-environmentprofile-detection) |
| "Check whether the environment is development/staging/test" | [`isDevelop`](#5-environmentprofile-detection) |
| "Check whether running as an online service" | [`isOnline`](#4-execution-environment-detection), [`getOnlineEnvFlag`](#4-execution-environment-detection) |

### C. PB environment settings (firm number, HTS verification, etc.)

| Situation | Function |
|-----------|----------|
| "Look up the firm number of the current system (not the header value; configuration value)" | [`getFirmNo`](#getfirmno--getfirmnum), [`getFirmNum`](#getfirmno--getfirmnum) |
| "Check whether HTS-owned-account verification is enabled" | [`getHtsAcntVerifyTp`](#gethtsacntverifytp) |

### D. System time string generation

| Situation | Function |
|-----------|----------|
| "Get current time in a specific format such as `YYYYMMDD`, `YYYYMMDDhhmmss`, `hhmmssccc`" | [`getSysTimeStr`](#getsystimestrstring-format) |

### E. Looking up maximum count of a message class (VO Class) array (repeating group)

| Situation | Function |
|-----------|----------|
| "Get the `@FixedList(size=N)` value defined on a target message class (VO Class) at runtime", "Need the List field count of a target message class (VO Class)" | [`getMaxSize`](#8-vo-array-max-count-lookup) |

### F. Setting account number for transaction log (txnlog)

| Situation | Function |
|-----------|----------|
| "Reflect the account number processed in a Service into txnlog automatically", "Need to add the account number to the audit log because it is missing" | [`setAccountNo`](#3-account-number-storage-for-transaction-log) |
| "Look up the stored account number (for logging or downstream processing)" | [`getAccountNo`](#3-account-number-storage-for-transaction-log) |

### G. Computing a string's byte length (for fixed-length message size)

| Situation | Function |
|-----------|----------|
| "Need to compute the fixed-message VarMsg length", "Need a byte length based on the Content-Type charset" | [`getVarMsgByteLength`](#getvarmsgbytelengthstring-text) |

> 💡 **What is NOT in PBCommonUtils' scope?** General string/date/number conversion, bean mapping, DB access, and logging output are not the role of this utility. If no row above matches, look for another component.

---

## 1. Response Message Configuration

### `setResponseMessage(String msgCode, String... args)`

Sets a custom response message from a business Service.

> ⚠️ **Online (HTTP request) environment only.** Because it stores values in the `RequestScope`, it does not take effect in batch/queue-daemon contexts.
> If you only need the message text in a batch/daemon context, use [`resolveVarMsg`](#resolvevarmsgstring-msgcode-string-args) instead.

```java
// In a Service:
PBCommonUtils.setResponseMessage("0136", "Account");
// → On success(): msgCode="0136", VarMsg="Account lookup completed."
```

| Parameter | Description |
|-----------|-------------|
| `msgCode` | Message code (`COM_MSG.MSG_ID`, 4-digit numeric) |
| `args`    | Substitution parameters |

---

### `resolveVarMsg(String msgCode, String... args)`

Resolves a message text via the message code.

Looks up the message text from the `COM_MSG` DB table and returns it in VarMsg format.
Used by `PBResponse.success()` when resolving the default success message.

Legacy mapping: equivalent to `SetMsgCode("MSG_0000")` in APS, which queries `BP_TBC_MSG`.

```java
// Message code with no placeholders
String msg1 = PBCommonUtils.resolveVarMsg("0000");
// COM_MSG 0000 = "Processed successfully."
// → "Processed successfully."

// Message code with one placeholder
String msg2 = PBCommonUtils.resolveVarMsg("0136", "Account");
// COM_MSG 0136 = "{0} lookup completed."
// → "Account lookup completed."

// Message code with multiple placeholders
String msg3 = PBCommonUtils.resolveVarMsg("0200", "John Doe", "12345");
// COM_MSG 0200 = "Mr. {0}, transaction {1} processed."
// → "Mr. John Doe, transaction 12345 processed."
```

| Parameter | Description |
|-----------|-------------|
| `msgCode` | Message code (`COM_MSG.MSG_ID`) |
| `args`    | Substitution parameters |

| Returns | Description |
|---------|-------------|
| `String` | VarMsg text; `null` if resolution fails |

---

## 2. Error Response Composition

### `createErrorResponse(PBFixedHeader requestHeader, CommonException e)`

Creates an error response from a `CommonException`.

**When to use:**
- When the caught exception belongs to the `CommonException` family (`PBOnlineException`, `PBModuleException`, etc.)
- When you need to accurately reflect the **deliberately thrown** business exception's error code, substitution args, `msgLvl`, and `fstErrPsit` into the response
- Inside an `@ExceptionHandler(CommonException.class)` handler

**Behavior:**
1. Convert error code → 4-digit fixed-header `msgCode` (falls back to `9000` if not a 4-digit number)
2. Resolve message text from `COM_MSG` (through `MessageUtils`, with `e.getArgs()` as substitution args)
3. If it is a `PBOnlineException`, extract `msgLvl`/`fstErrPsit` (otherwise `"P"` / `null`)
4. Build the `PBResponse` error response

**Usage**

```java
try {
    // business logic
} catch (CommonException e) {
    return PBCommonUtils.createErrorResponse(header, e);
}
```

| Parameter | Description |
|-----------|-------------|
| `requestHeader` | Request header |
| `e`             | `CommonException` (or `PBOnlineException`) |

| Returns | Description |
|---------|-------------|
| `PBResponse<?>` | Error response |

---

### `createErrorResponse(PBFixedHeader requestHeader, Exception e)`

Creates an error response from a general `Exception`.

**When to use:**
- When the caught exception is **not** a `CommonException` (e.g., `NullPointerException`, `SQLException`, `RuntimeException`)
- When unexpected system errors need to fall back to a consistent `9000` response
- Inside an `@ExceptionHandler(Exception.class)` **catch-all handler (final safety net)**

**Behavior:**
1. `msgCode` is always `DEFAULT_ERROR_CODE = "9000"`
2. Resolve message from the `COM_MSG` `9000` template using `e.getMessage()` as the substitution arg
3. `msgLvl="P"`, `fstErrPsit=null` are fixed
4. Build the `PBResponse` error response

**Usage**

```java
try {
    // business logic
} catch (Exception e) {
    return PBCommonUtils.createErrorResponse(header, e);
}
```

| Parameter | Description |
|-----------|-------------|
| `requestHeader` | Request header |
| `e`             | A general `Exception` |

| Returns | Description |
|---------|-------------|
| `PBResponse<?>` | Error response |


---

## 3. Account Number Storage (for Transaction Log)

### `setAccountNo(String accountNo)`

The stored account number is automatically reflected when writing the transaction log (txnlog).

```java
// In a Service:
PBCommonUtils.setAccountNo("12345678901");
```

| Parameter | Description |
|-----------|-------------|
| `accountNo` | Account number |

---

### `getAccountNo()`

Looks up the account number stored via `setAccountNo`.

```java
String accountNo = PBCommonUtils.getAccountNo();
```

| Returns | Description |
|---------|-------------|
| `String` | Account number; `null` if not set |

---

## 4. Execution Environment Detection

### `isOnline()`

Checks whether the current environment is online.

```java
if (PBCommonUtils.isOnline()) {
    // HTTP request context
}
```

| Returns | Description |
|---------|-------------|
| `boolean` | `true` if online (HTTP request) context; `false` if daemon/batch |

---

### `getOnlineEnvFlag()`

Returns the online-environment flag.

```java
int envFlag = PBCommonUtils.getOnlineEnvFlag();   // 1 or 0
```

| Returns | Description |
|---------|-------------|
| `int` | `1` = online, `0` = daemon/batch |

---

## 5. Environment (Profile) Detection

### `isProduct()`

Checks whether the environment is production.

PB legacy mapping: `IsProduct()` — TRUE when `RUN_DEV='R'`

```java
if (PBCommonUtils.isProduct()) {
    smsService.send(phoneNo, content);
}
```

| Returns | Description |
|---------|-------------|
| `boolean` | `true` if production environment |

---

### `isDevelop()`

Checks whether the environment is development.

If the profile is not production (`prod`), it is regarded as development.

PB legacy mapping: `IsDevelop()` — TRUE when `RUN_DEV='D'`

```java
if (PBCommonUtils.isDevelop()) {
    log.debug("[DEV] {}", message);
}
```

| Returns | Description |
|---------|-------------|
| `boolean` | `true` if development environment |

---

## 6. PB Environment Configuration Lookup (`pb.env.*`)

### `getHtsAcntVerifyTp()`

Looks up the in-house HTS owned-account verification setting.

PB legacy mapping: `GetHtsAcntVerifyTp()` — `[COMMON].[HTS_ACNT_VERIFY_TP]`

```java
if (PBCommonUtils.getHtsAcntVerifyTp() == 1) {
    // Perform HTS owned-account verification
}
```

| Returns | Description |
|---------|-------------|
| `int` | `0`: disabled (default), `1`: enabled |

---

### `getFirmNo()`

Looks up the firm number (configuration value).

Reads the firm number from the application's environment configuration.
Unlike the per-request header value, this is a fixed value across the entire application.

```java
String firmNo = PBCommonUtils.getFirmNo();   // "001"
```

| Returns | Description |
|---------|-------------|
| `String` | Firm number string; empty string if not set |

---

### `getFirmNum()`

Looks up the firm number as an integer (configuration value).

```java
int firmNum = PBCommonUtils.getFirmNum();    // 1
```

| Returns | Description |
|---------|-------------|
| `int` | Firm number as integer; `0` if not convertible |

---

## 7. System Time Formatting

### `getSysTimeStr(String format)`

Returns the current system time formatted by the given format string.

Format tokens:
`YYYY` (4-digit year), `YY` (2-digit year), `MM` (month), `DD` (day),
`hh` (hour), `mm` (minute), `ss` (second), `c` (microsecond; output digits equal to the number of consecutive `c`s)

```java
PBCommonUtils.getSysTimeStr("YYYYMMDD");           // "20260406"
PBCommonUtils.getSysTimeStr("YYYYMMDDhhmmssccc");  // "20260406143045123"
PBCommonUtils.getSysTimeStr("hhmmssccc");          // "143045123"
```

| Parameter | Description |
|-----------|-------------|
| `format` | Time format string |

| Returns | Description |
|---------|-------------|
| `String` | Time string converted according to the format |

---

## 8. VO Array Max Count Lookup

### `getMaxSize(Class<?> voClass, String listFieldName)`

Looks up the max count defined on a List field of a VO class.

```java
public class AcntListVo {
    @FixedList(size = 50)
    private List<AcntItem> acntList;
}

int max = PBCommonUtils.getMaxSize(AcntListVo.class, "acntList");   // 50
```

| Parameter | Description |
|-----------|-------------|
| `voClass`        | VO class |
| `listFieldName`  | Name of the List field |

| Returns | Description |
|---------|-------------|
| `int` | `@FixedList(size)` value; `-1` if not set |

---

### `getMaxSize(Object vo, String listFieldName)`

Looks up the max count defined on a List field of a VO instance.

```java
int max = PBCommonUtils.getMaxSize(voInstance, "acntList");         // 50
```

| Parameter | Description |
|-----------|-------------|
| `vo`             | VO instance |
| `listFieldName`  | Name of the List field |

| Returns | Description |
|---------|-------------|
| `int` | `@FixedList(size)` value; `-1` if not set |

---

## 9. Charset / VarMsg Byte Length

### `setDefaultCharset(String charsetName)`

Sets the default charset (called from `PBWebConfig`).

| Parameter | Description |
|-----------|-------------|
| `charsetName` | Charset name (e.g., `"UTF-8"`, `"EUC-KR"`) |

---

### `getVarMsgByteLength(String text)`

Computes the byte length of a VarMsg string.

```java
int len = PBCommonUtils.getVarMsgByteLength("Hello");
// UTF-8: 5
```

| Parameter | Description |
|-----------|-------------|
| `text` | Target string |

| Returns | Description |
|---------|-------------|
| `int` | Byte length; `0` if `null` |
