import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const baselinePath = "data/loop/baseline-v1/cases.jsonl";
const rubricPath = "data/loop/rubric-v1.md";
const policyPath = "data/loop/converter-policy-v2.md";
const outputDirectory = "data/work/loop-pilot-v1";
const packetsPath = `${outputDirectory}/packets.private.jsonl`;
const indexPath = `${outputDirectory}/index.private.json`;
const manifestPath = `${outputDirectory}/manifest.json`;
const targetPerInvariantKind = 241;

type BaselineCase = Record<string, any>;
type SourceRecord = { sourceMarkdown: string; options: Record<string, unknown> };

const baseline = await loadJsonl<BaselineCase>(baselinePath);
const sourceRecords = await loadSources();
const gold = baseline.filter((item) => item.labelClass === "gold");
const trainInvariant = baseline.filter((item) => item.labelClass === "invariant-only" && item.split === "train");
const selected = [
  ...gold,
  ...bottomK(trainInvariant.filter((item) => item.source.kind === "commonmark"), targetPerInvariantKind),
  ...bottomK(trainInvariant.filter((item) => item.source.kind === "mutant"), targetPerInvariantKind)
];
if (selected.length !== gold.length + targetPerInvariantKind * 2) throw new Error(`Selected ${selected.length}; expected ${gold.length + targetPerInvariantKind * 2}`);

const rubricSha256 = await sha256File(rubricPath);
const policySha256 = await sha256File(policyPath);
const packets = selected.map((item) => {
  const source = sourceRecords.get(item.id);
  if (!source) throw new Error(`Missing source ${item.id}`);
  const caseHash = digest(JSON.stringify({ sourceMarkdown: source.sourceMarkdown, options: source.options, messages: item.conversion.messages, warnings: item.conversion.warningCodes }));
  return {
    schemaVersion: 1,
    packetId: `pilot-v1-${caseHash.slice(0, 16)}`,
    caseHash,
    presentationNonce: digest(`presentation-v1\0${item.id}`).slice(0, 24),
    rubricVersion: "critic-rubric-v1",
    rubricSha256,
    policyVersion: "converter-policy-v2",
    policySha256,
    sourceMarkdown: source.sourceMarkdown,
    options: source.options,
    outputMessages: item.conversion.messages,
    warningCodes: item.conversion.warningCodes
  };
}).sort((left, right) => left.presentationNonce.localeCompare(right.presentationNonce));

const packetIds = new Set(packets.map((packet) => packet.packetId));
if (packetIds.size !== packets.length) throw new Error("Packet ID collision");
const index = {
  schemaVersion: 1,
  pilotId: "public-pilot-v1",
  mappings: packets.map((packet) => {
    const item = selected.find((candidate) => digest(JSON.stringify({ sourceMarkdown: sourceRecords.get(candidate.id)?.sourceMarkdown, options: sourceRecords.get(candidate.id)?.options, messages: candidate.conversion.messages, warnings: candidate.conversion.warningCodes })) === packet.caseHash);
    if (!item) throw new Error(`Unable to map ${packet.packetId}`);
    return { packetId: packet.packetId, caseHash: packet.caseHash, baselineCaseId: item.id, labelClass: item.labelClass };
  })
};

await mkdir(outputDirectory, { recursive: true });
await atomicWrite(packetsPath, packets.map((packet) => JSON.stringify(packet)).join("\n") + "\n");
await atomicJson(indexPath, index);
await atomicJson(manifestPath, {
  schemaVersion: 1,
  pilotId: "public-pilot-v1",
  status: "prepared",
  records: packets.length,
  selection: { policyGold: gold.length, commonmarkTrainInvariant: targetPerInvariantKind, mutantTrainInvariant: targetPerInvariantKind },
  inputs: [
    { path: baselinePath, sha256: await sha256File(baselinePath) },
    { path: rubricPath, sha256: rubricSha256 },
    { path: policyPath, sha256: policySha256 }
  ],
  artifacts: [
    { path: packetsPath, sha256: await sha256File(packetsPath) },
    { path: indexPath, sha256: await sha256File(indexPath) }
  ],
  disclosure: "Public specification, policy, and synthetic mutation records only. Packets omit provenance, split, expected output, and gold labels."
});
console.log(`Prepared ${packets.length} blinded critic packets in ${outputDirectory}`);

function bottomK(records: BaselineCase[], count: number): BaselineCase[] {
  return [...records]
    .map((record) => ({ record, rank: digest(`pilot-selection-v1\0${record.source.lineageId}\0${record.id}`) }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.record.id.localeCompare(right.record.id))
    .slice(0, count)
    .map((item) => item.record);
}
async function loadSources(): Promise<Map<string, SourceRecord>> {
  const result = new Map<string, SourceRecord>();
  for (const row of await loadJsonl<Record<string, unknown>>("data/fixtures/discord-policy-v1.jsonl")) result.set(`policy:${row.id}`, { sourceMarkdown: String(row.sourceMarkdown), options: isObject(row.options) ? row.options : {} });
  for (const row of await loadJsonl<Record<string, unknown>>("data/spec/commonmark-0.31.2.jsonl")) result.set(`commonmark:${row.id}`, { sourceMarkdown: String(row.source_markdown), options: {} });
  for (const row of await loadJsonl<Record<string, unknown>>("data/mutations/commonmark-mutants-v1.jsonl")) result.set(`mutant:${row.id}`, { sourceMarkdown: String(row.sourceMarkdown), options: {} });
  return result;
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function loadJsonl<T>(path: string): Promise<T[]> { const records: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) records.push(JSON.parse(line)); return records; }
async function atomicJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, JSON.stringify(value, null, 2) + "\n"); }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
