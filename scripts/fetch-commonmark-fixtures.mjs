import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const version = "0.31.2";
const sourceUrl = `https://spec.commonmark.org/${version}/spec.json`;
const outputPath = "data/spec/commonmark-0.31.2.jsonl";
const manifestPath = "data/spec/commonmark-0.31.2.manifest.json";

const response = await fetch(sourceUrl);
if (!response.ok) {
  throw new Error(`Failed to fetch ${sourceUrl}: ${response.status}`);
}

const sourceBytes = Buffer.from(await response.arrayBuffer());
const examples = JSON.parse(sourceBytes.toString("utf8"));
if (!Array.isArray(examples) || examples.length === 0) {
  throw new Error("CommonMark fixture response was empty or malformed");
}

const records = examples.map((example) => ({
  id: `commonmark-${version}-${example.example}`,
  source_markdown: example.markdown,
  expected_html: example.html,
  section: example.section,
  categories: ["commonmark", String(example.section).toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "")],
  provenance: {
    source_url: sourceUrl,
    upstream_example: example.example,
    version,
    license: "BSD-2-Clause"
  },
  label_origin: "spec"
}));

await mkdir("data/spec", { recursive: true });
await writeFile(outputPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
await writeFile(manifestPath, JSON.stringify({
  source_url: sourceUrl,
  source_repository: "https://github.com/commonmark/commonmark-spec",
  version,
  retrieved_at: new Date().toISOString(),
  license: "BSD-2-Clause",
  source_sha256: createHash("sha256").update(sourceBytes).digest("hex"),
  record_count: records.length,
  output: outputPath
}, null, 2) + "\n");

console.log(`Wrote ${records.length} fixtures to ${outputPath}`);
