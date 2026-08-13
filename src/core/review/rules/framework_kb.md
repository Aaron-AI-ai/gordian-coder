---
globs: "*.java"
---

#### Framework Knowledge Base Lookup

Check this file's import statements. If any import matches a prefix below,
read the md files in the corresponding KB directory with `file_read` to learn
the framework's correct usage **before making review judgments**. **The longer
(more specific) prefix wins** — e.g. a `kr.co.openlabs.fico.framework.extension.*`
import belongs to the extension KB only; do not judge it by core KB rules.

| import prefix | KB location |
|---|---|
| `kr.co.openlabs.fico.framework.extension.*` | `.fico/kb/fico-fwk-extention/` |
| `kr.co.openlabs.fico.framework.*` (excluding extension) | `.fico/kb/fico-fwk-core/` |
| `kr.co.koscom.pb.framework.site.ext.*` | `.fico/kb/framework-site-ext/` |

Procedure:
1. Match the file's imports against the prefixes above. If no import matches,
   or the project has no `.fico/kb/` directory, this rule does not apply — do
   nothing.
2. On a match, list the files in that KB directory (explore with `code_search`
   or `file_find`), then `file_read` only the documents relevant to the
   classes/APIs this file actually uses. Do not read everything.
3. KB rules are the basis for the `framework` category. When a KB rule
   conflicts with general language/framework conventions, follow the KB rule.
4. Do not guess beyond what the KB documents say; report only violations
   backed by the KB as `framework` category findings.
