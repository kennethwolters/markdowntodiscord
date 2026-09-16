import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const baselinePath = "data/loop/baseline-v1/cases.jsonl";
const policyPath = "data/loop/converter-policy-v2.md";
const rubricPath = "data/loop/rubric-v1.md";
const outputDirectory = "data/work/loop-calibration-v1";
const packetsPath = `${outputDirectory}/packets.private.jsonl`;
const keyPath = `${outputDirectory}/answer-key.private.json`;
const manifestPath = `${outputDirectory}/manifest.json`;
const rubricSha256 = await sha256File(rubricPath);
const policySha256 = await sha256File(policyPath);

const baseline = await loadJsonl<Record<string, any>>(baselinePath);
const sources = new Map((await loadJsonl<Record<string, any>>("data/fixtures/discord-policy-v1.jsonl")).map((item) => [`policy:${item.id}`, { sourceMarkdown: item.sourceMarkdown, options: item.options ?? {} }]));
const gold = baseline.filter((item) => item.labelClass === "gold" && item.source.kind === "policy");
if (gold.length !== 18) throw new Error(`Expected 18 policy gold cases, received ${gold.length}`);
const defects: Array<(messages: string[]) => { name: string; messages: string[] }> = [
  (messages) => ({ name: "append-active-mention", messages: replaceLast(messages, (value) => `${value}\n@everyone`) }),
  (messages) => ({ name: "truncate-output", messages: replaceLast(messages, (value) => Array.from(value).slice(0, Math.max(0, Math.floor(Array.from(value).length / 2))).join("")) }),
  () => ({ name: "drop-output", messages: [""] }),
  (messages) => ({ name: "unbalanced-fence", messages: replaceLast(messages, (value) => `${value}\n\`\`\``) }),
  (messages) => ({ name: "over-capacity", messages: replaceLast(messages, (value) => `${value}${"x".repeat(2_001)}`) })
];

const controls = gold.flatMap((item, index) => {
  const source = sources.get(item.id);
  if (!source || typeof source.sourceMarkdown !== "string") throw new Error(`Missing source for ${item.id}`);
  const positive = packet(item, source.sourceMarkdown, source.options, item.conversion.messages, `positive\0${item.id}`);
  const defect = defects[index % defects.length](item.conversion.messages);
  const negative = packet(item, source.sourceMarkdown, source.options, defect.messages, `${defect.name}\0${item.id}`);
  return [
    { packet: positive, answer: { packetId: positive.packetId, caseHash: positive.caseHash, expectedVerdict: "pass", control: "gold-positive", baselineCaseId: item.id } },
    { packet: negative, answer: { packetId: negative.packetId, caseHash: negative.caseHash, expectedVerdict: "fail", control: defect.name, baselineCaseId: item.id } }
  ];
});
const packets = controls.map((item) => item.packet).sort((left, right) => left.presentationNonce.localeCompare(right.presentationNonce));
const answers = packets.map((packet) => controls.find((item) => item.packet.packetId === packet.packetId)!.answer);
if (new Set(packets.map((item) => item.packetId)).size !== packets.length) throw new Error("Calibration packet collision");

await mkdir(outputDirectory, { recursive: true });
await atomicWrite(packetsPath, packets.map((item) => JSON.stringify(item)).join("\n") + "\n");
await atomicJson(keyPath, { schemaVersion: 1, calibrationId: "critic-calibration-v1", answers });
await atomicJson(manifestPath, {
  schemaVersion: 1,
  calibrationId: "critic-calibration-v1",
  status: "prepared",
  records: packets.length,
  positiveControls: gold.length,
  negativeControls: gold.length,
  inputs: [
    { path: baselinePath, sha256: await sha256File(baselinePath) },
    { path: policyPath, sha256: policySha256 },
    { path: rubricPath, sha256: rubricSha256 }
  ],
  artifacts: [
    { path: packetsPath, sha256: await sha256File(packetsPath) },
    { path: keyPath, sha256: await sha256File(keyPath) }
  ],
  disclosure: "Public policy fixtures with hidden positive/negative control identity. Critics must not access the answer key."
});
console.log(`Prepared ${packets.length} blinded calibration controls (${gold.length} positive, ${gold.length} negative).`);

function packet(item: Record<string, any>, sourceMarkdown: string, options: Record<string, unknown>, outputMessages: string[], salt: string) {
  const caseHash = digest(JSON.stringify({ sourceMarkdown, options, messages: outputMessages, warnings: item.conversion.warningCodes }));
  return {
    schemaVersion: 1,
    packetId: `calibration-v1-${caseHash.slice(0, 16)}`,
    caseHash,
    presentationNonce: digest(`calibration-presentation-v1\0${salt}`).slice(0, 24),
    rubricVersion: "critic-rubric-v1",
    rubricSha256,
    policyVersion: "converter-policy-v2",
    policySha256,
    sourceMarkdown,
    options,
    outputMessages,
    warningCodes: item.conversion.warningCodes
  };
}
function replaceLast(messages: string[], transform: (value: string) => string): string[] { const result = [...messages]; result[result.length - 1] = transform(result[result.length - 1]); return result; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function loadJsonl<T>(path: string): Promise<T[]> { const records: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) records.push(JSON.parse(line)); return records; }
async function atomicJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, JSON.stringify(value, null, 2) + "\n"); }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
