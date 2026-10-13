---
globs: "*.java"
---

#### Fix Code Conventions (Java)
How to WRITE a corrected code fragment, as opposed to how to find the defect. Applies whenever a proposed fix, resolution snippet, or suggested edit targets a `.java` file.

##### Prefer Lombok over hand-written boilerplate
- Always prefer Lombok annotations over hand-written boilerplate in the fix, regardless of whether the target class already imports `lombok.*`:
  - `@NoArgsConstructor` / `@AllArgsConstructor` / `@RequiredArgsConstructor` instead of a manual constructor
  - `@NonNull` on a constructor/setter parameter instead of a manual null check
  - `@Getter` / `@Setter` / `@Data` instead of manual accessors
  - `@Builder` instead of a manual builder
- If the class does not yet import Lombok, add the needed `import lombok....;` line(s) as part of the fix.

##### Lombok placement — class level only
- `@NoArgsConstructor`, `@AllArgsConstructor`, `@RequiredArgsConstructor`, `@Data`, `@Getter`, `@Setter` and `@Builder` are CLASS-level annotations (Lombok declares each with `@Target(TYPE)`). Place them on the class declaration itself — never on a constructor, field or method.
- Adding `@NoArgsConstructor` to a class that already has an explicit constructor is valid: Lombok generates a separate no-args constructor alongside it. Annotating the existing constructor directly is a compile error, not a variant spelling.

```java
// correct
@NoArgsConstructor
static class NoCtor {
    @FixedData(length = 5)
    String x;

    NoCtor(int i) { this.x = String.valueOf(i); }
}

// wrong — @Target(TYPE) annotation on a constructor does not compile
static class NoCtor {
    @NoArgsConstructor
    NoCtor(int i) { this.x = String.valueOf(i); }
}
```

##### Cite error/message codes exactly as the source spells them
- When an explanation or fix cites an error/message code (e.g. FWKE0002), quote it exactly as the symbol appears in the file actually read — the typed constant (e.g. `MessageCode.FWKE0002`) and its real call shape (e.g. `CommonException.create(MessageCode.FWKE0002, "commonHeader를")`) — never a paraphrased bare string literal such as `create("FWKE0002")`.
- Do not conflate exception hierarchies: `CommonException.create(MessageCode.X, ...)` (framework, typed constant) and `PBOnlineException.create("nnnn", ...)` (online fixed-length, bare string code) are different classes with different signatures. Use the one the surrounding code actually throws.
- If the file that throws the code has not been opened, do not invent its call signature — say so instead.
