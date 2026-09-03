---
globs: "*.java"
---

#### Framework Knowledge Base

Imports under the prefixes below belong to the in-house framework, not to the
project and not to a third-party library. **The longer (more specific) prefix
wins** — a `kr.co.openlabs.fico.framework.extension.*` import belongs to the
extension KB only; do not judge it by core KB rules.

| import prefix | KB location |
|---|---|
| `kr.co.openlabs.fico.framework.extension.*` | `.fico/kb/fico-fwk-extension/` |
| `kr.co.openlabs.fico.framework.*` (excluding extension) | `.fico/kb/fico-fwk-core/` |
| `kr.co.koscom.pb.framework.site.ext.*` | `.fico/kb/framework-site-ext/` |

How to use them:

1. KB documentation is the basis for the `framework` category. When it conflicts
   with general language or framework conventions, follow the KB.
2. Do not guess beyond what the KB documents say. Report only violations backed
   by the KB as `framework` category findings.
3. A matching import with no KB page is simply undocumented — a gap in the KB,
   not a finding. Do not hunt for it.
