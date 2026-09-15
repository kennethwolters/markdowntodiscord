# Markdown to Discord

A browser-first Markdown-to-Discord converter and evidence-backed compatibility benchmark.

Live deployment: [markdown-to-discord.pages.dev](https://markdown-to-discord.pages.dev/)

The conversion core is under `src/`. The research and delivery plan is in [`PLAN.md`](./PLAN.md); the closed-loop evaluation and optimization design is in [`docs/agentic-optimization.md`](./docs/agentic-optimization.md).

## Development

```bash
npm install
npm run dev
npm test
npm run build
npm run fixtures:commonmark
npm run fixtures:validate
npm run analyze:commonmark
```

The fixture command downloads the pinned CommonMark 0.31.2 specification examples and writes a provenance manifest under `data/spec/`. The resumable corpus workflow is documented in [`docs/data-pipeline.md`](./docs/data-pipeline.md); current corpus measurements are summarized in [`docs/data-findings.md`](./docs/data-findings.md).
