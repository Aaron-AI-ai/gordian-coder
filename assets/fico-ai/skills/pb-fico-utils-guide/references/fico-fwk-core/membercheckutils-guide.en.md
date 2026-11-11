# MemberCheckUtils User Guide

## Overview

`MemberCheckUtils` is a common utility class provided by the FICO framework.
It checks whether a given value belongs to a fixed list and returns the **1-based position** of the first match — handy for "is X one of A/B/C? if so which?" branching.

- Package: `kr.co.openlabs.fico.framework.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.openlabs.fico.framework.utils.MemberCheckUtils;
```

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. Membership check

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Is this string one of these strings? If so, which position?" | [`inStr`](#instrstring-condition-string-data) |
| "Is this number one of these numbers? If so, which position?" | [`inData`](#indatalong-condition-long-data) |

> 💡 **What is NOT in MemberCheckUtils' scope?** Range checks, `Collection.contains` substitutes (use `List.contains`), regex/glob matching, and substring containment are not the role of this utility. For 0-based index lookup, see `NumberUtils.inStringArray` / `NumberUtils.inLongArray`.

---

## 1. Membership Check

### `inStr(String condition, String... data)`

Checks whether `condition` matches any value in `data` and returns the **1-based** position of the first match (0 if no match).

```java
MemberCheckUtils.inStr("apple", "banana", "apple", "orange");   // 2
MemberCheckUtils.inStr("grape", "banana", "apple", "orange");   // 0
```

| Parameter | Description |
|-----------|-------------|
| `condition` | Value to look for |
| `data`      | Candidate values (vararg) |

| Returns | Description |
|---------|-------------|
| `int` | 1-based position of first match; `0` if not found or input is `null` |

---

### `inData(long condition, long... data)`

Checks whether `condition` matches any value in `data` and returns the **1-based** position of the first match (0 if no match).

```java
MemberCheckUtils.inData(100L, 200L, 100L, 300L);   // 2
MemberCheckUtils.inData(999L, 200L, 100L, 300L);   // 0
```

| Parameter | Description |
|-----------|-------------|
| `condition` | Value to look for |
| `data`      | Candidate values (vararg) |

| Returns | Description |
|---------|-------------|
| `int` | 1-based position of first match; `0` if not found or input is `null` |
