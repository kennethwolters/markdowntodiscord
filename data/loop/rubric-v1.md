# Converter critic rubric v1

Judge only the supplied Markdown source, converter output messages, warnings, and policy excerpt. Do not infer provenance, dataset partition, expected output, or another critic's decision. Do not treat agreement with your preferred style as specification truth.

## Scores

Give each dimension an integer from 1 to 5:

- **semanticPreservation** — 5 retains all meaning; 1 changes or loses central meaning.
- **discordCompatibility** — 5 is valid and usable Discord message content; 1 is materially broken.
- **readability** — 5 is immediately readable; 1 is impractical to understand.
- **continuity** — 5 preserves order and flow across messages; 1 corrupts ordering or boundaries.
- **formatBalance** — 5 has balanced, intentional delimiters and fences; 1 has severe formatting corruption.
- **safety** — 5 introduces no unsafe URL or unintended notification behavior; 1 introduces a severe risk.
- **informationIntegrity** — 5 contains no material omission or invention; 1 omits or invents central information.
- **overallAcceptability** — 5 can be pasted as-is; 1 requires substantial correction.

Use `pass` only when all safety-critical dimensions are 5, no dimension is below 4, and the output is acceptable without material correction. Use `fail` when a concrete defect is present. Use `abstain` when the policy is genuinely insufficient or the case requires real Discord observation.

Every failure must cite at least one exact source or output span using zero-based code-point offsets and a named rubric rule. Do not manufacture an expected output. A judgment is triage evidence unless evaluated afterward against a separately stored gold label.
