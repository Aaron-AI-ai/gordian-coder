# BeanUtils User Guide

## Overview

`BeanUtils` is a common utility class provided by the FICO framework.
It offers a thin wrapper around the Spring `ApplicationContext` so business code can resolve Spring-managed beans without holding an explicit reference to the context.

- Package: `kr.co.openlabs.fico.framework.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.openlabs.fico.framework.utils.BeanUtils;
```

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. Spring bean lookup

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Get a Spring-managed bean by its class type", "Need to resolve a bean from a non-Spring-managed class (utility, static helper, etc.)" | [`getBean`](#getbeanclasst-classtype) |

> 💡 **What is NOT in BeanUtils' scope?** Bean creation, scope management, dependency injection configuration, and qualifier-based lookup are not the role of this utility. Use Spring's `@Autowired` / `ApplicationContext` directly when those features are needed.

---

## 1. Spring Bean Lookup

### `getBean(Class<T> classType)`

Looks up a Spring-managed bean of the given class type from the application context.

Internally resolves the framework's `ApplicationContext` through `FicoApplicationContextProvider.getContext()` and delegates to `ApplicationContext.getBean(Class)`.

**When to use:**
- When a static method or other non-Spring-managed class needs to use a Spring bean
- When you cannot inject a bean via `@Autowired` (e.g., utility class, factory method)

```java
ClientConfiguration clientConfiguration =
        BeanUtils.getBean(ClientConfiguration.class);
```

| Parameter | Description |
|-----------|-------------|
| `classType` | Target bean class type |

| Returns | Description |
|---------|-------------|
| `T` | Bean instance of the given type |
