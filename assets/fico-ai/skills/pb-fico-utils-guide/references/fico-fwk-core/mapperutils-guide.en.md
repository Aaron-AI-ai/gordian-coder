# MapperUtils User Guide

## Overview

`MapperUtils` is a common utility class provided by the FICO framework.
It wraps ModelMapper with `STRICT` matching to copy values between objects whose field names match — either same-name (camelCase ↔ camelCase) or underscore-to-camelCase mapping for DB-style sources.

- Package: `kr.co.openlabs.fico.framework.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.openlabs.fico.framework.utils.MapperUtils;
```

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. Object mapping (camelCase ↔ camelCase, same field names)

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Copy fields between two POJOs with matching camelCase names" | [`convert(Object source, Class<D> destinationType)`](#convertobject-source-classd-destinationtype) |
| "Copy fields into a target type whose generic type is captured by a `TypeToken`" | [`convert(Object source, Type destinationType)`](#convertobject-source-type-destinationtype) |
| "Copy fields into an **existing** destination instance" | [`convert(Object source, Object destinationObj)`](#convertobject-source-object-destinationobj) |
| "Convert a `List<S>` into a `List<D>` element-by-element" | [`convertList`](#convertlistlists-list-classd-destinationtype) |

### B. Underscore → CamelCase mapping (typical DB row → POJO)

| Situation | Function |
|-----------|----------|
| "Source uses `snake_case` (e.g., from a DB result) and target uses `camelCase`" | [`convertFromUnderscoreToCamel(Object source, Class<D> destinationType)`](#convertfromunderscoretocamelobject-source-classd-destinationtype) |
| "Same as above with a generic target captured by `TypeToken`" | [`convertFromUnderscoreToCamel(Object source, Type destinationType)`](#convertfromunderscoretocamelobject-source-type-destinationtype) |
| "Map a `snake_case` source into an existing `camelCase` destination instance" | [`convertFromUnderscoreToCamel(Object source, Object destinationObj)`](#convertfromunderscoretocamelobject-source-object-destinationobj) |
| "Convert a `List<S>` (snake_case) into a `List<D>` (camelCase)" | [`convertListFromUnderscoreToCamel`](#convertlistfromunderscoretocamellists-list-classd-destinationtype) |

> 💡 **What is NOT in MapperUtils' scope?** Custom type converters, field-level conditional mapping, deep-merge into populated targets, and validation are not the role of this utility. Use ModelMapper directly when those features are needed.

---

## 1. Same-Name Mapping (camelCase ↔ camelCase)

### `convert(Object source, Class<D> destinationType)`

Creates a new instance of `destinationType` and copies same-name fields from `source`. Uses `STRICT` matching — only exact name matches are copied.

```java
SampleModelToConvert converted =
        MapperUtils.convert(sampleModel, SampleModelToConvert.class);
```

| Parameter | Description |
|-----------|-------------|
| `source`          | Source object |
| `destinationType` | Target class |

| Returns | Description |
|---------|-------------|
| `D` | New destination instance |

---

### `convert(Object source, Type destinationType)`

Same as above, but the destination type is captured as a `java.lang.reflect.Type` — typical when the target is a generic such as `List<InnerMessage>` and you use `TypeToken`.

```java
InnerMessage converMessage = MapperUtils.convert(
        genericMessage.getInner(), new TypeToken<InnerMessage>(){}.getType());
```

| Parameter | Description |
|-----------|-------------|
| `source`          | Source object |
| `destinationType` | Target `Type` |

| Returns | Description |
|---------|-------------|
| `D` | New destination instance |

---

### `convert(Object source, Object destinationObj)`

Copies same-name fields from `source` into the already-constructed `destinationObj`. Use this when the destination must be initialized in advance (e.g., a managed entity).

```java
SampleModelToConvert converted = new SampleModelToConvert();
MapperUtils.convert(sampleModel, converted);
```

| Parameter | Description |
|-----------|-------------|
| `source`         | Source object |
| `destinationObj` | Existing destination instance to populate |

---

### `convertList(List<S> list, Class<D> destinationType)`

Converts each element of `list` into a new `D` and returns the resulting list.

```java
List<SampleModelToConvert> convertedList =
        MapperUtils.convertList(sampleModelList, SampleModelToConvert.class);
```

| Parameter | Description |
|-----------|-------------|
| `list`            | Source list |
| `destinationType` | Target element class |

| Returns | Description |
|---------|-------------|
| `List<D>` | List of converted instances |

---

## 2. Underscore → CamelCase Mapping

> Source field names are `snake_case`; destination field names are `camelCase`. Useful when the source comes from a DB row or a system that uses underscore naming.

### `convertFromUnderscoreToCamel(Object source, Class<D> destinationType)`

```java
SampleModelToConvert converted =
        MapperUtils.convertFromUnderscoreToCamel(sampleModel, SampleModelToConvert.class);
```

| Parameter | Description |
|-----------|-------------|
| `source`          | Source object (snake_case fields) |
| `destinationType` | Target class (camelCase fields) |

| Returns | Description |
|---------|-------------|
| `D` | New destination instance |

---

### `convertFromUnderscoreToCamel(Object source, Type destinationType)`

```java
InnerMessage converMessage = MapperUtils.convertFromUnderscoreToCamel(
        genericMessage.getInner(), new TypeToken<InnerMessage>(){}.getType());
```

| Parameter | Description |
|-----------|-------------|
| `source`          | Source object |
| `destinationType` | Target `Type` |

| Returns | Description |
|---------|-------------|
| `D` | New destination instance |

---

### `convertFromUnderscoreToCamel(Object source, Object destinationObj)`

```java
SampleModelToConvert converted = new SampleModelToConvert();
MapperUtils.convertFromUnderscoreToCamel(sampleModel, converted);
```

| Parameter | Description |
|-----------|-------------|
| `source`         | Source object |
| `destinationObj` | Existing destination instance |

---

### `convertListFromUnderscoreToCamel(List<S> list, Class<D> destinationType)`

```java
List<SampleModelToConvert> convertedList =
        MapperUtils.convertListFromUnderscoreToCamel(sampleModelList, SampleModelToConvert.class);
```

| Parameter | Description |
|-----------|-------------|
| `list`            | Source list (snake_case items) |
| `destinationType` | Target element class (camelCase) |

| Returns | Description |
|---------|-------------|
| `List<D>` | List of converted instances |
