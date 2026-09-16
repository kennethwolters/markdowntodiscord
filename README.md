# Markdown to Discord

A browser-first Markdown-to-Discord converter and evidence-backed compatibility benchmark.

Live deployment: [markdowntodiscord.com](https://markdowntodiscord.com/)

The conversion core is under `src/`. The research and delivery plan is in [`PLAN.md`](./PLAN.md); the closed-loop evaluation and optimization design is in [`docs/agentic-optimization.md`](./docs/agentic-optimization.md).

Conversion runs entirely in the browser. Raw conversational corpora and private review artifacts are not included in this repository.

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

## Release

```bash
npm run release:check
git commit -am "release changes"
npm run deploy
```

`deploy` requires a clean worktree, runs the complete release gate, deploys `dist/` to the `markdown-to-discord` Cloudflare Pages project with pinned Wrangler, waits for the canonical hostname to serve the commit-specific `version.json`, and verifies the converter, guide, sitemap, and robots file. Override `CLOUDFLARE_PAGES_PROJECT`, `CLOUDFLARE_PAGES_BRANCH`, or `CANONICAL_URL` only when deliberately targeting another Pages environment.

## License

The project is available under the [MIT License](./LICENSE). See [third-party notices](./THIRD_PARTY_NOTICES.md) for benchmark and dataset attribution.
