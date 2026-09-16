# Converter policy v3

The source is interpreted as CommonMark with supported GFM extensions. Output targets ordinary Discord message content.

- Preserve meaning before preserving source spelling.
- Keep every message within 2,000 Unicode code points.
- Split at structural boundaries where possible; preserve ordering and separators.
- Close and reopen fenced code blocks when splitting, preferring line boundaries before hard grapheme boundaries.
- Preserve code content literally and do not activate mentions inside code.
- Neutralize `@everyone`, `@here`, user mentions, and role mentions outside code by default.
- When `neutralizeMentions` is explicitly `false`, preserving active mention syntax is intentional policy-conformant behavior. Critics must not fail a case solely because those configured mentions remain active.
- Permit clickable `http:`, `https:`, and `mailto:` URLs; encode Markdown delimiters in their destinations without changing URL identity.
- Downgrade other and relative URLs to readable non-clickable text. Preserving a visible unsafe or relative destination is allowed; it must not remain clickable.
- Convert tables to aligned fenced text.
- Convert task markers to `☑` and `☐`.
- Convert images to a readable labeled link.
- Resolve reference links when definitions exist and warn for unresolved full or collapsed references outside code.
- Flatten HTML to readable text and warn.
- Preserve parsed math as readable code and warn. Ordinary single-dollar text is not parsed as math.
- Convert horizontal rules to a visible Unicode divider.
- Do not invent content or silently omit readable source content.

## Canonical warning codes

Labels may use only these exact warning codes:

- `lossy-table`: a GFM table became aligned fenced text.
- `math-degraded`: parsed math became readable code/text.
- `html-flattened`: raw HTML outside code was flattened.
- `unresolved-reference`: a full or collapsed reference link could not be resolved.
- `unsafe-url`: an unsafe or relative destination became non-clickable.
- `mentions-neutralized`: one or more active mentions outside code were neutralized.
- `message-split`: output required more than one Discord message.

Warnings are deduplicated by code for scoring. A label must not require warnings for syntax that remains ordinary text or literal code. Unknown, synonymous, or implementation-invented warning names are invalid and require quarantine rather than approximation.

## Semantic matching

Discord escape characters and percent-encoding needed to preserve visible text or safe URL identity are not semantic loss. Message boundaries may interrupt prose whitespace, and reopened code fences may interrupt a literal source span; evaluation must normalize those structural wrappers without weakening content, order, URL-safety, fence-balance, or capacity checks.
