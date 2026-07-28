# Framework Conventions (Authoritative)

These rules describe the in-house commercial framework this project is built on.
They **override** general language/framework best practices. When a generic
convention (e.g. standard Spring guidance) conflicts with a rule here, follow
the rule here — and word the suggestion accordingly.

## Dependency Injection (DI)
- ✅ Use field injection with `@Autowired`.
- ❌ Do NOT use Lombok `@RequiredArgsConstructor` or constructor injection.
- Violation pattern: a class annotated with `@RequiredArgsConstructor` whose
  dependencies are declared as `private final Xxx`.
  - **Suggestion**: remove `@RequiredArgsConstructor`, and declare each
    dependency as `@Autowired private Xxx` (drop `final`).
- Note: this is the OPPOSITE of standard Spring guidance (which prefers
  constructor injection). The framework rule takes precedence — never suggest
  switching to constructor injection.

<!--
Add more framework rules below. For each rule state:
  1) the rule, 2) the violation pattern, 3) the concrete suggestion.
This file is bundled into the plugin at build time. A project may override it
by setting "frameworkGuide": "<path>" in .f-review.json.
-->
