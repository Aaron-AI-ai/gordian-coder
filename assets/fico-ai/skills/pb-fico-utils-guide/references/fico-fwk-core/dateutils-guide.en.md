# DateUtils User Guide

## Overview

`DateUtils` is a common utility class provided by the FICO framework.
It covers current date/time string generation in various formats, date/time validation, date arithmetic (add/subtract/diff), quarter/weekday lookup, age calculation, and epoch-millisecond conversion.

- Package: `kr.co.openlabs.fico.framework.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.openlabs.fico.framework.utils.DateUtils;
```

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. Current date/time string generation

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Get current epoch milliseconds (System.currentTimeMillis equivalent)" | [`currentTimeMillis`](#currenttimemillis) |
| "Get current date as `YYYYMMDD`" | [`getCurrentDate()`](#getcurrentdate) |
| "Get current date with a custom pattern (e.g., `yyyy-MM-dd`, `yyyy년 MM월 dd일 EEE요일`)" | [`getCurrentDate(String pattern)`](#getcurrentdatestring-pattern) |
| "Get current year / month / day separately as strings" | [`getCurrentYear`](#getcurrentyear), [`getCurrentMonth`](#getcurrentmonth), [`getCurrentDay`](#getcurrentday) |
| "Get current date+time as `YYYYMMDDhhmmss`" | [`getCurrentDatetime`](#getcurrentdatetime) |
| "Get current date+time with microsecond / millisecond precision" | [`getCurrentDatetimemicro`](#getcurrentdatetimemicro), [`getCurrentDatetimemilli`](#getcurrentdatetimemilli), [`getCurrentDatetimemicrok`](#getcurrentdatetimemicrok) |
| "Get current time as `HHmmss` / `HHmmssSSS`" | [`getCurrentTime`](#getcurrenttime), [`getCurrentTimeMilli`](#getcurrenttimemilli) |
| "Get current time with a custom pattern" | [`getCurrentTimeByFormat`](#getcurrenttimebyformatstring-format) |
| "Get current time with microsecond suffix" | [`getCurrentTimemicro`](#getcurrenttimemicro) |
| "Get current sub-second value (milli / micro) as a number" | [`getCurrentSecmilli`](#getcurrentsecmilli), [`getCurrentSecmicro`](#getcurrentsecmicro) |

### B. Date / time validation

| Situation | Function |
|-----------|----------|
| "Check whether a 4-digit year string is valid (≥1900)" | [`isValidYear`](#isvalidyearstring-year) |
| "Check whether a `YYYYMMDD` string is a valid date (leap years considered)" | [`isValidDate`](#isvaliddatestring-date) |
| "Check whether an `HHMMSS` string is a valid time" | [`isValidTime`](#isvalidtimestring-time) |

### C. Date comparison & between

| Situation | Function |
|-----------|----------|
| "Compare two `YYYYMMDD` dates (which is earlier/later)" | [`compareDate`](#comparedatestring-d1-string-d2) |
| "Check whether a date is **after** a reference date" | [`isAfter`](#isafterstring-stddate-string-otherdate) |
| "Check whether a date is **before** a reference date" | [`isBefore`](#isbeforestring-stddate-string-otherdate) |
| "Check whether a date falls between two dates" | [`isBetween`](#isbetweenstring-date-string-startdate-string-enddate) |

### D. Calendar lookups

| Situation | Function |
|-----------|----------|
| "Get the number of days in a given year/month" | [`getDaysInMonth`](#getdaysinmonthstring-year-string-month) |
| "Get the last day of `yyyyMM`" | [`getLastDay`](#getlastdaystring-date) |
| "Get the months between two dates" | [`getMonthsBetween`](#getmonthsbetweenstring-d1-string-d2) |
| "Get the days between two dates" | [`getDaysBetween`](#getdaysbetweenstring-d1-string-d2) |
| "Get the quarter number (1–4) for a month" | [`getQuarterYear`](#getquarteryearstring-month) |
| "Get the start/end date of the quarter containing a month" | [`getQuarterStartEndDate`](#getquarterstartenddatestring-year-string-month-int-kind) |
| "Get the weekday index (0=Sun … 6=Sat) for a date" | [`getWeekday`](#getweekdaystring-year-string-month-string-day) |

### E. Date / time arithmetic

| Situation | Function |
|-----------|----------|
| "Add N years to a `YYYYMMDD` date" | [`addYear`](#addyearstring-date-int-year) |
| "Add N months to a `YYYYMMDD` date" | [`addMonth`](#addmonthstring-date-int-month) |
| "Add N days to a `YYYYMMDD` date" | [`addDay`](#adddaystring-date-int-day) |
| "Add hours / minutes / seconds to an `HHmmss` time" | [`addHour`](#addhourstring-time-int-hour), [`addMinute`](#addminutestring-time-int-min), [`addSecond`](#addsecondstring-time-int-sec) |
| "Add/subtract using `ChronoUnit` on an ISO-8601 datetime" | [`addTime`](#addtimestring-time-long-amounttoadd-chronounit-unit-boolean-plus) |
| "Get the difference between two ISO datetimes in milliseconds" | [`diffTime`](#difftimestring-time1-string-time2) |

### F. Format conversion

| Situation | Function |
|-----------|----------|
| "Format an ISO datetime string into another pattern" | [`getTimeByFormat`](#gettimebyformatstring-time-string-format) |
| "Convert formatted date string → Unix-epoch milliseconds" | [`getEpochMilliFromFormatTime`](#getepochmillifromformattimestring-time-string-format) |
| "Convert Unix-epoch milliseconds → `yyyy-MM-dd HH:mm:ss.SSS`" | [`getTimeByEpochMilli`](#gettimebyepochmillilong-epochmilli) |
| "Parse a formatted date string into `LocalDate`" | [`getDate(String, String)`](#getdatestring-date-string-format) |
| "Format a `LocalDate` into a string with a custom pattern" | [`getDate(LocalDate, String)`](#getdatelocaldate-date-string-format) |

### G. Age calculation

| Situation | Function |
|-----------|----------|
| "Calculate age (international: years since birth, adjusted for birthday)" | [`getAge`](#getageint-birthyear-int-birthmonth-int-birthday) |
| "Calculate Korean age (current year − birth year + 1)" | [`getKoreanAge`](#getkoreanageint-birthyear) |

> 💡 **What is NOT in DateUtils' scope?** Time-zone math beyond system default, locale-sensitive parsing, business-calendar / holiday computation, and recurring-event rules are not the role of this utility.

---

## 1. Current Time (Epoch)

### `currentTimeMillis()`

Returns the current time as Unix-epoch milliseconds. Equivalent to `System.currentTimeMillis()`.

```java
long ms = DateUtils.currentTimeMillis();   // 1689932849722
```

| Returns | Description |
|---------|-------------|
| `long` | Current time in milliseconds since the Unix epoch |

---

## 2. Current Date Strings

### `getCurrentDate()`

Returns the current date as a `YYYYMMDD` string.

```java
DateUtils.getCurrentDate();   // "20231130"
```

| Returns | Description |
|---------|-------------|
| `String` | Current date (8 digits) |

---

### `getCurrentDate(String pattern)`

Returns the current date formatted by an arbitrary `SimpleDateFormat` pattern.

```java
DateUtils.getCurrentDate("yyyy-MM-dd");                  // "2023-11-01"
DateUtils.getCurrentDate("yyyy-MM-dd HH:mm:ss");         // "2023-11-01 13:00:01"
DateUtils.getCurrentDate("yyyy년 MM월 dd일 EEE요일");   // "2023년 11월 01일 수요일"
```

| Parameter | Description |
|-----------|-------------|
| `pattern` | `SimpleDateFormat` pattern |

| Returns | Description |
|---------|-------------|
| `String` | Current date formatted by `pattern` |

---

### `getCurrentYear()` / `getCurrentMonth()` / `getCurrentDay()`

Returns the current year, month, or day as a string.

```java
DateUtils.getCurrentYear();    // "2023"
DateUtils.getCurrentMonth();   // "11"
DateUtils.getCurrentDay();     // "30"
```

| Returns | Description |
|---------|-------------|
| `String` | 4-digit year / 2-digit month / 2-digit day |

---

### `getCurrentDatetime()`

Returns the current date+time as a `yyyyMMddHHmmss` (14-digit) string.

```java
DateUtils.getCurrentDatetime();   // "20231130160841"
```

| Returns | Description |
|---------|-------------|
| `String` | Current date+time (14 digits) |

---

### `getCurrentDatetimemicro()`

Returns the current date+time as a 14-digit string plus a 6-digit microsecond suffix (20 digits total).

```java
DateUtils.getCurrentDatetimemicro();   // "20231130160939366230"
```

| Returns | Description |
|---------|-------------|
| `String` | `yyyyMMddHHmmss` + 6-digit microseconds |

---

### `getCurrentDatetimemilli()`

Returns the current date+time as a 14-digit string plus a 3-digit millisecond suffix (17 digits total).

```java
DateUtils.getCurrentDatetimemilli();   // "20231130161044644"
```

| Returns | Description |
|---------|-------------|
| `String` | `yyyyMMddHHmmssSSS` |

---

### `getCurrentDatetimemicrok()`

Returns the current date+time as `yyyy-MM-dd HH:mm:ss,microsecond` (23 chars).

```java
DateUtils.getCurrentDatetimemicrok();   // "2023-11-30 16:11:27,001536"
```

| Returns | Description |
|---------|-------------|
| `String` | `yyyy-MM-dd HH:mm:ss,microsecond` |

---

## 3. Current Time Strings

### `getCurrentTime()`

Returns the current time as `HHmmss` (6 digits).

```java
DateUtils.getCurrentTime();   // "161222"
```

| Returns | Description |
|---------|-------------|
| `String` | Current time (6 digits) |

---

### `getCurrentTimeMilli()`

Returns the current time as `HHmmssSSS` (9 digits).

```java
DateUtils.getCurrentTimeMilli();   // "161322204"
```

| Returns | Description |
|---------|-------------|
| `String` | Current time with milliseconds (9 digits) |

---

### `getCurrentTimeByFormat(String format)`

Returns the current time formatted by a `DateTimeFormatter` pattern.

```java
DateUtils.getCurrentTimeByFormat("yyyy-MM-dd HH:mm:ss");   // "2023-11-01 13:00:01"
```

| Parameter | Description |
|-----------|-------------|
| `format`  | `DateTimeFormatter` pattern |

| Returns | Description |
|---------|-------------|
| `String` | Current time formatted by `format` |

---

### `getCurrentTimemicro()`

Returns the current time as `HHmmss` + 6-digit microseconds (12 digits total).

```java
DateUtils.getCurrentTimemicro();   // "163304372925"
```

| Returns | Description |
|---------|-------------|
| `String` | Current time + microseconds |

---

### `getCurrentSecmilli()` / `getCurrentSecmicro()`

Returns the current millisecond / microsecond component as a `Long`.

```java
DateUtils.getCurrentSecmilli();   // 739
DateUtils.getCurrentSecmicro();   // 853518
```

| Returns | Description |
|---------|-------------|
| `Long` | Sub-second component |

---

## 4. Date / Time Validation

### `isValidYear(String year)`

Checks whether the input is a valid 4-digit year ≥1900.

```java
DateUtils.isValidYear("2023");   // true
```

| Parameter | Description |
|-----------|-------------|
| `year` | 4-digit year string |

| Returns | Description |
|---------|-------------|
| `boolean` | `true` if valid year |

---

### `isValidDate(String date)`

Checks whether `YYYYMMDD` is a real calendar date (leap years considered). Year must be ≥1900.

```java
DateUtils.isValidDate("20231130");   // true
```

| Parameter | Description |
|-----------|-------------|
| `date` | `YYYYMMDD` date string |

| Returns | Description |
|---------|-------------|
| `boolean` | `true` if valid date |

---

### `isValidTime(String time)`

Checks whether `HHMMSS` is a valid time.

```java
DateUtils.isValidTime("163059");   // true
```

| Parameter | Description |
|-----------|-------------|
| `time` | `HHMMSS` time string |

| Returns | Description |
|---------|-------------|
| `boolean` | `true` if valid time |

---

## 5. Date Comparison

### `compareDate(String d1, String d2)`

Compares two `YYYYMMDD` dates.

```java
DateUtils.compareDate("19810904", "20231130");   // -1
```

| Parameter | Description |
|-----------|-------------|
| `d1`, `d2` | `YYYYMMDD` date strings |

| Returns | Description |
|---------|-------------|
| `int` | `-1` if `d1 < d2`, `0` if equal, `1` if `d1 > d2` |

---

### `isAfter(String stdDate, String otherDate)` / `isAfter(String stdDate, String otherDate, String format)`

Checks whether `otherDate` is after `stdDate`. Default pattern is `yyyyMMdd`; the 3-arg overload accepts a custom `DateTimeFormatter` pattern.

```java
DateUtils.isAfter("20231119", "19810904");   // false
DateUtils.isAfter("2020년 11월 17일 화요일", "2020년 11월 19일 목요일", "yyyy년 MM월 dd일 EEE요일");   // true
```

| Parameter | Description |
|-----------|-------------|
| `stdDate`   | Reference date |
| `otherDate` | Date to test |
| `format`    | (optional) `DateTimeFormatter` pattern |

| Returns | Description |
|---------|-------------|
| `boolean` | `true` if `otherDate` is after `stdDate` |

---

### `isBefore(String stdDate, String otherDate)` / `isBefore(String stdDate, String otherDate, String format)`

Checks whether `otherDate` is before `stdDate`. Default pattern is `yyyyMMdd`.

```java
DateUtils.isBefore("20231119", "19810904");   // true
```

| Parameter | Description |
|-----------|-------------|
| `stdDate`   | Reference date |
| `otherDate` | Date to test |
| `format`    | (optional) `DateTimeFormatter` pattern |

| Returns | Description |
|---------|-------------|
| `boolean` | `true` if `otherDate` is before `stdDate` |

---

### `isBetween(String date, String startDate, String endDate)` / `isBetween(String date, String startDate, String endDate, String format)`

Checks whether `date` is **strictly** between `startDate` and `endDate` (exclusive on both ends). Default pattern is `yyyyMMdd`.

```java
DateUtils.isBetween("20231119", "19810904", "20231201");   // true
```

| Parameter | Description |
|-----------|-------------|
| `date`      | Date to test |
| `startDate` | Start of range |
| `endDate`   | End of range |
| `format`    | (optional) `DateTimeFormatter` pattern |

| Returns | Description |
|---------|-------------|
| `boolean` | `true` if `startDate < date < endDate` |

---

## 6. Calendar Lookups

### `getDaysInMonth(String year, String month)`

Returns the number of days (28–31) in the given year/month.

```java
DateUtils.getDaysInMonth("2023", "11");   // 30
```

| Parameter | Description |
|-----------|-------------|
| `year`  | 4-digit year |
| `month` | Month (1–12) |

| Returns | Description |
|---------|-------------|
| `int` | Day count of the month |

---

### `getLastDay(String date)`

Returns the last day of the given year/month input `yyyyMM` as `yyyyMMdd`.

```java
DateUtils.getLastDay("202311");   // "20231130"
```

| Parameter | Description |
|-----------|-------------|
| `date` | `yyyyMM` input |

| Returns | Description |
|---------|-------------|
| `String` | Last date of the month (`yyyyMMdd`) |

---

### `getMonthsBetween(String d1, String d2)`

Calculates the months between two dates (end, start).

```java
DateUtils.getMonthsBetween("20231130", "19810904");   // 506.8387096774193
```

| Parameter | Description |
|-----------|-------------|
| `d1` | End date (`yyyyMMdd`) |
| `d2` | Start date (`yyyyMMdd`) |

| Returns | Description |
|---------|-------------|
| `double` | Months between |

---

### `getDaysBetween(String d1, String d2)`

Calculates the days between two dates (end, start).

```java
DateUtils.getDaysBetween("20231130", "19810904");   // 15427
```

| Parameter | Description |
|-----------|-------------|
| `d1` | End date (`yyyyMMdd`) |
| `d2` | Start date (`yyyyMMdd`) |

| Returns | Description |
|---------|-------------|
| `int` | Days between |

---

### `getQuarterYear(String month)`

Returns the quarter (1–4) of the given month.

```java
DateUtils.getQuarterYear("11");   // 4
```

| Parameter | Description |
|-----------|-------------|
| `month` | Month (1–12) |

| Returns | Description |
|---------|-------------|
| `int` | Quarter (1–4) |

---

### `getQuarterStartEndDate(String year, String month, int kind)`

Returns the start or end date of the quarter that contains the given month.

```java
DateUtils.getQuarterStartEndDate("2023", "12", 1);   // "20231001"
DateUtils.getQuarterStartEndDate("2023", "12", 2);   // "20231231"
```

| Parameter | Description |
|-----------|-------------|
| `year`  | Year |
| `month` | Month |
| `kind`  | `1` = quarter start, `2` = quarter end |

| Returns | Description |
|---------|-------------|
| `String` | Start or end date (`yyyyMMdd`) |

---

### `getWeekday(String year, String month, String day)` / `getWeekday(String date)`

Returns the weekday index (0=Sunday … 6=Saturday) for the given date.

```java
DateUtils.getWeekday("2023", "12", "1");   // 5
DateUtils.getWeekday("20231201");          // 5
```

| Parameter | Description |
|-----------|-------------|
| `year`/`month`/`day` or `date` | Date input |

| Returns | Description |
|---------|-------------|
| `int` | `0`=Sunday … `6`=Saturday |

---

## 7. Date / Time Arithmetic

### `addYear(String date, int year)`

Adds `year` years to `date` (`yyyyMMdd`).

```java
DateUtils.addYear("20231130", 3);   // "20261130"
```

| Parameter | Description |
|-----------|-------------|
| `date` | `yyyyMMdd` date |
| `year` | Years to add (negative = subtract) |

| Returns | Description |
|---------|-------------|
| `String` | Resulting date (`yyyyMMdd`) |

---

### `addMonth(String date, int month)`

Adds `month` months to `date` (`yyyyMMdd`).

```java
DateUtils.addMonth("20231130", 3);   // "20240229"
```

| Parameter | Description |
|-----------|-------------|
| `date`  | `yyyyMMdd` date |
| `month` | Months to add |

| Returns | Description |
|---------|-------------|
| `String` | Resulting date (`yyyyMMdd`) |

---

### `addDay(String date, int day)`

Adds `day` days to `date` (`yyyyMMdd`).

```java
DateUtils.addDay("20231130", 89);   // "20240227"
```

| Parameter | Description |
|-----------|-------------|
| `date` | `yyyyMMdd` date |
| `day`  | Days to add |

| Returns | Description |
|---------|-------------|
| `String` | Resulting date (`yyyyMMdd`) |

---

### `addHour(String time, int hour)` / `addMinute(String time, int min)` / `addSecond(String time, int sec)`

Adds hours / minutes / seconds to an `HHmmss` time string and returns `HHmmss`.

```java
DateUtils.addHour("172956", 30);     // "232956"
DateUtils.addMinute("172956", 30);   // "175956"
DateUtils.addSecond("172956", 30);   // "173026"
```

| Parameter | Description |
|-----------|-------------|
| `time` | `HHmmss` time string |
| `hour`/`min`/`sec` | Amount to add |

| Returns | Description |
|---------|-------------|
| `String` | Resulting time (`HHmmss`) |

---

### `addTime(String time, long amountToAdd, ChronoUnit unit, boolean plus)`

Adds or subtracts `amountToAdd` of `unit` to/from an ISO-8601 datetime string.

```java
DateUtils.addTime("2020-11-17T15:06:09", 30, ChronoUnit.MINUTES, false);
// "2020-11-17T14:36:09"
```

| Parameter | Description |
|-----------|-------------|
| `time`        | ISO-8601 datetime string |
| `amountToAdd` | Magnitude |
| `unit`        | `ChronoUnit` to add (MINUTES, HOURS, DAYS, …) |
| `plus`        | `true` = add, `false` = subtract |

| Returns | Description |
|---------|-------------|
| `String` | Resulting datetime as ISO-8601 |

---

### `diffTime(String time1, String time2)`

Returns the difference (`time1` − `time2`) in milliseconds.

```java
DateUtils.diffTime("2020-11-17T15:06:32.456", "2020-11-17T15:06:09.123");
// 23333
```

| Parameter | Description |
|-----------|-------------|
| `time1`, `time2` | ISO-8601 datetime strings |

| Returns | Description |
|---------|-------------|
| `long` | Difference in milliseconds |

---

## 8. Format Conversion

### `getTimeByFormat(String time, String format)`

Reformats an ISO-8601 datetime into a custom pattern.

```java
DateUtils.getTimeByFormat("2020-11-17T15:06:09", "yyyy년 MM월 dd일 EEE요일");
// "2020년 11월 17일 화요일"
```

| Parameter | Description |
|-----------|-------------|
| `time`   | ISO-8601 datetime string |
| `format` | Target `DateTimeFormatter` pattern |

| Returns | Description |
|---------|-------------|
| `String` | Formatted result |

---

### `getEpochMilliFromFormatTime(String time, String format)`

Parses a formatted date string and converts it to Unix-epoch milliseconds.

```java
DateUtils.getEpochMilliFromFormatTime("2020-11-17 오후 03:06:59", "yyyy-MM-dd a hh:mm:ss");
// 1605593219000
```

| Parameter | Description |
|-----------|-------------|
| `time`   | Date string |
| `format` | `DateTimeFormatter` pattern matching `time` |

| Returns | Description |
|---------|-------------|
| `long` | Unix-epoch milliseconds |

---

### `getTimeByEpochMilli(long epochMilli)`

Converts Unix-epoch milliseconds to a `yyyy-MM-dd HH:mm:ss.SSS` string in the system time zone.

```java
DateUtils.getTimeByEpochMilli(1605593219000L);   // "2020-11-17 15:06:59.000"
```

| Parameter | Description |
|-----------|-------------|
| `epochMilli` | Unix-epoch milliseconds |

| Returns | Description |
|---------|-------------|
| `String` | `yyyy-MM-dd HH:mm:ss.SSS` |

---

### `getDate(String date, String format)`

Parses a formatted date string and returns a `LocalDate`.

```java
LocalDate d = DateUtils.getDate("2020-11-17 오후 03:06:59", "yyyy-MM-dd a hh:mm:ss");
```

| Parameter | Description |
|-----------|-------------|
| `date`   | Date string |
| `format` | `DateTimeFormatter` pattern |

| Returns | Description |
|---------|-------------|
| `LocalDate` | Parsed date |

---

### `getDate(LocalDate date, String format)`

Formats a `LocalDate` with a custom pattern.

```java
DateUtils.getDate(localDate, "yyyy년 MM월 dd일 EEE요일");   // "2020년 11월 17일 화요일"
```

| Parameter | Description |
|-----------|-------------|
| `date`   | `LocalDate` to format |
| `format` | `DateTimeFormatter` pattern |

| Returns | Description |
|---------|-------------|
| `String` | Formatted result |

---

## 9. Age Calculation

### `getAge(int birthYear, int birthMonth, int birthDay)`

Calculates international age: full years since birth, decremented if this year's birthday has not yet passed.

```java
DateUtils.getAge(1981, 9, 4);   // 42
```

| Parameter | Description |
|-----------|-------------|
| `birthYear`/`birthMonth`/`birthDay` | Date of birth |

| Returns | Description |
|---------|-------------|
| `int` | International age |

---

### `getKoreanAge(int birthYear)`

Calculates Korean age = `currentYear − birthYear + 1`.

```java
DateUtils.getKoreanAge(1981);   // 43
```

| Parameter | Description |
|-----------|-------------|
| `birthYear` | Year of birth |

| Returns | Description |
|---------|-------------|
| `int` | Korean age |
