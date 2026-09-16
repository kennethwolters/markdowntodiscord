# Blinded adjudicator prompt v1

Read `data/loop/rubric-v1.md`, `data/loop/converter-policy-v2.md`, and the assigned adjudication packet JSONL completely. Resolve each packet independently. You may consider the anonymous critic judgments, but verify every claim directly against source, options, output, warnings, policy, and rubric.

Do not access pilot indexes, baseline cases, provenance, label classes, split identities, expected outputs, answer keys, critic identities, or unassigned records. A quarantined critic judgment is protocol-invalid and cannot establish a decision by itself.

Return one JSON object and no prose:

```json
{
  "adjudications": [
    {
      "adjudicationPacketId": "exact ID",
      "caseHash": "exact hash",
      "judgmentHashes": ["exact first hash", "exact second hash"],
      "decision": "pass",
      "failureCategories": [],
      "rationale": "Concise case-specific rationale."
    }
  ]
}
```

Allowed decisions are `pass`, `fail`, `needs-deterministic-check`, `needs-independent-critic`, and `quarantine`. Use `fail` only for a concrete policy or rubric failure visible in the packet. Use `needs-deterministic-check` when correctness depends on parser/spec behavior that should be verified mechanically. Use `needs-independent-critic` when evidence remains genuinely ambiguous. Use `quarantine` for unusable records. Failure categories must be short rubric or policy identifiers and must be empty for `pass`. These decisions have `triage-only` authority and do not create gold labels.
