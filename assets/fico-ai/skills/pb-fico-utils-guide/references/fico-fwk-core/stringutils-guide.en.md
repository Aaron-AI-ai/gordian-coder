# StringUtils User Guide

## Overview

`StringUtils` is a common utility class provided by the FICO framework.
It collects the string operations most often needed by business code: validation (numeric / alpha / blank / Korean-content), trimming/case conversion, padding (character-count and EUC-KR byte-aware), substring/slicing/length, replacement, masking, formatting with thousand separators, date string reformatting, encoding conversion (UTF-8 ↔ EUC-KR), and `SecureRandom`-based random hex strings.

- Package: `kr.co.openlabs.fico.framework.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.openlabs.fico.framework.utils.StringUtils;
```

> ℹ️ **About string length.** Methods named `stringLen` return the **character count**; methods named `getStrLength` / `getStrNByteLength` / `chkStrLength` return **UTF-8 byte length**; `getEucKrPadding` / `getEucKrCut` operate on **EUC-KR byte length** (Korean = 2 bytes). Pick the variant that matches what "length" means in your transport.

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. Validation — content type

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Is the string `null` or empty (`\"\"`)?" | [`isEmpty`](#isemptystring-checkstr) |
| "Is the string `null`, empty, or only whitespace?" | [`isBlank`](#isblankstring-checkstr) |
| "Does the string contain any whitespace?" | [`isSpace(checkStr)`](#isspacestring-checkstr), [`isSpace(checkStr, length)`](#isspacestring-checkstr-int-length) |
| "Is the entire string (or first N chars) all space `0x20` characters?" | [`isAllSpace`](#isallspacestring-checkstr-int-length--isallspacestring-checkstr) |
| "All digits? Contains a digit?" | [`isDigit`](#isdigitstring-checkstr--isdigitstring-checkstr-int-length), [`hasDigit`](#hasdigitstring-checkstr--hasdigitstring-checkstr-int-length) |
| "All alphabetic? Alphanumeric? (full string or first N chars)" | [`isAlpha`](#isalphastring-checkstr--isalphastring-checkstr-int-length), [`isDigitAlpha`](#isdigitalphastring-checkstr--isdigitalphastring-checkstr-int-length) |
| "All lowercase? All uppercase? (non-letters are allowed)" | [`isLowerCase`](#islowercasestring-checkstr--islowercasestring-checkstr-int-length), [`isUpperCase`](#isuppercasestring-checkstr--isuppercasestring-checkstr-int-length) |
| "All zero characters? (full string or first N chars)" | [`isAllZero`](#isallzerostring-checkstr-int-length--isallzerostring-checkstr) |
| "Valid hex characters in the first N chars?" | [`isHexNumStr`](#ishexnumstrstring-checkstr-int-nlen) |
| "Contains Korean characters?" | [`chkHangul`](#chkhangulstring-word) |
| "Contains any 3-byte (multi-byte) characters?" | [`isInclude3Byte`](#isinclude3bytestring-input) |

### B. Length / size

| Situation | Function |
|-----------|----------|
| "Get the character count of a string" | [`stringLen`](#stringlenstring-str) |
| "Get the UTF-8 byte length (Korean counts as 3 bytes)" | [`getStrLength`](#getstrlengthstring-pstr) |
| "Get the UTF-8 byte length, capped at a maximum" | [`getStrNByteLength`](#getstrnbytelengthstring-pstr-int-nmaxlen) |
| "Check (boolean / throw) that UTF-8 byte length is within a limit" | [`chkStrLength`](#chkstrlengthstring-pstr-int-chklen--chkstrlengthstring-pstr-int-chklen-string-colnm) |

### C. Case / trim

| Situation | Function |
|-----------|----------|
| "Convert to lowercase / uppercase (full string or first N chars)" | [`getLowerCase`](#getlowercasestring-inputstr--getlowercasestring-inputstr-int-length), [`getUpperCase`](#getuppercasestring-inputstr--getuppercasestring-inputstr-int-length) |
| "Trim / left-trim / right-trim whitespace" | [`getTrim`](#gettrimstring-inputstr), [`getLeftTrim`](#getlefttrimstring-inputstr), [`getRightTrim`](#getrighttrimstring-inputstr) |
| "Trim every value in a `Map<String, String>` in place" | [`mapTrim`](#maptrimmapstring-string-inputmap) |

### D. Comparison

| Situation | Function |
|-----------|----------|
| "Lexicographic compare returning `-1` / `0` / `1`" | [`compareString`](#comparestring-overloads) |
| "Same but only over the first N characters" | [`compareString(s1, s2, num)`](#comparestring-overloads) |
| "Same with case-insensitive option" | [`compareString(s1, s2, caseInsensitive)`](#comparestring-overloads) |
| "Combined N-char + case-insensitive compare" | [`compareString(s1, s2, num, caseInsensitive)`](#comparestring-overloads) |

### E. Concat / null-safe defaults

| Situation | Function |
|-----------|----------|
| "Concatenate two strings (`s1 + s2`)" | [`concateString`](#concatestringstring-s1-string-s2) |
| "Null-safe concat (treat null as empty)" | [`stringConcat(s1, s2)`](#stringconcatstring-s1-string-s2) |
| "Concat with the first N characters of s2" | [`stringConcat(s1, s2, num)`](#stringconcatstring-s1-string-s2-int-num) |
| "Return a default value when the string is `null` / empty" | [`nvl`](#nvlstring-str-string-defval) |

### F. Primitive → string

| Situation | Function |
|-----------|----------|
| "Format `double` exactly with `BigDecimal`" | [`changeDoubleToString`](#changedoubletostringdouble-num) |
| "Plain `int` → `String`" | [`changeIntToString`](#changeinttostringint-num) |
| "Plain `long` → `String`" | [`changeLToString`](#changeltostringlong-num) |
| "Format any number with a `printf`-style pattern" | [`getFormatString`](#getformatstringdouble-num-string-format) |

### G. String → primitive

| Situation | Function |
|-----------|----------|
| "Parse an entire string into `int` / `long` / `double`" | [`stringToInt(str)`](#stringtointstring-str--stringtointstring-str-int-size), [`stringToLong(str)`](#stringtolongstring-str--stringtolongstring-str-int-size), [`stringToDouble`](#stringtodoublestring-str) |
| "Parse only the first N characters into `int` / `long`" | `stringToInt(str, size)`, `stringToLong(str, size)` |

### H. Substring / slice (byte-level)

| Situation | Function |
|-----------|----------|
| "Find the index of a substring (`-1` if absent)" | [`stringIndex`](#stringindexstring-s1-string-s2) |
| "Extract a fixed-length slice from a `byte[]`" | [`subStrByte`](#substrbytebyte-pstr-int-psidx-int-plen--substrbytebyte-pstr-int-psidx) |
| "Trim a byte slice without breaking multi-byte chars (replace incomplete tails with spaces)" | [`unicodRvsn`](#unicodrvsnbyte-zsrc-int-nlen) |
| "Copy the first N characters into a fixed-size buffer (truncating)" | [`strLCpy`](#strlcpystring-pzsrc-int-ndstsz) |
| "Copy and pad to exact N characters" | [`strLCpyS`](#strlcpysstring-pzsrc-int-ndstsz) |

### I. Replace / remove

| Situation | Function |
|-----------|----------|
| "Replace every occurrence of a character" | [`stringReplace`](#stringreplacestring-srcstr-char-wrd1-char-wrd2) |
| "Remove every occurrence of a substring" | [`stringRmAll`](#stringrmallstring-srcstr-string-rmstr) |
| "Replace the first N characters with a single character" | [`setSubStr`](#setsubstrstring-psdst-char-csrc-int-nlen) |

### J. Padding

| Situation | Function |
|-----------|----------|
| "Left- or right-pad a string by **character count**" | [`stringPadding`](#stringpaddingint-num-string-srcstr-int-gbn-char-wrd) |
| "Left- or right-pad treating Korean as 2 bytes (**EUC-KR style**)" | [`getEucKrPadding`](#geteuckrpaddingint-imaxlen-string-srcstr-int-gbn-char-wrd) |
| "Slice a string into segments by EUC-KR byte lengths" | [`getEucKrCut`](#geteuckrcutstring-srcstr-int-imaxlen) |

### K. Number formatting (commas, fixed width)

| Situation | Function |
|-----------|----------|
| "Add thousand separators to a numeric string" | [`setComma`](#setcommastring-num) |
| "Format `long` to a right-aligned, comma-separated string of fixed width" | [`longToComma`](#longtocommalong-lsrc-int-nlen-int-nflag) |
| "Format `double` to a right-aligned, comma-separated string with N decimal places" | [`doubleToComma`](#doubletocommadouble-dsrc-int-nlen-int-nfract-int-nflag) |
| "Format `long` to fixed width with `0`- or space-padding" | [`longToStrWithPadding`](#longtostrwithpaddinglong-lsrc-int-nlen-boolean-zeropadding) |
| "Format `double` to fixed width with decimal precision and `0`- or space-padding" | [`doubleToStrWithPadding`](#doubletostrwithpaddingdouble-dvalue-int-nlen-int-nfract-boolean-zeropadding) |

### L. Date string reformat

| Situation | Function |
|-----------|----------|
| "Reformat `YYYYMMDD` with a custom separator" | [`setDateFormat(pdate, delimiter)`](#setdateformatstring-pdate-string-delimiter) |
| "Reformat `YYYYMMDD` into `YYYY년 M월 D일`" | [`setDateFormat(pdate)`](#setdateformatstring-pdate) |
| "Get the current HTTP date string (`Thu, 17 Nov 2005 18:49:58 GMT`)" | [`getHttpDate`](#gethttpdatelocale-locale) |

### M. Masking / unmasking

| Situation | Function |
|-----------|----------|
| "Mask sensitive data using type code only (no separators)" | [`masking`](#maskingstring-str-string-types) |
| "Mask sensitive data and re-insert separators (e.g., RRN/phone hyphens)" | [`maskingView`](#maskingviewstring-str-string-types) |
| "Auto-mask: choose by type code, optional separator, optional authorized-unmask" | [`automaskingView`](#automaskingviewstring-str-string-types-string-viewtp--automaskingviewstring-str-string-types-string-viewtp-boolean-bmaskdel) |

### N. Encoding conversion (UTF-8 ↔ EUC-KR)

| Situation | Function |
|-----------|----------|
| "Convert a UTF-8 string into an EUC-KR `byte[]`" | [`ecdUtfToEucKr`](#ecdutftoeuckrstring-putf) |
| "Convert an EUC-KR `byte[]` into a UTF-8 string" | [`ecdEucKrToUtf`](#ecdeuckrtoutfbyte-pstr) |

### O. Secure random

| Situation | Function |
|-----------|----------|
| "Generate a `SecureRandom`-based hex string of length N" | [`generateSecretString`](#generatesecretstringint-length) |

> 💡 **What is NOT in StringUtils' scope?** Regex compilation, locale-aware comparison/collation, full Unicode normalization, JSON/XML escaping, and Base64 are not the role of this utility.

---

## 1. Content-Type Validation

### `isEmpty(String checkStr)`

```java
StringUtils.isEmpty(null);    // true
StringUtils.isEmpty("");      // true
StringUtils.isEmpty("abc");   // false
```

| Returns | `true` if `null` or `""`. |

---

### `isBlank(String checkStr)`

```java
StringUtils.isBlank("     ");   // true
```

| Returns | `true` if `null`, `""`, or whitespace-only. |

---

### `isSpace(String checkStr)` / `isSpace(String checkStr, int length)`

Checks for the presence of any whitespace (space, tab, newline, carriage return). The 2-arg form checks only the first `length` characters.

```java
StringUtils.isSpace("abc 12345");       // true
StringUtils.isSpace("abc 12345", 3);    // false
```

| Returns | `boolean` |

---

### `isAllSpace(String checkStr, int length)` / `isAllSpace(String checkStr)`

Checks whether all characters are the space character `0x20`. The 1-arg form returns `false` for `null` and `true` for `""`.

```java
StringUtils.isAllSpace("    12345", 3);   // true
StringUtils.isAllSpace("   ");            // true
StringUtils.isAllSpace("\t");             // false
```

---

### `isDigit(String checkStr)` / `isDigit(String checkStr, int length)`

`true` when every checked character is `0`–`9`.

```java
StringUtils.isDigit("123a456");      // false
StringUtils.isDigit("123a456", 3);   // true
```

---

### `hasDigit(String checkStr)` / `hasDigit(String checkStr, int length)`

`true` when at least one digit is present in the checked range.

```java
StringUtils.hasDigit("abc1def");      // true
StringUtils.hasDigit("abc1def", 3);   // false
```

---

### `isAlpha(String checkStr)` / `isAlpha(String checkStr, int length)`

`true` when every checked character is `a`–`z` or `A`–`Z`.

```java
StringUtils.isAlpha("abc1def");      // false
StringUtils.isAlpha("abc1def", 3);   // true
```

---

### `isDigitAlpha(String checkStr)` / `isDigitAlpha(String checkStr, int length)`

`true` when every checked character is alphanumeric.

```java
StringUtils.isDigitAlpha("abc1#def");      // false
StringUtils.isDigitAlpha("abc1#def", 3);   // true
```

---

### `isLowerCase(String checkStr)` / `isLowerCase(String checkStr, int length)`

`true` when no uppercase letter is present in the checked range (non-letters are allowed).

```java
StringUtils.isLowerCase("abcDef");      // false
StringUtils.isLowerCase("abcDef", 3);   // true
```

---

### `isUpperCase(String checkStr)` / `isUpperCase(String checkStr, int length)`

`true` when no lowercase letter is present in the checked range.

```java
StringUtils.isUpperCase("ABCdEF");      // false
StringUtils.isUpperCase("ABCdEF", 3);   // true
```

---

### `isAllZero(String checkStr, int length)` / `isAllZero(String checkStr)`

`true` when every checked character is `'0'`.

```java
StringUtils.isAllZero("0000 0000", 5);   // false
StringUtils.isAllZero("000");            // true
```

---

### `isHexNumStr(String checkStr, int nLen)`

`true` when the first `nLen` characters are valid hex digits (`0`–`9`, `A`–`F`, `a`–`f`).

```java
StringUtils.isHexNumStr("16afeg567", 7);   // false
```

---

### `chkHangul(String word)`

`true` if the string contains any Korean (Hangul) characters.

```java
StringUtils.chkHangul("abc def 한글 ghi");   // true
```

---

### `isInclude3Byte(String input)`

`true` if the UTF-8 encoding of `input` contains any 3-byte characters (typical for Korean / CJK).

```java
StringUtils.isInclude3Byte("test 한글");   // true
```

---

## 2. Length / Size

### `stringLen(String str)`

Character count.

```java
StringUtils.stringLen("abcd");   // 4
```

---

### `getStrLength(String pStr)`

UTF-8 byte length (Korean characters typically count as 3 bytes).

```java
StringUtils.getStrLength("def 한글");   // 10
```

---

### `getStrNByteLength(String pStr, int nMaxLen)`

UTF-8 byte length, capped at `nMaxLen`.

```java
StringUtils.getStrNByteLength("def 한글", 8);   // 8
```

---

### `chkStrLength(String pStr, int chkLen)` / `chkStrLength(String pStr, int chkLen, String colNm)`

Validates UTF-8 byte length.

- 2-arg: returns `true` if within `chkLen`, `false` if exceeded.
- 3-arg: throws `CommonException` (`"{colNm} 항목의 길이를 확인하십시오."`) if exceeded.

```java
StringUtils.chkStrLength("def 한글", 8);            // false
StringUtils.chkStrLength("def 한글", 8, "test");    // throws CommonException
```

---

## 3. Case / Trim

### `getLowerCase(String inputStr)` / `getLowerCase(String inputStr, int length)`

```java
StringUtils.getLowerCase("16AFEG567");       // "16afeg567"
StringUtils.getLowerCase("16AFEG567", 5);    // "16afe"
```

---

### `getUpperCase(String inputStr)` / `getUpperCase(String inputStr, int length)`

```java
StringUtils.getUpperCase("16afeg567");       // "16AFEG567"
StringUtils.getUpperCase("16afeg567", 5);    // "16AFE"
```

---

### `getTrim(String inputStr)`

```java
StringUtils.getTrim("  16afeg567  ");   // "16afeg567"
```

---

### `getLeftTrim(String inputStr)`

```java
StringUtils.getLeftTrim("  16afeg567  ");   // "16afeg567  "
```

---

### `getRightTrim(String inputStr)`

```java
StringUtils.getRightTrim("  16afeg567  ");   // "  16afeg567"
```

---

### `mapTrim(Map<String, String> inputMap)`

Trims every value of `inputMap` in place.

```java
Map<String, String> m = new HashMap<>();
m.put("a", "  hello  ");
m.put("b", "\tworld ");
StringUtils.mapTrim(m);
// m = { "a" -> "hello", "b" -> "world" }
```

| Parameter | Description |
|-----------|-------------|
| `inputMap` | Map whose values will be trimmed |

---

## 4. Comparison

### compareString overloads

Returns `-1`, `0`, or `1`.

```java
StringUtils.compareString("abc", "acb");                 // -1
StringUtils.compareString("abcdef", "abcdfe", 3);        // 0   — first 3 chars only
StringUtils.compareString("abc", "ABC", true);           // 0   — case-insensitive
StringUtils.compareString("abcdef", "abCdfe", 3, true);  // 0   — first 3 chars, case-insensitive
```

| Signature | Description |
|-----------|-------------|
| `compareString(String s1, String s2)` | Lexicographic compare |
| `compareString(String s1, String s2, int num)` | Compare the first `num` characters |
| `compareString(String s1, String s2, boolean caseInsensitive)` | Case-insensitive option |
| `compareString(String s1, String s2, int num, boolean caseInsensitive)` | Combined |

---

## 5. Concat / Null-Safe Defaults

### `concateString(String s1, String s2)`

```java
StringUtils.concateString("abc", "acb");   // "abcacb"
```

---

### `stringConcat(String s1, String s2)`

Null-safe concat: treats `null` operands as empty strings.

```java
StringUtils.stringConcat("abc", "def");   // "abcdef"
StringUtils.stringConcat("abc", null);    // "abc"
```

---

### `stringConcat(String s1, String s2, int num)`

Concatenates `s1` with the first `num` characters of `s2`.

```java
StringUtils.stringConcat("abc", "defghij", 2);   // "abcde"
```

---

### `nvl(String str, String defVal)`

Returns `defVal` when `str` is `null` or empty.

```java
StringUtils.nvl(null, "empty string");   // "empty string"
```

---

## 6. Primitive → String

### `changeDoubleToString(double num)`

Exact `double` → `String` via `BigDecimal`.

```java
StringUtils.changeDoubleToString(123.456);   // "123.456"
```

---

### `changeIntToString(int num)`

```java
StringUtils.changeIntToString(123456);   // "123456"
```

---

### `changeLToString(long num)`

```java
StringUtils.changeLToString(1234567890L);   // "1234567890"
```

---

### `getFormatString(double num, String format)`

Generic `printf`-style number formatter.

```java
StringUtils.getFormatString(123.456789, "%015f_");   // "00000123.456789_"
```

| Parameter | Description |
|-----------|-------------|
| `num`    | Numeric source |
| `format` | `String.format`-style pattern |

---

## 7. String → Primitive

### `stringToInt(String str)` / `stringToInt(String str, int size)`

```java
StringUtils.stringToInt("123321");           // 123321
StringUtils.stringToInt("123test321", 3);    // 123
```

---

### `stringToLong(String str)` / `stringToLong(String str, int size)`

```java
StringUtils.stringToLong("1234567890");       // 1234567890L
StringUtils.stringToLong("1234567890", 9);    // 123456789L
```

---

### `stringToDouble(String str)`

```java
StringUtils.stringToDouble("123.4567890");   // 123.456789
```

---

## 8. Substring / Slice

### `stringIndex(String s1, String s2)`

Index of first occurrence of `s2` in `s1`; `-1` if absent.

```java
StringUtils.stringIndex("abcdefg", "ef");   // 4
```

---

### `subStrByte(byte[] pStr, int pSidx, int plen)` / `subStrByte(byte[] pStr, int pSidx)`

Slices a byte array from `pSidx` with length `plen` (or to end).

```java
byte[] src = { 100, 101, 102, 32, -57, -47, -79, -37 };
StringUtils.subStrByte(src, 4, 2);   // [-57, -47]
StringUtils.subStrByte(src, 4);      // [-57, -47, -79, -37]
```

---

### `unicodRvsn(byte[] zSrc, int nLen)`

Trims `zSrc` to `nLen` bytes, replacing any incomplete multi-byte tail with space characters so the result does not split a Unicode character.

```java
byte[] src = { 100, 101, 102, 32, -57, -47, -79, -37 };
StringUtils.unicodRvsn(src, 5);   // [100, 101, 102, 32, 32]
```

---

### `strLCpy(String pzSrc, int nDstSz)`

Copies the first `nDstSz` characters of `pzSrc`; returns `""` if `pzSrc` is `null`.

```java
StringUtils.strLCpy("abcde 12345", 5);   // "abcde"
```

---

### `strLCpyS(String pzSrc, int nDstSz)`

Copies to a fixed size of exactly `nDstSz` characters, space-padding if the source is shorter.

```java
StringUtils.strLCpyS("abcde 12345", 5);   // "abcde"
```

---

## 9. Replace / Remove

### `stringReplace(String srcStr, char wrd1, char wrd2)`

Replaces every occurrence of character `wrd1` with `wrd2`.

```java
StringUtils.stringReplace("123test321", '1', '#');   // "#23test32#"
```

---

### `stringRmAll(String srcStr, String rmStr)`

Removes every occurrence of substring `rmStr`.

```java
StringUtils.stringRmAll("123test321", "test");   // "123321"
```

---

### `setSubStr(String psDst, char cSrc, int nLen)`

Replaces the first `nLen` characters of `psDst` with `cSrc`.

```java
StringUtils.setSubStr("abcde 12345 fghi", '#', 5);   // "##### 12345 fghi"
```

---

## 10. Padding

### `stringPadding(int num, String srcStr, int gbn, char wrd)`

Pads `srcStr` to **character count** `num` with `wrd`. `gbn` = `0` left-pad, `1` right-pad.

```java
StringUtils.stringPadding(10, "test", 0, '#');   // "######test"
```

| Parameter | Description |
|-----------|-------------|
| `num`    | Target character length |
| `srcStr` | Source string |
| `gbn`    | `0` = left, `1` = right |
| `wrd`    | Pad character |

---

### `getEucKrPadding(int iMaxLen, String srcStr, int gbn, char wrd)`

Pads `srcStr` to **EUC-KR byte length** `iMaxLen` (Korean = 2 bytes). `gbn` = `0` left, `1` right.

```java
StringUtils.getEucKrPadding(10, "test 한글", 0, '#');   // "#test 한글"
```

---

### `getEucKrCut(String srcStr, int[] iMaxLen)`

Splits `srcStr` into segments whose EUC-KR byte sizes are `iMaxLen[0]`, `iMaxLen[1]`, …

```java
StringUtils.getEucKrCut("test#한글#abc", new int[] {4, 5, 4});
// → ["test", "#한글", "#abc"]
```

| Parameter | Description |
|-----------|-------------|
| `srcStr`  | Source string |
| `iMaxLen` | Segment byte sizes (EUC-KR) |

| Returns | Description |
|---------|-------------|
| `String[]` | Segments |

---

## 11. Number Formatting

### `setComma(String num)`

Adds thousand separators to a numeric string.

```java
StringUtils.setComma("1234567890");   // "1,234,567,890"
```

---

> **Flag constants** used by `longToComma` / `doubleToComma`:
>
> | Constant | Value | Effect |
> |----------|-------|--------|
> | `StringUtils.CNV_NOFLAG`   | `0` | No options |
> | `StringUtils.CNV_PLUSSIGN` | `2` | Prefix positive numbers with `+` |
> | `StringUtils.CNV_ASTERISK` | `4` | Fill leading blanks with `*` |
>
> Flags can be combined with bitwise OR: `CNV_PLUSSIGN | CNV_ASTERISK`.

### `longToComma(long lSrc, int nLen, int nFlag)`

Right-aligned, comma-separated `long`. If the result would exceed `nLen`, the slot is filled with `'#'`.

```java
StringUtils.longToComma(1251000, 15, StringUtils.CNV_PLUSSIGN);
// → "      +1,251,000"
```

| Parameter | Description |
|-----------|-------------|
| `lSrc`  | Source long |
| `nLen`  | Output width |
| `nFlag` | Bit flags: `CNV_PLUSSIGN` (prefix `+`), `CNV_ASTERISK` (asterisk fill for blanks) |

---

### `doubleToComma(double dSrc, int nLen, int nFract, int nFlag)`

Right-aligned, comma-separated `double` with `nFract` decimal places.

```java
StringUtils.doubleToComma(123.456789, 15, 5, StringUtils.CNV_PLUSSIGN);
// → "      +123.45679"
```

| Parameter | Description |
|-----------|-------------|
| `dSrc`   | Source double |
| `nLen`   | Output width |
| `nFract` | Decimal places |
| `nFlag`  | Flags (`CNV_PLUSSIGN`, `CNV_ASTERISK`) |

---

### `longToStrWithPadding(long lSrc, int nLen, boolean zeroPadding)`

Right-aligned `long` of width `nLen`, padded with `'0'` (`zeroPadding=true`) or space (`false`).

```java
StringUtils.longToStrWithPadding(123456789, 15, true);
// → "000000123456789"
```

---

### `doubleToStrWithPadding(double dValue, int nLen, int nFract, boolean zeroPadding)`

Right-aligned `double` of width `nLen` and `nFract` decimal places.

```java
StringUtils.doubleToStrWithPadding(123.456789, 15, 3, true);
// → "00000000123.457"
```

---

## 12. Date String Reformat

### `setDateFormat(String pdate, String delimiter)`

Reformats `YYYYMMDD` to `YYYY{delimiter}M{delimiter}D` (single-digit month/day are **not** zero-padded).

```java
StringUtils.setDateFormat("19810904", "#");   // "1981#9#4"
```

---

### `setDateFormat(String pdate)`

Reformats `YYYYMMDD` to `YYYY년 M월 D일`.

```java
StringUtils.setDateFormat("19810904");   // "1981년 9월 4일"
```

---

### `getHttpDate(Locale locale)`

Current GMT time in HTTP date format.

```java
StringUtils.getHttpDate(Locale.KOREA);
// → "수, 13 12월 2023 06:29:14 GMT"
```

| Parameter | Description |
|-----------|-------------|
| `locale` | Locale used for day/month names |

| Returns | Description |
|---------|-------------|
| `String` | HTTP date string |

---

## 13. Masking

### `masking(String str, String types)`

Masks sensitive data based on a `types` code (e.g., `"1"` for resident registration number). No separators added.

```java
StringUtils.masking("8109041234567", "1");   // "8109041******"
```

---

### `maskingView(String str, String types)`

Same as `masking` but re-inserts conventional separators (hyphens etc.).

```java
StringUtils.maskingView("8109041234567", "1");   // "810904-1******"
```

---

### `automaskingView(String str, String types, String viewTp)` / `automaskingView(String str, String types, String viewTp, boolean bMaskDel)`

Type-driven masking. `viewTp = "1"` adds separators. The 4-arg form's `bMaskDel = true` returns the **unmasked** value (intended for the caller's pre-authorized branch).

```java
StringUtils.automaskingView("8109041234567", "1", "1");          // "810904-1******"
StringUtils.automaskingView("8109041234567", "1", "1", true);    // "810904-1234567"
```

| Parameter | Description |
|-----------|-------------|
| `str`      | Source string |
| `types`    | Type code (`"1"`–`"9"`, field-dependent) |
| `viewTp`   | `"1"` to insert separators |
| `bMaskDel` | `true` to return the unmasked value (caller must be authorized) |

---

## 14. Encoding Conversion

### `ecdUtfToEucKr(String putf)`

UTF-8 string → EUC-KR `byte[]`.

```java
StringUtils.ecdUtfToEucKr("def 한글");
// → [100, 101, 102, 32, -57, -47, -79, -37]
```

---

### `ecdEucKrToUtf(byte[] pStr)`

EUC-KR `byte[]` → UTF-8 string.

```java
StringUtils.ecdEucKrToUtf(new byte[] { 100, 101, 102, 32, -57, -47, -79, -37 });
// → "def 한글"
```

---

## 15. Secure Random

### `generateSecretString(int length)`

Generates a `SecureRandom`-based hex string of length `length`.

```java
StringUtils.generateSecretString(10);   // e.g., "e1f06ac638"
```

| Parameter | Description |
|-----------|-------------|
| `length` | Output character length |

| Returns | Description |
|---------|-------------|
| `String` | Random hex string |
