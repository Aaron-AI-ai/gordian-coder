# RequestScopeUtils User Guide

## Overview

`RequestScopeUtils` is a common utility class provided by the FICO framework.
It provides a unified store for per-call state: if the current thread is processing an HTTP request, values are kept in Spring's `RequestAttributes` (request scope); otherwise they fall back to a thread-local `ThreadRepository`. This lets the same code work in both online (HTTP) and batch/daemon contexts.

- Package: `kr.co.openlabs.fico.framework.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.openlabs.fico.framework.utils.RequestScopeUtils;
```

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. Per-call attribute storage

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Store a value scoped to the current HTTP request, falling back to thread-local if outside a request" | [`setAttribute`](#setattributestring-name-object-object) |
| "Read a value stored via `setAttribute` (HTTP request scope or thread-local fallback)" | [`getAttribute`](#getattributestring-name) |
| "Remove a single stored attribute" | [`removeAttribute`](#removeattributestring-name) |
| "Clear all attributes from the thread-local store (does not affect request scope)" | [`removeAllAttribute`](#removeallattribute) |

### B. Raw `HttpServletRequest` access

| Situation | Function |
|-----------|----------|
| "Get the underlying `ServletRequestAttributes` / `HttpServletRequest` of the current call" | [`getServletRequestAttributes`](#getservletrequestattributes) |

> 💡 **What is NOT in RequestScopeUtils' scope?** Session-scoped storage, distributed-state cache, persistent storage, and inter-thread propagation are not the role of this utility. The fallback `ThreadRepository` is per-thread — values do not propagate to child threads.

---

## 1. Per-Call Attribute Storage

### `setAttribute(String name, Object object)`

Stores an object under `name` for the current call.

- If a Spring `RequestAttributes` exists (i.e., inside an HTTP request), stores it in `SCOPE_REQUEST`.
- Otherwise, stores it in the thread-local `ThreadRepository`.

```java
RequestScopeUtils.setAttribute(ONLINE_START_TIME_KEY, startTime);
```

| Parameter | Description |
|-----------|-------------|
| `name`   | Attribute key |
| `object` | Value to store |

---

### `getAttribute(String name)`

Looks up an attribute previously stored under `name`.

- Reads from `RequestAttributes` (request scope) if available.
- Falls back to thread-local `ThreadRepository` otherwise.

```java
Integer timeout = (Integer) RequestScopeUtils.getAttribute(ONLINE_TIMEOUT_KEY);
```

| Parameter | Description |
|-----------|-------------|
| `name` | Attribute key |

| Returns | Description |
|---------|-------------|
| `Object` | Stored value; `null` if not set |

---

### `removeAttribute(String name)`

Removes the attribute stored under `name` from whichever store currently holds it (request scope first, then thread-local fallback).

```java
RequestScopeUtils.removeAttribute(ONLINE_START_TIME_KEY);
```

| Parameter | Description |
|-----------|-------------|
| `name` | Attribute key |

---

### `removeAllAttribute()`

Clears **all** attributes from the thread-local `ThreadRepository`. Has no effect on request-scope attributes.

```java
RequestScopeUtils.removeAllAttribute();
```

---

## 2. Raw HttpServletRequest Access

### `getServletRequestAttributes()`

Returns the Spring `ServletRequestAttributes` for the current call, from which `HttpServletRequest` / `HttpServletResponse` can be obtained.

```java
HttpServletRequest request = RequestScopeUtils.getServletRequestAttributes().getRequest();
```

| Returns | Description |
|---------|-------------|
| `ServletRequestAttributes` | Current request attributes |

Throws `IllegalStateException` if called outside of an HTTP request context.
