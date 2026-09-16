import { createHash, createHmac, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const policyPath = "data/loop/converter-policy-v2.md";
const rubricPath = "data/loop/semantic-model-rubric-v2.md";
const labelerPromptPath = "data/loop/semantic-labeler-prompt-v2.md";
const inputs = {
  oasst: { candidates: "data/work/oasst1-candidates.private.jsonl", manifest: "data/raw/oasst1/manifest.json" },
  wildchat: { candidates: "data/work/wildchat-candidates.private.jsonl", manifest: "data/manifests/wildchat-1m-7d6490e.json" }
} as const;
const outputDirectory = "data/work/semantic-eval-candidates-v2";
const packetsPath = `${outputDirectory}/packets.private.jsonl`;
const indexPath = `${outputDirectory}/index.private.json`;
const manifestPath = `${outputDirectory}/manifest.private.json`;
const keyPath = `${outputDirectory}/blinding-key.private`;
const target = integerArgument("--count", 120);
if (target < 40) throw new Error("--count must be at least 40 for the portfolio quotas");

type SourceFamily = keyof typeof inputs | "synthetic";
type Candidate = {
  textSha256: string;
  sourceRow: number;
  sourceRecordId: string;
  lineageId: string;
  language: string;
  codePoints: number;
  features: string[];
  samplingStrata: string[];
  text: string;
  automaticRedactions: unknown[];
  sourcePiiLabel: number | null;
  requiresHumanPiiReview: boolean;
  model?: string;
  source: { family: SourceFamily; dataset: string; revision: string; license: string };
};
type Selected = Candidate & { portfolioBucket: string; highImpact: boolean };

await mkdir(outputDirectory, { recursive: true });
const blindingKey = await readOrCreateKey(keyPath);
const [oasstManifest, wildchatManifest] = await Promise.all([
  readJson(inputs.oasst.manifest), readJson(inputs.wildchat.manifest)
]);
const [oasstRows, wildchatRows] = await Promise.all([
  loadJsonl<Omit<Candidate, "source">>(inputs.oasst.candidates),
  loadJsonl<Omit<Candidate, "source">>(inputs.wildchat.candidates)
]);
const pools: Record<"oasst" | "wildchat", Candidate[]> = {
  oasst: oasstRows.map((item) => ({ ...item, source: { family: "oasst", dataset: oasstManifest.dataset, revision: oasstManifest.release, license: oasstManifest.license } })),
  wildchat: wildchatRows.map((item) => ({ ...item, source: { family: "wildchat", dataset: wildchatManifest.dataset, revision: wildchatManifest.revision, license: wildchatManifest.license } }))
};
for (const rows of Object.values(pools)) validateInputs(rows);

const quotas = portfolioQuotas(target);
const selected = portfolioSelection(pools, quotas);
const policySha256 = await sha256File(policyPath);
const packets = selected.map((candidate) => {
  const sourceSha256 = digest(normalize(candidate.text));
  return {
    schemaVersion: 2,
    candidateId: `eval-v2-${keyedDigest(blindingKey, `candidate-v2\0${sourceSha256}`).slice(0, 16)}`,
    sourceToken: keyedDigest(blindingKey, `source-v2\0${sourceSha256}`),
    presentationNonce: keyedDigest(blindingKey, `presentation-v2\0${sourceSha256}`).slice(0, 24),
    policyVersion: "converter-policy-v2" as const,
    policySha256,
    sourceMarkdown: normalize(candidate.text),
    options: {}
  };
}).sort((left, right) => left.presentationNonce.localeCompare(right.presentationNonce));
if (new Set(packets.map((packet) => packet.candidateId)).size !== packets.length) throw new Error("Candidate ID collision");

const bySourceToken = new Map(selected.map((candidate) => {
  const sourceSha256 = digest(normalize(candidate.text));
  return [keyedDigest(blindingKey, `source-v2\0${sourceSha256}`), { candidate, sourceSha256 }] as const;
}));
const mappings = packets.map((packet) => {
  const source = bySourceToken.get(packet.sourceToken);
  if (!source) throw new Error(`Missing source mapping for ${packet.candidateId}`);
  const { candidate, sourceSha256 } = source;
  return {
    candidateId: packet.candidateId,
    sourceToken: packet.sourceToken,
    sourceSha256,
    split: splitFor(blindingKey, candidate.lineageId),
    portfolioBucket: candidate.portfolioBucket,
    highImpact: candidate.highImpact,
    source: {
      ...candidate.source,
      sourceRow: candidate.sourceRow,
      sourceRecordId: candidate.sourceRecordId,
      lineageId: candidate.lineageId,
      upstreamRecordHash: candidate.textSha256,
      ...(candidate.model ? { model: candidate.model } : {})
    },
    language: normalizeLanguage(candidate.language),
    codePoints: Array.from(normalize(candidate.text)).length,
    features: [...new Set(candidate.features)].sort(),
    samplingStrata: [...new Set(candidate.samplingStrata)].sort(),
    privacy: {
      sourcePiiLabel: candidate.sourcePiiLabel,
      automaticRedactions: candidate.automaticRedactions,
      requiresHumanPiiReview: candidate.requiresHumanPiiReview,
      state: candidate.source.family === "synthetic" ? "synthetic-no-personal-data" : "pending-model-review"
    }
  };
});
const splitCounts = counts(mappings.map((item) => item.split));
const bucketCounts = counts(mappings.map((item) => item.portfolioBucket));
const sourceCounts = counts(mappings.map((item) => item.source.family));
const featureCounts = counts(mappings.flatMap((item) => item.features));
const languageCounts = counts(mappings.map((item) => item.language));

await atomicWrite(packetsPath, packets.map((packet) => JSON.stringify(packet)).join("\n") + "\n");
await atomicJson(indexPath, { schemaVersion: 2, candidateSetId: "semantic-eval-candidates-v2", mappings });
await atomicJson(manifestPath, {
  schemaVersion: 2,
  candidateSetId: "semantic-eval-candidates-v2",
  status: "awaiting-dual-model-review",
  records: packets.length,
  selectionPolicy: "portfolio-quota-lineage-split-v2",
  quotas,
  splitCounts,
  bucketCounts,
  sourceCounts,
  featureCounts,
  languageCounts,
  highImpact: mappings.filter((item) => item.highImpact).length,
  interactions: mappings.filter((item) => item.features.length >= 2).length,
  over2000CodePoints: mappings.filter((item) => item.codePoints > 2_000).length,
  inputs: [
    { path: inputs.oasst.candidates, sha256: await sha256File(inputs.oasst.candidates) },
    { path: inputs.oasst.manifest, sha256: await sha256File(inputs.oasst.manifest) },
    { path: inputs.wildchat.candidates, sha256: await sha256File(inputs.wildchat.candidates) },
    { path: inputs.wildchat.manifest, sha256: await sha256File(inputs.wildchat.manifest) },
    { path: policyPath, sha256: policySha256 },
    { path: rubricPath, sha256: await sha256File(rubricPath) },
    { path: labelerPromptPath, sha256: await sha256File(labelerPromptPath) }
  ],
  artifacts: [
    { path: keyPath, sha256: await sha256File(keyPath) },
    { path: packetsPath, sha256: await sha256File(packetsPath) },
    { path: indexPath, sha256: await sha256File(indexPath) }
  ],
  disclosure: "Private mixed-source semantic candidates. Review packets hide provenance, portfolio bucket, lineage, split, current converter output, and expected labels. Dual-model agreement remains silver evidence; challenge and high-impact cases require separate escalation."
});
console.log(`Prepared ${packets.length} v2 candidates (${Object.entries(bucketCounts).map(([key, value]) => `${key}=${value}`).join(", ")})`);
console.log(`Sources: ${Object.entries(sourceCounts).map(([key, value]) => `${key}=${value}`).join(", ")}; splits: validation=${splitCounts.validation ?? 0}, challenge=${splitCounts.challenge ?? 0}`);
console.log(`Candidate manifest SHA-256: ${await sha256File(manifestPath)}`);

function portfolioQuotas(count: number): Record<string, number> {
  const weights = [
    ["representative-natural", 40], ["long-splitting", 25], ["high-risk-discord", 20], ["feature-interaction", 20]
  ] as const;
  const synthetic = Math.max(8, Math.round(count * 15 / 120));
  const natural = count - synthetic;
  const naturalWeight = weights.reduce((sum, item) => sum + item[1], 0);
  const result: Record<string, number> = { "boundary-adversarial": synthetic };
  let allocated = synthetic;
  for (const [index, [name, weight]] of weights.entries()) {
    const value = index === weights.length - 1 ? count - allocated : Math.round(natural * weight / naturalWeight);
    result[name] = value;
    allocated += value;
  }
  return result;
}
function portfolioSelection(pools: Record<"oasst" | "wildchat", Candidate[]>, quotas: Record<string, number>): Selected[] {
  const result: Selected[] = [];
  const seen = new Set<string>();
  const take = (bucket: string, count: number, predicate: (item: Candidate) => boolean, highImpact: boolean) => {
    const sourceTargets: Record<string, number> = { oasst: Math.floor(count / 2), wildchat: count - Math.floor(count / 2) };
    for (const family of ["oasst", "wildchat"] as const) {
      const ranked = pools[family].filter(predicate).filter((item) => !seen.has(identity(item))).sort((a, b) => rank(bucket, a).localeCompare(rank(bucket, b)));
      for (const item of ranked.slice(0, sourceTargets[family])) { seen.add(identity(item)); result.push({ ...item, portfolioBucket: bucket, highImpact }); }
    }
    let missing = result.filter((item) => item.portfolioBucket === bucket).length;
    if (missing < count) {
      const fallback = [...pools.oasst, ...pools.wildchat].filter(predicate).filter((item) => !seen.has(identity(item))).sort((a, b) => rank(`${bucket}:fill`, a).localeCompare(rank(`${bucket}:fill`, b)));
      for (const item of fallback.slice(0, count - missing)) { seen.add(identity(item)); result.push({ ...item, portfolioBucket: bucket, highImpact }); }
      missing = result.filter((item) => item.portfolioBucket === bucket).length;
    }
    if (missing !== count) throw new Error(`Selected ${missing}/${count} for ${bucket}`);
  };
  take("representative-natural", quotas["representative-natural"], (item) => item.samplingStrata.includes("representative"), false);
  take("long-splitting", quotas["long-splitting"], (item) => item.codePoints > 2_000, true);
  const risky = new Set(["discord_mention", "html", "inline_link", "reference_link", "markdown_image", "unbalanced_fence_candidate", "latex"]);
  take("high-risk-discord", quotas["high-risk-discord"], (item) => item.features.some((feature) => risky.has(feature)), true);
  take("feature-interaction", quotas["feature-interaction"], (item) => item.features.length >= 2, true);
  for (const item of syntheticCandidates().slice(0, quotas["boundary-adversarial"])) result.push({ ...item, portfolioBucket: "boundary-adversarial", highImpact: true });
  if (result.length !== target) throw new Error(`Selected ${result.length}; expected ${target}`);
  return result;
}
function syntheticCandidates(): Candidate[] {
  const definitions: Array<[string, string, string[]]> = [
    ["capacity-1999", "x".repeat(1_999), ["capacity-boundary"]],
    ["capacity-2000", "x".repeat(2_000), ["capacity-boundary"]],
    ["capacity-2001", "x".repeat(2_001), ["capacity-boundary"]],
    ["fence-near-boundary", `Intro\n\n\`\`\`js\n${"const value = 1;\n".repeat(130)}\`\`\`\n\nTail`, ["fenced_code", "capacity-boundary"]],
    ["unbalanced-fence", "Before\n```js\nconsole.log('@everyone')\nAfter", ["fenced_code", "unbalanced_fence_candidate", "discord_mention"]],
    ["mention-prose-code", "Notify @everyone but keep `@here` literal and `<@123456789012345678>` safe.\n```txt\n@everyone\n```", ["discord_mention", "inline_code", "fenced_code"]],
    ["unsafe-link", "Read [safe](https://example.com/a_(b)) and [unsafe](javascript:alert(1)).", ["inline_link"]],
    ["reference-resolution", "Read [the guide][g] before [missing][x].\n\n[g]: https://example.com/guide", ["reference_link"]],
    ["table-in-list", "1. Results\n\n   | Name | Value |\n   | --- | ---: |\n   | alpha | 1 |\n\n2. Done", ["ordered_list", "gfm_table_candidate"]],
    ["html-list", "<details><summary>More</summary>\n\n- first\n- second with **bold**\n\n</details>", ["html", "unordered_list"]],
    ["unicode-combining", `${"a".repeat(1_990)}e\u0301👨‍👩‍👧‍👦 نهاية`, ["unicode", "capacity-boundary"]],
    ["rtl-markdown", "## العنوان\n\n1. خطوة أولى\n2. **خطوة ثانية** مع [رابط](https://example.com)", ["heading", "ordered_list", "inline_link", "rtl"]],
    ["task-mentions", "- [ ] ping @here\n- [x] preserve `<@123456789012345678>` as code", ["task_list", "discord_mention", "inline_code"]],
    ["image-relative", "![architecture diagram](../assets/system diagram.png)\n\nContinue after the image.", ["markdown_image"]],
    ["nested-quotes", "> Outer\n> - item one\n> - item two with ||spoiler||\n>   > nested", ["blockquote", "unordered_list", "spoiler"]]
  ];
  return definitions.map(([id, text, features], index) => ({
    textSha256: digest(normalize(text)), sourceRow: index + 1, sourceRecordId: id, lineageId: `synthetic-v2:${id}`,
    language: id === "rtl-markdown" ? "ar" : "und", codePoints: Array.from(text).length, features, samplingStrata: ["boundary-adversarial"], text,
    automaticRedactions: [], sourcePiiLabel: null, requiresHumanPiiReview: false,
    source: { family: "synthetic", dataset: "semantic-boundary-v2", revision: "2", license: "CC0-1.0" }
  }));
}
function rank(stratum: string, candidate: Candidate): string { return digest(`semantic-eval-selection-v2\0${stratum}\0${candidate.source.family}\0${candidate.textSha256}`); }
function identity(candidate: Candidate): string { return digest(normalize(candidate.text)); }
function splitFor(key: string, lineageId: string): "validation" | "challenge" {
  const bucket = Number.parseInt(keyedDigest(key, `semantic-eval-lineage-split-v2\0${lineageId}`).slice(0, 8), 16) % 100;
  return bucket < 20 ? "challenge" : "validation";
}
function validateInputs(records: Candidate[]): void {
  if (!records.length) throw new Error("Candidate source contains no records");
  for (const record of records) {
    if (!record.text || !record.sourceRecordId || !record.lineageId) throw new Error("Candidate lacks text or lineage identity");
    if (!Array.isArray(record.features) || !Array.isArray(record.samplingStrata)) throw new Error("Candidate lacks strata arrays");
    if (record.requiresHumanPiiReview !== true) throw new Error("Natural candidate bypasses privacy review");
  }
}
function counts(values: string[]): Record<string, number> { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return Object.fromEntries(Object.entries(result).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))); }
function normalizeLanguage(value: string): string {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = { english: "en", spanish: "es", russian: "ru", chinese: "zh", french: "fr", polish: "pl", portuguese: "pt", vietnamese: "vi", arabic: "ar" };
  return aliases[normalized] ?? (normalized || "unknown");
}
function normalize(value: string): string { return value.replace(/\r\n?/g, "\n"); }
function integerArgument(name: string, fallback: number): number { const index = process.argv.indexOf(name); if (index < 0) return fallback; const value = Number(process.argv[index + 1]); if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`); return value; }
function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function keyedDigest(key: string, value: string): string { return createHmac("sha256", key).update(value).digest("hex"); }
async function readOrCreateKey(path: string): Promise<string> { try { const existing = (await readFile(path, "utf8")).trim(); if (!/^[a-f0-9]{64}$/.test(existing)) throw new Error(`${path} is not a 256-bit hex key`); return existing; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const created = randomBytes(32).toString("hex"); await atomicWrite(path, `${created}\n`); return created; } }
async function readJson(path: string): Promise<any> { return JSON.parse(await readFile(path, "utf8")); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function loadJsonl<T>(path: string): Promise<T[]> { const rows: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line)); return rows; }
async function atomicJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, JSON.stringify(value, null, 2) + "\n"); }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
