# Semantic model rubric v2

Evaluate each packet independently in a fresh context. Do not inspect the current converter, another labeler response, provenance, portfolio bucket, lineage, or split. Your output is model-generated silver evidence, never human or observed ground truth.

## Privacy gate

Reject or request redaction for direct identifiers, credentials, sensitive personal facts, or identifying combinations of quasi-identifiers. A redacted source is a new candidate with a new content hash. Synthetic boundary cases containing only obvious placeholders may be approved. When uncertain, do not label.

## Label construction

Use an **exact** label only when the pinned converter policy determines canonical messages and warning codes. List every genuinely acceptable exact variant.

Use a **semantic** label when several readable Discord renderings could satisfy policy. Assertions must jointly cover every material obligation exercised by the source:

- each meaningful source content unit that must remain readable;
- text that must not be invented;
- URLs retained or removed;
- warning obligations;
- ordering and cross-message continuity;
- active-mention safety.

Prefer short discriminative spans, but do not use a single token to stand in for a multi-part source. For multi-section, list, table, or split-boundary inputs, include enough required spans and ordered groups to detect omission of any material section. Required and forbidden assertions must not overlap or contradict one another. Abstain when the policy is ambiguous; reject cases unsuitable for durable evaluation.

## Unconditional quality dimensions

A passing conversion must be deterministic, avoid crashes, keep every message within configured capacity, preserve meaning and ordering, avoid material omission or invention, retain readable unsupported content, keep formatting and fences balanced, satisfy URL and mention safety policy, and preserve continuity across message splits. The scorer enforces deterministic invariants even when a semantic label omits them.

## Independence and authority

Two fresh GPT-5.6 Luna high-thinking runs label each blinded packet with different presentation orders. Exact normalized agreement may be frozen as `dual-luna-consensus` silver evidence for ordinary validation cases. This is repeat-run consistency, not independent ground truth. Disagreements, challenge cases, and designated high-impact cases require a separate blinded GPT-6 Astra xhigh escalation and remain silver evidence. Model evidence never becomes specification, observed Discord, or human gold solely through agreement.
