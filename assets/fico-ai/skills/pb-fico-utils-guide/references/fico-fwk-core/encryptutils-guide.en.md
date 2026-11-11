# EncryptUtils User Guide

## Overview

`EncryptUtils` is a common utility class provided by the FICO framework.
It provides one-way hashing (SHA-256, Blake2b) for password / token digests and symmetric encryption (AES/GCM) for reversible ciphertexts.

- Package: `kr.co.openlabs.fico.framework.utils`
- All methods are `static`; no instantiation required

```java
import kr.co.openlabs.fico.framework.utils.EncryptUtils;
```

> ⚠️ **About the secret key.** The AES key is set automatically by the framework at boot time via [`setKey`](#setkeystring-key). **Do not call `setKey` from application code.**

---

## 🎯 Situational Function Selection Guide

> **Core index for AI/developers reading this doc.** Find the row that matches your situation in the table below and jump to the corresponding function.

### A. One-way hashing (password / token digest)

| Situation (trigger phrase) | Function |
|---------------------------|----------|
| "Hash a password with the framework default (SHA-256, salted, lowercase hex)" | [`encrypt`](#encryptstring-password) |
| "Hash a string with SHA-256 with explicit salt / case options" | [`encryptSha256`](#encryptsha256string-plaintext-boolean-usingsalt-boolean-tolowercase) |
| "Hash a long-typed number with Blake2b, output a fixed-length numeric string" | [`encryptNumberByBlake2b`](#encryptnumberbyblake2blong-plainnumber-int-digestsize-char-padchar) |

### B. Symmetric (reversible) encryption

| Situation | Function |
|-----------|----------|
| "Encrypt a value that must be decrypted later (configuration, persisted secret, …)" | [`encryptAES`](#encryptaesstring-plaintext) |
| "Decrypt an AES-GCM ciphertext produced by `encryptAES`" | [`decryptAES`](#decryptaesstring-ciphertext) |

### C. Framework-level key setup

| Situation | Function |
|-----------|----------|
| "Set the secret AES key (framework boot only — do **not** call from business code)" | [`setKey`](#setkeystring-key) |

> 💡 **What is NOT in EncryptUtils' scope?** Asymmetric (RSA/EC) crypto, signing/verification, key management/rotation, HMAC, and TLS-level concerns are not the role of this utility.

---

## 1. Framework Key Setup

### `setKey(String key)`

Sets the AES secret key bytes used by [`encryptAES`](#encryptaesstring-plaintext) / [`decryptAES`](#decryptaesstring-ciphertext).

> ⚠️ **Called automatically at framework boot. Do not invoke from business code.**

| Parameter | Description |
|-----------|-------------|
| `key` | Secret key string (bytes are stored as-is) |

---

## 2. One-Way Hashing

### `encrypt(String password)`

Framework default password hash. Equivalent to `encryptSha256(password, true, true)` (salted, lowercase hex).

```java
EncryptUtils.encrypt("test password !234");
// → "f5abf5fa6bb8b2b9232121be40c73e1b46a47daa6b9ae048638ce410a27b5c96"
```

| Parameter | Description |
|-----------|-------------|
| `password` | Plain-text password |

| Returns | Description |
|---------|-------------|
| `String` | SHA-256 hex digest |

---

### `encryptSha256(String plainText, boolean usingSalt, boolean toLowerCase)`

SHA-256 hash with explicit salt and case options.

```java
EncryptUtils.encryptSha256("test password !234", true, false);
// → "F5ABF5FA6BB8B2B9232121BE40C73E1B46A47DAA6B9AE048638CE410A27B5C96"
```

| Parameter | Description |
|-----------|-------------|
| `plainText`   | Plain-text input |
| `usingSalt`   | `true` to prepend the built-in salt before hashing |
| `toLowerCase` | `true` for lowercase hex; `false` for uppercase |

| Returns | Description |
|---------|-------------|
| `String` | SHA-256 hex digest |

---

### `encryptNumberByBlake2b(long plainNumber, int digestSize, char padChar)`

Hashes a numeric value with Blake2b and returns a numeric-only string of the requested fixed length.

The digest byte length is derived from `digestSize`: 4 bytes for `digestSize < 12`, 5 bytes for `digestSize < 15`, otherwise 6 bytes. If the numeric digest is shorter than `digestSize`, it is right-padded with `padChar`.

```java
EncryptUtils.encryptNumberByBlake2b(1234567890L, 16, '6');
// → "6496732688349566"
```

| Parameter | Description |
|-----------|-------------|
| `plainNumber` | Source long value |
| `digestSize`  | Output length (10 ≤ size ≤ 16) |
| `padChar`     | Right-padding character |

| Returns | Description |
|---------|-------------|
| `String` | Numeric-character string of length `digestSize` |

Throws `CommonException` if `digestSize` is outside `[10, 16]`.

---

## 3. Symmetric (AES/GCM) Encryption

### `encryptAES(String plainText)`

Encrypts plain text using AES/GCM/NoPadding. A random 16-byte IV is generated per call and **prepended** to the ciphertext before Base64 encoding, so the result is self-contained and decryptable by [`decryptAES`](#decryptaesstring-ciphertext).

If `plainText` is `null` / empty or the key has not been set, the input is returned as-is.

```java
EncryptUtils.encryptAES("test password !234");
// → "BHSB94UO+frzARouxTD9HIJdhcXVecFbF+LLxgtL5lCNZKqPUcv20b1l/a8baT9TVlM="
```

| Parameter | Description |
|-----------|-------------|
| `plainText` | Plain-text input |

| Returns | Description |
|---------|-------------|
| `String` | Base64(`IV` ‖ AES-GCM ciphertext); input as-is if empty/null or key unset |

---

### `decryptAES(String cipherText)`

Decrypts a Base64-encoded `IV` ‖ AES-GCM ciphertext produced by [`encryptAES`](#encryptaesstring-plaintext).

If `cipherText` is `null` / empty or the key has not been set, the input is returned as-is.

```java
EncryptUtils.decryptAES("BHSB94UO+frzARouxTD9HIJdhcXVecFbF+LLxgtL5lCNZKqPUcv20b1l/a8baT9TVlM=");
// → "test password !234"
```

| Parameter | Description |
|-----------|-------------|
| `cipherText` | Base64-encoded `IV` ‖ ciphertext |

| Returns | Description |
|---------|-------------|
| `String` | Decrypted plain text; input as-is if empty/null or key unset |
