# Markdown to Discord — implementation and data plan

## Goal

Build a browser-first converter that accepts CommonMark/GFM and emits safe, readable Discord message text. Conversion must preserve meaning, degrade unsupported constructs explicitly, and split output without corrupting formatting.

## Product boundary

- Runs locally in the browser; no document content is sent to a server.
- Initial output targets ordinary Discord message `content`, not bot-only embeds or Components V2.
- Produces one or more copyable messages, each within Discord's 2,000-character limit.
- Defaults to neutralizing notification-sensitive mentions.
- Does not promise lossless CommonMark/GFM round-tripping.

## Architecture

```text
Markdown source
  → CommonMark/GFM parser
  → source AST
  → policy-based Discord serializer
  → structure-aware message splitter
  → validation and warnings
```

Unsupported features are product-policy decisions, not parser errors:

| Source construct | Initial Discord policy |
|---|---|
| Table | Aligned fenced text table |
| Task item | `☑` / `☐` marker |
| Image | Visible masked link with alt text |
| Reference link/image | Resolve definition and emit inline form |
| Footnote | Append/retain a readable notes representation |
| Raw HTML | Keep readable text; remove markup |
| `<details>` | Flatten to ordinary text |
| Mermaid/math | Preserve in a labeled code block or readable text |
| Horizontal rule | Unicode text separator |
| Excessive nesting | Flatten while retaining hierarchy |

## Data tracks

Keep four kinds of evidence separate:

1. **Specification truth** — CommonMark/GFM interpretation.
2. **Discord observation** — actual client rendering at a recorded client/version.
3. **Converter policy** — our chosen degradation for unsupported structures.
4. **Human preference** — whether users find the result acceptable.

Never call parser disagreement or synthetic labels user ground truth.

### Sources

1. [CommonMark spec fixtures](https://github.com/commonmark/commonmark-spec), BSD-2-Clause.
2. [cmark-gfm](https://github.com/github/cmark-gfm) and the [GFM spec](https://github.github.com/gfm/).
3. [markdown-it fixtures](https://github.com/markdown-it/markdown-it/tree/master/test/fixtures), MIT.
4. [OpenAssistant OASST1](https://huggingface.co/datasets/OpenAssistant/oasst1), Apache-2.0.
5. [WildChat-1M](https://huggingface.co/datasets/allenai/WildChat-1M), ODC-BY 1.0.
6. Carefully license-filtered GitHub Markdown with repository, commit, path, and license provenance.
7. Discord parser baselines: [parse-discord](https://github.com/LyricLy/parse-discord), [discord-md](https://github.com/ciffelia/discord-md), and [discord-markdown-parser](https://github.com/ItzDerock/discord-markdown-parser).

LMSYS/Arena are optional because access is gated. Discord Unveiled is not an acquisition dependency: its cited Zenodo record is deleted, and its messages lack source/expectation pairs.

## First benchmark: approximately 2,000 records

| Category | Target |
|---|---:|
| CommonMark/GFM/parser fixtures | 600 |
| Controlled one-edit mutations | 500 |
| Discord-specific syntax | 300 |
| Unicode, escaping, links, and mentions | 250 |
| Length/performance boundaries | 200 |
| Human-reviewed real-world samples | 150 |

Each record stores source text, expected message array, semantic structure, categories, risk, provenance, mutation lineage, and label origin (`spec`, `policy`, `observed`, `human`, or `synthetic`).

## Mining pipeline

1. Pin upstream source versions and maintain a provenance manifest.
2. Import legally clear conformance examples.
3. Detect risky syntax in OASST1 and WildChat assistant turns.
4. Record aggregate frequencies before retaining raw samples.
5. Stratify by syntax, length, language, model/source, validity, and risk.
6. Deduplicate with normalized hashes, near-duplicate hashes, AST fingerprints, and mutation lineage.
7. Differentially parse with cmark-gfm, markdown-it, remark/mdast, and Discord parser baselines.
8. Generate controlled minimal mutations and preserve parent lineage.
9. Human-review only ambiguous/lossy cases with two reviewers and adjudication.
10. Split datasets by source family and lineage, never random rows.

Privacy rules for conversation corpora:

- Extract assistant turns only unless user context is essential.
- Drop IP hashes, headers, geolocation, user IDs, and unrelated metadata.
- Re-run PII detection; a source `redacted` flag is not proof of anonymity.
- Prefer publishing aggregate frequencies and short reviewed fixtures over republishing corpora.

## Execution discipline

- Every remote input is pinned by version and SHA-256 before processing.
- Downloads use partial files, resume where possible, verify checksums, and promote atomically.
- Long transformations stream inputs and checkpoint after configurable bounded chunks.
- Checkpoints bind to the exact input checksum and fail closed when it changes.
- Reruns are idempotent; completed chunks are not counted twice.
- Raw inputs, working checkpoints, aggregate reports, and releasable fixtures remain separate.
- Validate a deliberately stopped small run before starting a complete scan.
- Keep a concise stage log containing input identity, counts, output identity, and failure state.

See [`docs/data-pipeline.md`](./docs/data-pipeline.md) for commands and recovery behavior.

## Quality gates

- No parser or serializer crashes on bounded input.
- Deterministic output and warnings.
- Every message is at most 2,000 counted characters.
- Fences and inline formatting remain balanced across splits.
- Literal source text must not become an active mention unexpectedly.
- Tests cover 1,999/2,000/2,001 boundaries, CRLF, astral characters, combining marks, ZWJ emoji, RTL text, long URLs, malformed fences, and nested delimiters.
- Fixtures retain URL, commit/version, license, and derivation metadata.

## Milestones

### M0 — foundation

- [x] Record architecture, source, privacy, and benchmark plan.
- [x] Create the TypeScript conversion core and initial regression tests.
- [x] Add reproducible CommonMark fixture acquisition with provenance.
- [x] Define and validate the fixture JSON schema.

### M1 — converter correctness

- [ ] Complete source-AST to Discord serialization policies.
- [ ] Implement structure-aware splitting for every block type.
- [x] Generate and execute-check 500 deterministic one-edit CommonMark mutants with parent lineage.
- [x] Run 500 seeded property cases covering Markdown punctuation, malformed input, Unicode, combining marks, and ZWJ emoji.
- [x] Add the first Discord syntax, mention-safety, and policy fixtures.
- [x] Run all 652 CommonMark 0.31.2 examples through capacity/crash validation.
- [ ] Expand Unicode, malformed-input, and boundary fixtures.
- [ ] Differential-test parser behavior.

### M2 — real-output mining

- [x] Build resumable OASST1 fetcher, streaming scanner, and feature counters.
- [x] Pin, checksum, download, and row-group scan all 14 WildChat shards with metadata minimization.
- [x] Produce complete OASST1 and WildChat prevalence reports plus an OASST1 deterministic feature-stratified candidate sample.
- [x] Extract selected candidates into private, gitignored review data with direct-identifier redaction.
- [ ] Human-review PII and conversion quality before promoting any retained examples.

### M3 — empirical validation

- [ ] Capture current Discord web/desktop/mobile observations in a private test server.
- [ ] Annotate 500–1,000 ambiguous A/B cases.
- [ ] Report agreement by category.
- [ ] Freeze public test and private challenge splits.

### M4 — website

- [x] Build the initial local-only editor, warnings, and per-message copy controls.
- [x] Add an interactive example and baseline SEO metadata/content.
- [x] Add the first indexed Discord Markdown reference guide with measured corpus evidence.
- [ ] Add focused table/splitting pages and an accessible Discord-style preview.
- [x] Deploy static assets to Cloudflare Pages.
- [ ] Register and connect the canonical `markdowntodiscord.com` domain (currently unregistered).
- [ ] Add privacy-preserving aggregate analytics and opt-in feedback.
