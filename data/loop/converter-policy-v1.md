# Converter policy v1

The source is interpreted as CommonMark with supported GFM extensions. Output targets ordinary Discord message content.

- Preserve meaning before preserving source spelling.
- Keep every message within 2,000 Unicode code points.
- Split at structural boundaries where possible; preserve ordering and separators.
- Close and reopen fenced code blocks when splitting.
- Preserve code content literally and do not activate mentions inside code.
- Neutralize `@everyone`, `@here`, user mentions, and role mentions outside code by default.
- Permit clickable `http:`, `https:`, and `mailto:` URLs; downgrade other and relative URLs to readable non-clickable text.
- Convert tables to aligned fenced text.
- Convert task markers to `☑` and `☐`.
- Convert images to a readable labeled link.
- Resolve reference links when definitions exist.
- Flatten HTML to readable text and warn.
- Preserve math as readable code and warn.
- Convert horizontal rules to a visible Unicode divider.
- Do not invent content or silently omit readable source content.

Warnings should identify material lossy transformations, unsafe URLs, neutralized mentions, unresolved references, and message splitting.
