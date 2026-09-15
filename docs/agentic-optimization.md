# Agentic optimization strategy

## Objective

Continuously improve the deterministic Markdown-to-Discord transformer using a closed loop of dataset sampling, independent agent evaluation, adjudication, failure clustering, patch generation, adversarial expansion, and regression gating.

The agents do not replace the production converter. They optimize its explicit rules and generate durable evidence. The shipped converter remains deterministic, browser-only, inspectable, and independent of model inference.

## Operating principles

1. Treat specification truth, observed Discord behavior, converter policy, and human preference as different label types.
2. Never convert model confidence or agent agreement into ground truth. Ground truth must come from versioned specification fixtures, explicit policy fixtures, recorded Discord observations, or independently human-reviewed gold labels.
3. Keep the optimizer blind to frozen validation and challenge examples.
4. Split by source family, repository, and mutation lineage rather than random records.
5. Require every accepted fix to add a minimized regression fixture.
6. Reject aggregate improvements that introduce safety, capacity, or severe category regressions.
7. Preserve exact provenance, license, content hashes, evaluator versions, prompts, and decisions.
8. Keep raw conversational data and uncertain PII in ignored local storage.
9. Make every long-running stage bounded, checkpointed, deterministic, resumable, and idempotent.

## Closed loop

```text
Pinned source corpora
  -> privacy and license gates
  -> deterministic stratified sampler
  -> current converter output
  -> independent critic agents
  -> blind adjudicator
  -> accepted labels or quarantine
  -> failure clustering and minimization
  -> optimizer proposes one bounded patch
  -> adversarial neighbors generated from failures
  -> deterministic tests and frozen evaluation gates
  -> accept or reject with measured delta
  -> versioned corpus, policy, and converter release
  -> repeat
```

No stage may silently rewrite earlier labels. Corrections are appended as new label versions with supersession metadata.

## Data portfolio

Raw volume is not the main bottleneck. The project already has nearly two million real assistant turns. The bottleneck is converting representative examples into reliable, leakage-resistant evidence.

| Source | Target scale | Role | Publication policy |
|---|---:|---|---|
| CommonMark/GFM/parser fixtures | 5,000-15,000 | Syntax and parser truth | Public when license permits |
| Permissively licensed GitHub Markdown | 250,000 unique files | Authored documentation structures | Public metadata; excerpts only when license/attribution permits |
| WildChat-1M | 25,000-50,000 stratified cases from 1,960,074 turns | Real model-output distribution | Private processing; reviewed excerpts only |
| OASST1 | 5,000 stratified cases from 55,668 assistant turns | Multilingual real output | Private processing; reviewed excerpts only |
| Failure-derived adversarial cases | 100,000-500,000 | Dense boundary and interaction coverage | Public if derived only from releasable seeds |
| Discord-observed fixtures | 1,000-5,000 | Client rendering behavior | Public sanitized observations |
| Human/adjudicated preference cases | 5,000-10,000 | Readability and policy choices | Publish only cleared records |
| Frozen private challenge set | 2,000-5,000 | Final unbiased gate | Never exposed to optimizer agents |

### Licensed GitHub acquisition

Collect `.md` and selected `.mdx` files only from repositories with verified permissive licensing such as MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, or CC0.

For every file retain:

- repository URL and owner
- exact commit
- repository-relative path
- detected SPDX license and evidence path
- upstream blob identifier
- raw and normalized SHA-256
- byte and code-point counts
- acquisition timestamp and collector version

Deduplicate exact normalized content, copied templates, generated API references, badge-only files, vendored documentation, and near-identical forks. Assign all files from one repository family to a single split.

Do not treat public GitHub issues or comments as licensed by the repository. Do not ingest them without a separate rights analysis.

### Real-output sampling

Sample by feature and intersection rather than uniformly. Initial strata include:

- code fence plus more than 2,000 code points
- table plus long output
- HTML plus nested lists
- unbalanced fence plus inline formatting
- links with parentheses, spaces, escapes, or unsafe schemes
- active mention syntax inside and outside code
- multilingual and right-to-left text with Markdown
- combining marks and ZWJ emoji near split boundaries
- rare task-list, image, reference-link, math, and Mermaid cases

Use deterministic bottom-k selection keyed by content hash. Cap any source, model, language, or near-duplicate cluster so common templates cannot dominate.

## Durable record types

### Source record

Stores immutable content identity, provenance, licensing, privacy state, feature detections, lineage, and split assignment.

### Conversion run

Stores converter commit, policy version, options, output messages, warnings, runtime, and invariant results.

### Gold label

Stores a versioned expected output or decision label, its permitted origin (`spec`, `policy`, `observed`, or independently human-reviewed `human`), reviewer and adjudication evidence where applicable, rubric version, and supersession history. Every `observed` label must also record Discord client surface (web, desktop, Android, or iOS), client/build version and release channel, operating system, locale, capture timestamp, relevant server/channel/message settings, test-account and mention policy, source and sent payload hashes, and hashes of screenshot or accessibility-tree observation artifacts. Observed labels missing this identity are rejected, and results from different client identities are reported separately. Gold cases are the only cases used for correctness and patch-acceptance metrics. Agent-produced labels are never promoted to gold solely through agreement or confidence.

### Agent judgment

Stores evaluator role, provider/model identifier, prompt-template hash, rubric version, randomized presentation order, categorical scores, cited spans, confidence, abstention reason, and judgment hash. Unless compared with an existing gold label, an agent judgment is triage evidence or a candidate label, not ground truth.

### Adjudication record

Stores blinded input-judgment hashes, consensus or quarantine status, rationale, disagreement categories, and supersession links.

### Optimization attempt

Stores the failure cluster, proposed patch, generated tests, train/validation metrics before and after, gate outcomes, compute cost, and accepted or rejected status.

## Evaluator architecture

### Critics

Use at least two independent critics with fresh context. They receive only the source, converter output, explicit policy, and rubric. They do not receive provenance, split identity, other judgments, gold labels, or expected conclusions while judging. Calibration jobs score their blinded decisions afterward against a separately stored, independently human-reviewed gold set. Agent judgments on non-gold records remain triage or candidate-label evidence unless a human review process promotes them.

Each critic scores:

- semantic preservation
- Discord syntax compatibility
- unsupported-construct readability
- message ordering and continuity
- balanced formatting and fences
- URL and mention safety
- information omission or invention
- overall acceptability

A failure must cite exact input and output spans and one or more rubric rules. Critics may abstain.

### Adjudicator

The adjudicator sees anonymized critic records in randomized order. It may:

- accept a supported pass
- accept a specific failure label
- request a deterministic check
- request another independent critic
- quarantine the example as ambiguous

It may not create an expected output solely to break a tie. Consensus without an existing gold label may prioritize a case or propose a candidate label, but cannot make that case eligible for correctness or patch-acceptance metrics. Promotion requires the appropriate specification, policy, observed, or independent human-review path.

### Failure analyst

Clusters adjudicated failures by root transformation rule, not superficial syntax. It produces:

- suspected responsible function or policy
- minimal triggering structure
- affected strata
- severity and frequency estimates
- representative record hashes
- counterfactual cases that should continue passing

### Optimizer

Receives one bounded failure cluster, relevant training examples, current policy, and code scope. It proposes one minimal patch and accompanying tests. It cannot access frozen holdouts, modify evaluation scripts, lower thresholds, or relabel failures.

### Gatekeeper

Runs in fresh context and independently recomputes metrics from immutable inputs. It has sole authority to recommend acceptance. The parent process applies accepted changes and records the decision.

## Adversarial expansion

For every confirmed failure, minimize the source while preserving the failure, then generate controlled neighbors:

- 1,999, 2,000, and 2,001 code-point forms
- LF and CRLF forms
- one additional nesting level
- balanced and unbalanced delimiters
- safe and notification-sensitive mention variants
- inline and block placement
- astral, combining-mark, ZWJ, and RTL variants
- adjacent block and separator variants
- link destinations with spaces, parentheses, and unsafe schemes

Every mutation records its parent hash, operation, seed, generator version, and expected invariant. Synthetic neighbors remain grouped with their parent for data splitting.

## Scoring

Report both global and per-stratum results. Never hide a rare severe regression behind a common-category improvement.

### Deterministic metrics

- crash-free rate
- deterministic-output rate
- messages within configured capacity
- balanced fence rate
- Unicode grapheme-boundary preservation
- mention-neutralization violations
- allowed URL-scheme violations
- exact policy-fixture agreement
- runtime and peak memory by input-size bucket

### Adjudicated metrics

- semantic preservation pass rate
- readability pass rate for lossy constructs
- cross-message continuity pass rate
- unsupported-feature policy agreement
- severe omission or invention rate
- critic agreement, adjudicator override, and abstention rates

Include Wilson confidence intervals for descriptive pass rates and paired bootstrap intervals for exploratory score deltas. Show counts alongside percentages. Confidence intervals alone do not authorize patch acceptance; the pre-registered decision rule below does.

## Acceptance gate

Before evaluating a patch, write an immutable attempt manifest that pre-registers the target cluster, primary metric, protected strata, minimum sample sizes, non-inferiority margins, statistical tests, multiplicity family, alpha allocation, and maximum number of attempts. Do not select the test after seeing results.

For binary paired outcomes use an exact paired test such as McNemar's test; for scored paired outcomes use a pre-specified paired permutation test. Control family-wise error across the primary and protected-stratum claims with Holm-Bonferroni at `alpha = 0.05`. Require at least 100 eligible gold cases for a stratum-level claim unless the gate is a zero-tolerance deterministic invariant. Non-inferiority requires the lower bound of the pre-registered one-sided 95% confidence interval for the paired delta to exceed `-1` percentage point. If repeated looks are allowed, pre-register an alpha-spending sequential design instead.

A proposed patch is accepted only when all conditions hold:

1. Unit, property, fixture, CommonMark, and mutation suites pass.
2. No safety or message-capacity invariant regresses.
3. The targeted validation cluster improves beyond the configured minimum effect.
4. No protected stratum exceeds its regression budget.
5. Frozen holdout performance is non-inferior.
6. Runtime and bundle-size budgets remain within limits.
7. New minimized fixtures reproduce the old failure and pass after the patch.
8. A fresh gatekeeper verifies the evidence and the parent records the result.

Initial budgets:

- zero new safety or over-capacity failures
- zero existing policy-fixture regressions
- no protected stratum may fail the pre-registered one-percentage-point non-inferiority test
- targeted failure rate must improve by at least five percentage points and pass the pre-registered paired superiority test, or eliminate a severe deterministic defect
- median runtime may not increase by more than 10% without explicit justification

## Leakage controls

Use four partitions:

1. **Training:** visible to failure analysts and optimizers.
2. **Validation:** scored after each pre-registered attempt; examples hidden and only the metrics declared in that attempt are returned. Reuse is bounded by the attempt budget and sequential-testing plan.
3. **Challenge:** private and evaluated once for the single patch selected as a release candidate. Failed candidates are discarded; further optimization requires a newly sampled, independently gold-labeled challenge set or a pre-registered sequential design.
4. **Observation:** real Discord client cases; never used to invent expected CommonMark semantics.

Partition by repository, corpus conversation, source family, and mutation lineage before agent evaluation. A deduplication pass must run across all partitions. Prompt templates and policy documents are versioned inputs and cannot contain challenge examples.

## Privacy and disclosure gates

Conversational records pass through:

1. source-role filtering
2. direct-identifier redaction
3. secret and credential detection
4. named-entity and quasi-identifier screening
5. local PII critic
6. disclosure classification

Private conversational records are local-only by default, including after automated redaction. A local model may evaluate them only when its identity, weights, runtime, network isolation, access controls, and storage paths are recorded.

External processing is prohibited unless a per-run owner approval cites documented lawful-use and contractual controls: a data-processing agreement where required, no-training terms, bounded retention, encryption in transit and at rest, approved jurisdiction, least-privilege access, subprocessors, incident handling, and verifiable deletion. The run must record the approved record hashes, provider configuration, disclosure purpose, approval identity, expiration, and deletion evidence. An internal `external-eval-approved` flag alone grants no authority.

Public reports contain aggregates and hashes, not raw private text.

## Reproducible orchestration

Each loop run receives a unique identifier and immutable configuration containing:

- converter and repository commit
- dataset-manifest hashes
- split-manifest hash
- prompt and rubric hashes
- agent/provider/model versions
- exact Node/browser runtime, operating system, ICU and Unicode versions, and segmentation locale
- random seed
- concurrency and retry policy
- token and cost budgets
- acceptance thresholds

Stages write atomically and checkpoint after bounded batches. Retries retain attempt metadata and never overwrite a completed judgment. A completed run can be replayed without invoking agents to verify scoring and acceptance decisions.

Suggested commands:

```text
npm run loop:prepare -- --run <id>
npm run loop:evaluate -- --run <id> --batch-size 50
npm run loop:adjudicate -- --run <id>
npm run loop:cluster -- --run <id>
npm run loop:optimize -- --run <id> --cluster <hash>
npm run loop:gate -- --run <id> --attempt <hash>
npm run loop:report -- --run <id>
```

Agent calls must use a structured schema and bounded context. The orchestration layer is provider-neutral; generated artifacts, not chat transcripts, are the interface between stages. Evaluation runs use the repository-pinned Node version and explicit segmentation locale; replay refuses to compare message-boundary results when recorded ICU or Unicode versions differ.

## Rollout plan

### Phase A — evaluation substrate

- Define source, conversion, judgment, adjudication, and attempt schemas.
- Add immutable split manifests and cross-split deduplication.
- Implement deterministic invariant scoring and replayable reports.
- Validate the pipeline on public fixtures without agent calls.

Exit criterion: one command reproduces baseline metrics from committed fixtures.

### Phase B — agent judging pilot

- Evaluate 500 public and synthetic cases with two critics and one adjudicator.
- Calibrate blinded judgments against versioned expected outputs and an independently human-reviewed gold subset.
- Measure gold accuracy, agreement, abstention, cost, and systematic judge bias.
- Keep non-gold consensus as triage evidence only.
- Freeze prompts only after reviewing disagreements.

Exit criterion: at least 90% accuracy against the unambiguous gold policy fixtures, acceptable per-category calibration, and no agent-produced label treated as gold.

### Phase C — first optimization cycles

- Select the three largest severe failure clusters.
- Run bounded optimizer attempts one cluster at a time.
- Generate adversarial neighbors and require full acceptance gates.
- Retain rejected attempts as negative evidence.

Exit criterion: at least one independently verified improvement with no protected-stratum regression.

### Phase D — corpus scale-up

- Add 25,000-50,000 stratified WildChat cases.
- Add 5,000 OASST1 cases after privacy gates.
- Acquire permissively licensed GitHub Markdown incrementally.
- Route easy cases through cheaper critics and uncertain/high-risk cases through stronger critics.

Exit criterion: stable resumable operation, bounded spend, and confidence intervals narrow enough to detect policy-relevant changes.

### Phase E — continuous operation

- Run deterministic gates on every commit.
- Run a small agentic canary evaluation on converter changes.
- Run full validation periodically and challenge evaluation at release boundaries.
- Version and publish aggregate benchmark reports.

## Immediate implementation sequence

1. Add versioned JSON Schemas for loop records and judgments.
2. Build a deterministic public-data baseline pack from current fixtures and mutants.
3. Implement run manifests, content-addressed artifacts, checkpoints, and replay scoring.
4. Add two-critic plus adjudicator structured-output execution.
5. Pilot on 500 public cases and calibrate the rubric.
6. Build the WildChat stratified sampler without retaining additional text in public artifacts.
7. Add failure clustering, minimization, and mutation generation.
8. Add optimizer worktree isolation and immutable validation gates.
9. Run the first three bounded improvement cycles.
10. Scale data only after label reliability and leakage controls pass their gates.

## Definition of success

The loop succeeds when it can repeatedly discover a real converter defect, produce a minimal reproducible fixture, propose a bounded correction, demonstrate statistically and deterministically that the correction improves unseen cases without safety regressions, and preserve enough evidence for an independent rerun to reach the same acceptance decision.
