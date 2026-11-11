# NumberUtils User Guide

## Overview

`NumberUtils` is a common utility class provided by the FICO framework.
It covers numeric string parsing, Korean monetary-amount conversion, rounding (up/down/half-up/truncate) on `long` / `double` / `BigDecimal`, array index lookup, and `SecureRandom`-based random number generation.

- Package: `kr.co.openlabs.fico.framework.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.openlabs.fico.framework.utils.NumberUtils;
```

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. String → number parsing

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Take the first N characters of a string and parse them into a `BigDecimal`" | [`getDecimalFromString`](#getdecimalfromstringstring-num-int-length) |

### B. Korean monetary text

| Situation | Function |
|-----------|----------|
| "Convert an integer monetary amount into a Korean string (e.g., `100000000` → `일억`)" | [`longToKor`](#longtokorlong-lval) |

### C. Rounding — `BigDecimal`

| Situation | Function |
|-----------|----------|
| "Round a `BigDecimal` to N decimal places with a `RoundingMode`" | [`setScalePrc(BigDecimal, int, RoundingMode)`](#setscaleprcbigdecimal-num-int-scale-roundingmode-roundtp) |
| "Same but pass the rounding mode as the int ordinal" | [`setScalePrc(BigDecimal, int, int)`](#setscaleprcbigdecimal-num-int-scale-int-roundtp) |
| "Truncate a `BigDecimal` to N decimal places" | [`truncDecimal`](#truncdecimalbigdecimal-src-int-npos) |

### D. Rounding — `long`

| Situation | Function |
|-----------|----------|
| "Round a `long` up to the nearest 10/100/1000 (negative `nPos`)" | [`longRoundUp`](#longroundup) |
| "Round a `long` down (floor) to the nearest 10/100/1000" | [`longRoundDown`](#longrounddown) |
| "Round a `long` half-up to the nearest 10/100/1000" | [`longRoundOff`](#longroundoff) |
| "Truncate a `long` to the nearest 10/100/1000" | [`truncLong`](#trunclonglong-src-int-npos) |

### E. Rounding — `double`

| Situation | Function |
|-----------|----------|
| "Round a `double` up at the Nth decimal place" | [`doubleRoundUp`](#doubleroundup) |
| "Round a `double` down at the Nth decimal place" | [`doubleRoundDown`](#doublerounddown) |
| "Round a `double` half-up at the Nth decimal place" | [`doubleRoundOff`](#doubleroundoff) |

### F. Array index lookup (0-based)

| Situation | Function |
|-----------|----------|
| "Find the 0-based index of a string in a `String[]`; `-1` if absent" | [`inStringArray`](#instringarraystring-pzsrc-string-zdata) |
| "Find the 0-based index of a long in a `long[]`; `-1` if absent" | [`inLongArray`](#inlongarraylong-lsrc-long-ldata) |

### G. Secure random numbers

| Situation | Function |
|-----------|----------|
| "Generate a random `long` with a specific number of digits" | [`generateSecretLongNumber`](#generatesecretlongnumberint-length) |
| "Generate a random `long` in `[origin, bound)` (Java 17 `RandomGenerator.nextLong` substitute)" | [`nextLong`](#nextlonglong-origin-long-bound) |

> 💡 **What is NOT in NumberUtils' scope?** Locale-aware number formatting, currency symbol rendering, scientific-notation handling, and big-integer arithmetic are not the role of this utility. For 1-based membership lookup, see `MemberCheckUtils`.

---

## 1. String → Number Parsing

### `getDecimalFromString(String num, int length)`

Takes the first `length` characters of `num` and parses them into a `BigDecimal`.

```java
NumberUtils.getDecimalFromString("1234.5678ABCDE", 9);   // 1234.5678
```

| Parameter | Description |
|-----------|-------------|
| `num`    | Source string |
| `length` | Number of leading characters to parse |

| Returns | Description |
|---------|-------------|
| `BigDecimal` | Parsed value |

---

## 2. Korean Monetary Text

### `longToKor(long lVal)`

Converts an integer monetary amount into a Korean-text representation. Supports up to 16 digits. Negative values are prefixed with `-`; zero is rendered as `영`.

```java
NumberUtils.longToKor(100_000_000L);          // "일억"
NumberUtils.longToKor(48_653_000L);           // "사천팔백육십오만삼천"
NumberUtils.longToKor(512_232_400_000_000L);  // "오백일십이조이천삼백이십사억"
```

| Parameter | Description |
|-----------|-------------|
| `lVal` | Source long value |

| Returns | Description |
|---------|-------------|
| `String` | Korean text representation |

Throws `CommonException` if `|lVal|` exceeds 16 digits.

---

## 3. BigDecimal Rounding

### `setScalePrc(BigDecimal num, int scale, RoundingMode roundTp)`

Adjusts the scale of `num` using the given `RoundingMode`.

```java
NumberUtils.setScalePrc(BigDecimal.valueOf(3456), -3, RoundingMode.UP);   // 4E+3 (= 4000)
```

| Parameter | Description |
|-----------|-------------|
| `num`     | Source value |
| `scale`   | Target scale (negative = rounding to powers of 10) |
| `roundTp` | `java.math.RoundingMode` |

| Returns | Description |
|---------|-------------|
| `BigDecimal` | Scaled value |

---

### `setScalePrc(BigDecimal num, int scale, int roundTp)`

Same as above but passes the rounding mode as the int ordinal (`RoundingMode.valueOf(int)`). Ordinals follow the `java.math.RoundingMode` enum: `0`=UP, `1`=DOWN, `2`=CEILING, `3`=FLOOR, `4`=HALF_UP, `5`=HALF_DOWN, `6`=HALF_EVEN, `7`=UNNECESSARY.

```java
NumberUtils.setScalePrc(BigDecimal.valueOf(3456), -3, 0);   // RoundingMode.UP → 4E+3 (= 4000)
```

| Parameter | Description |
|-----------|-------------|
| `num`     | Source value |
| `scale`   | Target scale |
| `roundTp` | Rounding mode ordinal |

| Returns | Description |
|---------|-------------|
| `BigDecimal` | Scaled value |

---

### `truncDecimal(BigDecimal src, int nPos)`

Truncates `src` at decimal position `nPos`.

```java
NumberUtils.truncDecimal(BigDecimal.valueOf(123.456), 1);   // 123.4
```

| Parameter | Description |
|-----------|-------------|
| `src`  | Source value |
| `nPos` | Target scale |

| Returns | Description |
|---------|-------------|
| `BigDecimal` | Truncated value |

---

## 4. Long Rounding

> For `long` rounding, `nPos` is **negative**: `-1` = nearest 10, `-2` = nearest 100, etc.

### `longRoundUp(long lSrc, int nPos)`

Rounds up (ceiling).

```java
NumberUtils.longRoundUp(123, -1);   // 130
```

### `longRoundDown(long lSrc, int nPos)`

Rounds down (floor).

```java
NumberUtils.longRoundDown(125, -1);   // 120
```

### `longRoundOff(long lSrc, int nPos)`

Rounds half-up.

```java
NumberUtils.longRoundOff(124, -1);   // 120
NumberUtils.longRoundOff(125, -1);   // 130
```

### `truncLong(long src, int nPos)`

Truncates (effectively the same as `longRoundDown` for positive values).

```java
NumberUtils.truncLong(123, -1);   // 120
```

| Parameter | Description |
|-----------|-------------|
| `lSrc` / `src` | Source long |
| `nPos`         | Negative target position (`-1` = tens, `-2` = hundreds, …) |

| Returns | Description |
|---------|-------------|
| `long` | Rounded value |

---

## 5. Double Rounding

> For `double` rounding, `nPos` is **positive**: `0` = no decimals, `1` = one decimal, etc.

### `doubleRoundUp(double dSrc, int nPos)`

Rounds up (ceiling) at decimal position `nPos`.

```java
NumberUtils.doubleRoundUp(125.1, 0);    // 126.0
NumberUtils.doubleRoundUp(125.14, 1);   // 125.2
```

### `doubleRoundDown(double dSrc, int nPos)`

Rounds down (floor) at decimal position `nPos`.

```java
NumberUtils.doubleRoundDown(125.6, 0);    // 125.0
NumberUtils.doubleRoundDown(125.16, 1);   // 125.1
```

### `doubleRoundOff(double dSrc, int nPos)`

Rounds half-up at decimal position `nPos`.

```java
NumberUtils.doubleRoundOff(125.6, 0);    // 126.0
NumberUtils.doubleRoundOff(125.16, 1);   // 125.2
```

| Parameter | Description |
|-----------|-------------|
| `dSrc` | Source double |
| `nPos` | Positive target position (`0` = integer, `1` = tenths, …) |

| Returns | Description |
|---------|-------------|
| `double` | Rounded value |

---

## 6. Array Index Lookup (0-based)

### `inStringArray(String pzSrc, String[] zData)`

Returns the 0-based index of `pzSrc` in `zData`, or `-1` if absent.

```java
String[] targetArray = { "123", "456", "abcd", "efgh" };
NumberUtils.inStringArray("456", targetArray);   // 1
```

| Parameter | Description |
|-----------|-------------|
| `pzSrc` | Value to look for |
| `zData` | Search target array |

| Returns | Description |
|---------|-------------|
| `int` | 0-based index, or `-1` if not found |

---

### `inLongArray(long lSrc, long[] lData)`

Returns the 0-based index of `lSrc` in `lData`, or `-1` if absent.

```java
long[] longArray = { 123, 456, 789, 123000 };
NumberUtils.inLongArray(123000L, longArray);   // 3
```

| Parameter | Description |
|-----------|-------------|
| `lSrc`  | Value to look for |
| `lData` | Search target array |

| Returns | Description |
|---------|-------------|
| `int` | 0-based index, or `-1` if not found |

---

## 7. Secure Random Numbers

### `generateSecretLongNumber(int length)`

Generates a `SecureRandom` `long` whose decimal representation has exactly `length` digits.

```java
NumberUtils.generateSecretLongNumber(10);   // e.g., 6140634638
```

| Parameter | Description |
|-----------|-------------|
| `length` | Target digit count |

| Returns | Description |
|---------|-------------|
| `long` | Random long with the requested digit count |

---

### `nextLong(long origin, long bound)`

A substitute for `java.util.random.RandomGenerator.nextLong(long, long)` (Java 17), returning a `SecureRandom` value in `[origin, bound)`.

```java
long r = NumberUtils.nextLong(1000L, 2000L);   // e.g., 1573
```

| Parameter | Description |
|-----------|-------------|
| `origin` | Inclusive lower bound |
| `bound`  | Exclusive upper bound |

| Returns | Description |
|---------|-------------|
| `long` | Random value in `[origin, bound)` |
