import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const directory = "data/work/semantic-eval-candidates-v2";
const packetsPath = `${directory}/packets.private.jsonl`;
const indexPath = `${directory}/index.private.json`;
const manifestPath = `${directory}/manifest.private.json`;
const keyPath = `${directory}/blinding-key.private`;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validatePacket = ajv.compile(JSON.parse(await readFile("data/schema/eval-candidate-packet.schema.json", "utf8")));
const validateManifest = ajv.compile(JSON.parse(await readFile("data/schema/eval-candidate-manifest.schema.json", "utf8")));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const blindingKey = (await readFile(keyPath, "utf8")).trim();
if (!/^[a-f0-9]{64}$/.test(blindingKey)) throw new Error(`${keyPath} is not a 256-bit hex key`);
assertValid(validateManifest, manifest, manifestPath);
for (const entry of [...manifest.inputs, ...manifest.artifacts]) assertEqual(await sha256File(entry.path), entry.sha256, `${entry.path} SHA-256`);

const packets = await loadJsonl<Record<string, any>>(packetsPath);
const index = JSON.parse(await readFile(indexPath, "utf8"));
if (index.schemaVersion !== 2 || index.candidateSetId !== manifest.candidateSetId || !Array.isArray(index.mappings)) throw new Error("Invalid private index");
assertEqual(packets.length, manifest.records, "packet count");
assertEqual(index.mappings.length, manifest.records, "index count");
const mappings = new Map<string, Record<string, any>>(index.mappings.map((item: Record<string, any>) => [item.candidateId, item]));
const packetIds = new Set<string>();
const sourceTokens = new Set<string>();
for (const [offset, packet] of packets.entries()) {
  assertValid(validatePacket, packet, `${packetsPath}:${offset + 1}`);
  if (packetIds.has(packet.candidateId) || sourceTokens.has(packet.sourceToken)) throw new Error(`Duplicate packet identity ${packet.candidateId}`);
  packetIds.add(packet.candidateId); sourceTokens.add(packet.sourceToken);
  const contentHash = digest(normalize(packet.sourceMarkdown));
  assertEqual(packet.candidateId, `eval-v2-${keyedDigest(blindingKey, `candidate-v2\0${contentHash}`).slice(0, 16)}`, `${packet.candidateId} ID`);
  assertEqual(packet.sourceToken, keyedDigest(blindingKey, `source-v2\0${contentHash}`), `${packet.candidateId} token`);
  const mapping = mappings.get(packet.candidateId);
  if (!mapping) throw new Error(`Missing mapping for ${packet.candidateId}`);
  assertEqual(mapping.sourceSha256, contentHash, `${packet.candidateId} content hash`);
  assertEqual(mapping.sourceToken, packet.sourceToken, `${packet.candidateId} mapping token`);
  assertEqual(mapping.split, splitFor(blindingKey, mapping.source.lineageId), `${packet.candidateId} lineage split`);
  if (mapping.source.family === "synthetic") {
    if (mapping.privacy.state !== "synthetic-no-personal-data" || mapping.privacy.requiresHumanPiiReview !== false) throw new Error(`${packet.candidateId} invalid synthetic privacy state`);
  } else if (mapping.privacy.state !== "pending-model-review" || mapping.privacy.requiresHumanPiiReview !== true) {
    throw new Error(`${packet.candidateId} bypasses natural-source privacy review`);
  }
}
assertEqual(packetIds.size, mappings.size, "packet/index membership");
const values = [...mappings.values()];
assertRecord(counts(values.map((item) => item.split)), manifest.splitCounts, "split counts");
assertRecord(counts(values.map((item) => item.portfolioBucket)), manifest.bucketCounts, "bucket counts");
assertRecord(counts(values.map((item) => item.source.family)), manifest.sourceCounts, "source counts");
assertRecord(counts(values.flatMap((item) => item.features)), manifest.featureCounts, "feature counts");
assertRecord(counts(values.map((item) => item.language)), manifest.languageCounts, "language counts");
assertEqual(values.filter((item) => item.highImpact).length, manifest.highImpact, "high-impact count");
assertEqual(values.filter((item) => item.features.length >= 2).length, manifest.interactions, "interaction count");
assertEqual(values.filter((item) => item.codePoints > 2_000).length, manifest.over2000CodePoints, "long count");
for (const [bucket, quota] of Object.entries(manifest.quotas)) assertEqual(manifest.bucketCounts[bucket], quota, `${bucket} quota`);
console.log(`Validated ${packets.length} mixed-source candidates, portfolio quotas, lineage splits, privacy states, and hashes.`);

function splitFor(key: string, lineageId: string): "validation" | "challenge" { const bucket = Number.parseInt(keyedDigest(key, `semantic-eval-lineage-split-v2\0${lineageId}`).slice(0, 8), 16) % 100; return bucket < 20 ? "challenge" : "validation"; }
function counts(values: string[]): Record<string, number> { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return sorted(result); }
function sorted(value: Record<string, number>): Record<string, number> { return Object.fromEntries(Object.entries(value).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))); }
function normalize(value: string): string { return value.replace(/\r\n?/g, "\n"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function keyedDigest(key: string, value: string): string { return createHmac("sha256", key).update(value).digest("hex"); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function loadJsonl<T>(path: string): Promise<T[]> { const rows: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line)); return rows; }
function assertValid(validate: { (value: unknown): boolean; errors?: unknown }, value: unknown, identity: string): void { if (!validate(value)) throw new Error(`${identity}: ${ajv.errorsText(validate.errors as any, { separator: "; " })}`); }
function assertRecord(actual: unknown, expected: unknown, identity: string): void { assertEqual(JSON.stringify(actual), JSON.stringify(expected), identity); }
function assertEqual(actual: unknown, expected: unknown, identity: string): void { if (actual !== expected) throw new Error(`${identity}: expected ${expected}, received ${actual}`); }
