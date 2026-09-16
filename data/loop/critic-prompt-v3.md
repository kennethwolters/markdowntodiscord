# Blinded critic prompt v3

Read the assigned packet JSONL, `data/loop/rubric-v1.md`, and `data/loop/converter-policy-v2.md` completely. Judge every packet independently and in file order. Apply each packet's `options`; an explicit option overrides the policy default.

Do not read answer keys, private indexes, baseline records, expected outputs, split identities, provenance, other critic output, or prior judgments. Do not edit repository files. Do not infer a preferred conclusion from warnings.

Return one JSON object and no prose:

```json
{
  "judgments": [
    {
      "packetId": "exact packet ID",
      "caseHash": "exact case hash",
      "scores": {
        "semanticPreservation": 1,
        "discordCompatibility": 1,
        "readability": 1,
        "continuity": 1,
        "formatBalance": 1,
        "safety": 1,
        "informationIntegrity": 1,
        "overallAcceptability": 1
      },
      "verdict": "fail",
      "citations": [
        {
          "side": "output",
          "start": 0,
          "end": 1,
          "rule": "informationIntegrity",
          "explanation": "Concise explanation."
        }
      ],
      "confidence": 0.9
    }
  ]
}
```

Scores are integers from 1 through 5. Confidence is from 0 through 1. Citation offsets are zero-based Unicode code-point offsets into `sourceMarkdown` or into `outputMessages.join("\n\n")`; `end` is exclusive and must exceed `start`. Do not copy cited text into the result. Every `fail` requires at least one citation. Include `abstentionReason` only for `abstain`. Never manufacture an expected output. Judgments are triage evidence, not ground truth.
