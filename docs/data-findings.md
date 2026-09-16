# Initial corpus findings

These are lexical prevalence measurements used to prioritize engineering and sampling. They are not parser-validity, rendering-failure, or user-expectation labels.

## WildChat-1M

Pinned revision: `7d6490e462285cf85d91eabea0f9a954fbddcd1f`

- 837,989 Parquet conversation rows
- 1,960,074 assistant-role turns with string content
- 14/14 Parquet shards verified and processed
- Aggregate report hash is stable across a completed rerun

Every rate below uses the 1,960,074 assistant-role turns with string content as its denominator.

| Signal | Matching assistant turns | Approximate rate |
|---|---:|---:|
| Over 2,000 code points | 488,495 | 24.92% |
| Ordered-list syntax | 521,907 | 26.63% |
| Fenced code | 212,726 | 10.85% |
| Inline code | 179,791 | 9.17% |
| Unordered-list syntax | 173,641 | 8.86% |
| Heading syntax | 93,874 | 4.79% |
| HTML-looking tags | 65,826 | 3.36% |
| Horizontal-rule syntax | 16,139 | 0.82% |
| LaTeX-looking syntax | 13,267 | 0.68% |
| Deep headings | 6,623 | 0.34% |
| GFM-table candidates | 6,507 | 0.33% |
| Unbalanced-fence candidates | 3,531 | 0.18% |
| Markdown images | 1,493 | 0.08% |
| Mermaid fences | 158 | 0.01% |
| Task-list syntax | 79 | <0.01% |

The most consequential result is message length: roughly one quarter of assistant turns exceed Discord's ordinary 2,000-character content limit. Structure-aware splitting is therefore a primary feature, not an edge case.

## OASST1

- 88,838 source rows
- 55,668 assistant messages
- 3,093 assistant messages over 2,000 code points (5.56%)
- 2,006 fenced-code responses
- 117 table candidates
- 73 unbalanced-fence candidates
- 925 unique private review candidates retained across representative, feature, length, and interaction strata

The private candidate texts remain under ignored `data/work/`. They are not release data and require human PII and quality review.

## Interpretation

Priority order supported by both corpora:

1. Structure-aware 2,000-character splitting.
2. Lists and code fences.
3. Literal escaping and inline-code safety.
4. Headings and HTML degradation.
5. Tables, LaTeX, images, and reference links.
6. Rare Discord-specific collisions and notification safety.

The private semantic v2 pool additionally contains 1,229 unique WildChat candidates. Its frozen 120-case review portfolio is balanced across 53 WildChat, 52 OASST1, and 15 controlled synthetic cases, with explicit quotas for representative outputs, long/splitting behavior, Discord risks, feature interactions, and adversarial boundaries. Blinded review retained 104 silver labels and quarantined 16 cases. The initial converter baseline passes 66/83 validation labels and 16/21 challenge labels.

Exact machine-readable results are in:

- `data/reports/wildchat-feature-report.json`
- `data/reports/wildchat-candidate-sample-summary.json`
- `data/reports/oasst1-feature-report.json`
- `data/reports/oasst1-candidate-sample-summary.json`
- `data/reports/oasst1-candidate-extraction-summary.json`
- `data/reports/semantic-eval-v2.json`
