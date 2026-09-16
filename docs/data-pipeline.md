# Repeatable data pipeline

## Directory contract

- `data/raw/` — immutable downloaded inputs; ignored by Git.
- `data/work/` — resumable checkpoints and intermediate state; ignored by Git.
- `data/reports/` — deterministic aggregate outputs suitable for review.
- `data/spec/` — pinned, redistributable specification fixtures and provenance manifests.

Never modify a raw input in place. Every stage validates the upstream checksum recorded in its manifest.

## OASST1 sequence

```bash
npm run data:oasst:fetch
npm run data:oasst:scan -- --chunk-size 5000
npm run data:oasst:sample -- --chunk-size 5000 --per-feature 25
npm run data:oasst:extract -- --chunk-size 5000
```

The fetcher:

- pins a specific release filename and SHA-256;
- downloads to `.part`;
- resumes with an HTTP range request when supported;
- verifies byte length and checksum;
- atomically promotes the completed file.

The scanner:

- streams the gzip JSONL rather than loading it into memory;
- analyzes assistant rows only;
- persists an atomic checkpoint every bounded chunk;
- validates the source checksum before resuming;
- stores aggregate counts only;
- verifies the compressed source byte length and SHA-256 before every new, resumed, or completed scan.

Feature counts are lexical prevalence signals used for sampling. They are not claims that a construct is parser-valid. In particular, `unbalanced_fence_candidate` uses a stateful marker/length heuristic and requires parser or human confirmation.

Test checkpoint/resume deliberately:

```bash
npm run data:oasst:scan -- --reset --chunk-size 1000 --stop-after 2500
npm run data:oasst:scan -- --chunk-size 1000
```

The second command resumes after the recorded source row. `--reset` resets derived scan state; it never deletes or changes the raw source.

The candidate sampler independently checkpoints a deterministic bottom-k sample per feature. Its private index stores source row numbers and text hashes, but no content or user identifiers. The extraction stage verifies that index and every selected text hash, applies direct-identifier redaction, and writes only to gitignored `data/work/`. Every extracted record remains `private-review-only` and requires human PII review before promotion.

```bash
npm run data:oasst:sample -- --reset --chunk-size 1000 --per-feature 25 --stop-after 2500
npm run data:oasst:sample -- --chunk-size 5000 --per-feature 25
npm run data:oasst:extract -- --reset --chunk-size 1000 --stop-after 2500
npm run data:oasst:extract -- --chunk-size 5000
```

## WildChat sequence

WildChat is pinned to revision `7d6490e462285cf85d91eabea0f9a954fbddcd1f`. Its 14 Parquet shards total 3,360,836,020 bytes. Raw shards remain gitignored.

```bash
# A bounded first checkpoint
npm run data:wildchat:fetch -- --max-shards 1
npm run data:wildchat:scan -- --reset --max-shards 1 --stop-after-groups 5
npm run data:wildchat:scan -- --max-shards 1

# Continue to the complete corpus
npm run data:wildchat:fetch
npm run data:wildchat:scan
```

The fetcher verifies every shard against the committed byte length and SHA-256 manifest and automatically discards invalid complete/oversized partial files. The scanner uses pinned `pyarrow` through `uv`, reads one Parquet row group at a time, retains assistant text only in memory, and atomically checkpoints after each row group. `assistantTurns` means assistant-role turns with string content and is the denominator for feature rates; `conversations` counts Parquet rows. Reports contain aggregate counts only and exclude prompts, message text, IP hashes, headers, and geography.

## Closed-loop public baseline

The first agentic-optimization substrate contains policy gold cases plus invariant-only CommonMark and controlled-mutation cases. Synthetic and CommonMark cases do not become semantic Discord ground truth.

```bash
npm run loop:prepare
npm run loop:validate
npm run loop:replay
```

`loop:prepare` assigns train, validation, and public-test partitions by SHA-256 of source lineage, keeping every mutant with its CommonMark parent. It runs every conversion twice, checks determinism, capacity, fence balance, active-mention absence, and conformance with the configured mention policy. Explicit mention opt-out remains policy-conformant but is reported separately from active-mention absence. The command refuses to publish a baseline with any gold or gating-invariant failure, then atomically writes `data/loop/baseline-v1/`. The manifest binds source files, converter/dependency hashes, Node, platform, architecture, ICU, Unicode, and segmentation locale.

`loop:validate` compiles all loop JSON Schemas, binds every case to its source record and content hash, recomputes source/artifact/converter hashes, verifies lineage partitions, and independently recomputes the report. `loop:replay` executes every conversion without writing and requires byte-exact agreement with committed cases and metrics. CI runs both. Replay fails closed unless Node, ICU, Unicode, and the segmentation locale exactly match the manifest's `node-icu-unicode-locale-v1` policy. Platform and architecture are recorded but may differ because the replayed converter and parser dependency graph are pure JavaScript; any future native or platform-sensitive dependency requires a new compatibility policy. The private challenge set is deliberately absent from this public baseline.

Prepare the first blinded critic pilot locally:

```bash
npm run loop:pilot:prepare
npm run loop:pilot:validate
npm run loop:pilot:combine -- --output data/work/loop-pilot-v1/critic.json --shard path/to/part-001.json --shard path/to/part-002.json
npm run loop:pilot:score -- --critic luna:provider:model=data/work/loop-pilot-v1/critic-luna.json --critic sol:provider:model=data/work/loop-pilot-v1/critic-sol.json
npm run loop:adjudication:prepare
npm run loop:calibration:prepare
npm run loop:calibration:validate
npm run loop:calibration:score -- --critic first=path/to/first.json --critic second=path/to/second.json
```

This deterministically selects all 18 public policy-gold cases and 482 train-only invariant cases, then writes 500 randomized packets under ignored `data/work/loop-pilot-v1/`. Critic packets contain source, converter output, warnings, and hashes of the versioned rubric and policy. They omit provenance, split identity, expected output, label class, and gold decisions. The separate private index is unavailable to critics and is used only for post-judgment calibration.

The 500-case pilot packet file is also emitted as two ordered 250-case shards so each critic can work within a bounded context. Shard combination rejects duplicate packet IDs, and scoring rejects missing cases, unknown cases, invalid citations, hash mismatches, and schema-invalid output. Pilot judgments are normalized to durable judgment records, then routed as no-review, disagreement, unanimous failure, abstention, or protocol-invalid. Invariant-only judgments remain triage-only. Protocol-invalid judgments are never silently repaired: after bounded correction attempts they may be explicitly quarantined with `--quarantine critic:packet`, excluded from agreement denominators, and routed to adjudication. Adjudication packets hide provenance, label class, split, critic identity, and expected output.

Critic calibration uses 18 correct policy outputs and 18 deterministically corrupted negative controls covering omissions, active-mention invention, unbalanced fences, and over-capacity output. Positive and negative identities live only in the ignored answer key. Critics receive explicit conversion options but not the answer. Outputs must satisfy `loop-critic-output.schema.json` before scoring; protocol-invalid outputs are retained as failed calibration attempts rather than repaired into evidence. The first valid two-model calibration scored 35/36 for Luna and 36/36 for Sol, with 35/36 verdict agreement. Luna's sole false failure rejected intentionally active mentions under `neutralizeMentions=false`. Policy v2 made that override explicit; the fresh policy-v2 calibration then scored 36/36 for both critics with 36/36 agreement. Aggregate evidence is committed in `data/reports/critic-calibration-v1.json` and `data/reports/critic-calibration-v2.json`.

## Operational rules

1. Run one acquisition or transformation stage at a time.
2. Pin source URL/version/checksum before processing.
3. Use bounded chunks and atomic checkpoint replacement.
4. Make reruns idempotent.
5. Fail closed on source/checkpoint mismatch.
6. Keep raw text out of aggregate reports.
7. Record record counts and privacy transformations at every boundary.
8. Validate a small chunk before a full run.
9. Compare final counts against source documentation.
10. Commit code, manifests for redistributable inputs, and aggregate reports—not private/raw corpora.
