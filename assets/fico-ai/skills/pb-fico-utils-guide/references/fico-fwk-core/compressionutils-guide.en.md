# CompressionUtils User Guide

## Overview

`CompressionUtils` is a common utility class provided by the FICO framework.
It provides LZO compression and decompression for strings and binary buffers, with both length-aware and buffer-based decompression paths.

- Package: `kr.co.openlabs.fico.framework.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.openlabs.fico.framework.utils.CompressionUtils;
```

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. LZO compression

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Compress a string with LZO and obtain a binary byte array", "Reduce payload size before sending/storing" | [`compressLzo`](#compresslzostring-data-charset-charset) |

### B. LZO decompression

| Situation | Function |
|-----------|----------|
| "Decompress LZO bytes back into a string when the original length is known" | [`decompressLzoRaw`](#decompresslzorawbyte-compresseddata-int-originallength-charset-charset) |
| "Decompress LZO bytes when the exact original size is unknown — allocate a generous output buffer" | [`decompressLzo`](#decompresslzobyte-compresseddata-int-maxoutputlength) |

> 💡 **What is NOT in CompressionUtils' scope?** Other compression algorithms (gzip, zstd, deflate), Base64 wrapping, file-stream-based compression, and protocol-level framing are not the role of this utility. Use the appropriate algorithm-specific library when those are needed.

---

## 1. LZO Compression

### `compressLzo(String data, Charset charset)`

Compresses a string with LZO and returns the result as a byte array.

The string is first converted to bytes using the supplied charset, then LZO-compressed. Returns `null` if `data` is `null`.

```java
byte[] compressed = CompressionUtils.compressLzo("Hello World", StandardCharsets.UTF_8);
```

| Parameter | Description |
|-----------|-------------|
| `data`    | Source string to compress |
| `charset` | Character encoding used to convert the string to bytes |

| Returns | Description |
|---------|-------------|
| `byte[]` | LZO-compressed byte array; `null` if `data` is `null` |

---

## 2. LZO Decompression

### `decompressLzoRaw(byte[] compressedData, int originalLength, Charset charset)`

Decompresses an LZO byte array directly into a string (no Base64 wrapping).

Requires the **exact original byte length** so the decompressor can allocate the output buffer precisely. Returns `null` if `compressedData` is `null`.

```java
byte[] compressed = ...; // LZO-compressed bytes
String original = CompressionUtils.decompressLzoRaw(compressed, 1000, StandardCharsets.UTF_8);
```

| Parameter | Description |
|-----------|-------------|
| `compressedData` | LZO-compressed byte array |
| `originalLength` | Exact byte length of the original (uncompressed) data |
| `charset`        | Character encoding used to decode the decompressed bytes |

| Returns | Description |
|---------|-------------|
| `String` | Decompressed string; `null` if `compressedData` is `null` |

---

### `decompressLzo(byte[] compressedData, int maxOutputLength)`

Decompresses an LZO byte array into a byte array using a caller-allocated output buffer size.

Used when the **exact** original length is unknown — supply a `maxOutputLength` that is at least the original size; the returned array is trimmed to the actual decompressed size. Returns `null` if `compressedData` is `null`.

```java
byte[] compressed = ...; // LZO-compressed bytes
byte[] original = CompressionUtils.decompressLzo(compressed, compressed.length * 10);
```

| Parameter | Description |
|-----------|-------------|
| `compressedData`  | LZO-compressed byte array |
| `maxOutputLength` | Maximum output buffer size (must be ≥ original data size) |

| Returns | Description |
|---------|-------------|
| `byte[]` | Decompressed byte array, trimmed to the actual decompressed size; `null` if `compressedData` is `null` |
