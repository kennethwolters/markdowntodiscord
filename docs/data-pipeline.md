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
