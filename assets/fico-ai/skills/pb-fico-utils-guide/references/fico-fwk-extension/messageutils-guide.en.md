# MessageUtils User Guide

## Overview

`MessageUtils` is a common message utility class provided by the fico-fwk-extension framework.
It resolves localized text from the application's `MessageSource` (specifically the `dbMessageSource` bean), substituting placeholders with provided arguments.

- Package: `kr.co.openlabs.fico.framework.extension.utils`
- All public lookup methods are `static`
- The underlying `MessageSource` is injected once at startup via Spring DI (`@Autowired` setter, `@Qualifier("dbMessageSource")`)

```java
import kr.co.openlabs.fico.framework.extension.utils.MessageUtils;
```

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. Resolving a message by code

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Resolve a localized message in the request's current locale (most common case)", "Get a message text inside a Service" | [`getMessage(String, String...)`](#getmessagestring-code-string-args) |
| "Resolve a message in a specific locale (override the request locale)", "Generate text in a non-default language for batch / email / push" | [`getMessage(String, Locale, String...)`](#getmessagestring-code-locale-locale-string-args) |

> 💡 **What is NOT in MessageUtils' scope?** Message *registration*, `MessageSource` bean wiring, or persisting messages to the DB are not the role of this utility. It is a thin static accessor over `dbMessageSource`.

---

## 1. Message Resolution

Both `getMessage(...)` overloads delegate to the underlying `MessageSource` (qualifier: `dbMessageSource`).
The DB-backed `MessageSource` looks up the message text for the given code, substitutes positional arguments (`{0}`, `{1}`, ...), and returns the result for the chosen locale.

If the code is not registered, the underlying `MessageSource` will throw `NoSuchMessageException` per Spring's default contract.

---

### `getMessage(String code, String... args)`

Resolves a message in the **current request locale**.

The locale is obtained from `LocaleContextHolder.getLocale()`. When no custom `LocaleResolver` is registered, Spring Boot defaults to `AcceptHeaderLocaleResolver` — i.e., the locale derived from the `Accept-Language` HTTP header.

```java
String msg = MessageUtils.getMessage("FWKE0001", "test");
// Template: "{0} 처리중 오류가 발생했습니다."
// → "test 처리중 오류가 발생했습니다."
```

| Parameter | Description |
|-----------|-------------|
| `code`    | Message code registered in the DB-backed `MessageSource` |
| `args`    | Positional substitution parameters for `{0}`, `{1}`, ... |

| Returns | Description |
|---------|-------------|
| `String` | Localized message text with arguments substituted |

---

### `getMessage(String code, Locale locale, String... args)`

Resolves a message in an **explicitly specified locale**.

Use this overload when the request-scoped locale should not (or cannot) be used — e.g., generating notifications in a fixed language regardless of the caller's `Accept-Language`, or inside batch / daemon contexts where there is no request locale.

```java
String msgKo = MessageUtils.getMessage("FWKE0001", new Locale("ko"), "test");
// → "test 처리중 오류가 발생했습니다."

String msgEn = MessageUtils.getMessage("FWKE0001", Locale.ENGLISH, "test");
// → "Error occurred while processing test."
```

| Parameter | Description |
|-----------|-------------|
| `code`    | Message code |
| `locale`  | Target locale |
| `args`    | Positional substitution parameters |

| Returns | Description |
|---------|-------------|
| `String` | Localized message text in the specified locale |

---

## Notes

- `setMessageSource(MessageSource)` is an internal Spring DI hook (`@Autowired`) injected with the `dbMessageSource` bean. It is **not** intended to be called from application code.
- Because `MessageUtils` holds the injected `MessageSource` in a `static` field, all callers share the same bean. There is no thread-safety concern, as `MessageSource` implementations are required to be thread-safe.
