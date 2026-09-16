import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";

const directory = "data/work/loop-pilot-v1/adjudication";
const packetsPath = `${directory}/packets.private.jsonl`;
const outputPath = value("--output");
if (!outputPath) throw new Error("Provide --output path");
const packets = await loadJsonl<Record<string, any>>(packetsPath);
const packetMap = new Map(packets.map((packet) => [packet.adjudicationPacketId, packet]));
const raw = JSON.parse(await readFile(outputPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const outputValidator = ajv.compile(JSON.parse(await readFile("data/schema/loop-adjudicator-output.schema.json", "utf8")));
const recordValidator = ajv.compile(JSON.parse(await readFile("data/schema/loop-adjudication.schema.json", "utf8")));
validate(outputValidator, raw, outputPath);
if (raw.adjudications.length !== packets.length) throw new Error(`Adjudicator returned ${raw.adjudications.length}/${packets.length} records`);
const seen = new Set<string>();
const counts: Record<string, number> = {};
const records = raw.adjudications.map((adjudication: Record<string, any>) => {
  const packet = packetMap.get(adjudication.adjudicationPacketId);
  if (!packet) throw new Error(`Unknown adjudication packet ${adjudication.adjudicationPacketId}`);
  if (seen.has(adjudication.adjudicationPacketId)) throw new Error(`Duplicate adjudication packet ${adjudication.adjudicationPacketId}`);
  seen.add(adjudication.adjudicationPacketId);
  if (adjudication.caseHash !== packet.caseHash) throw new Error(`${adjudication.adjudicationPacketId}: case hash mismatch`);
  const expectedHashes = packet.judgments.map((judgment: any) => judgment.judgmentSha256).sort();
  if (JSON.stringify([...adjudication.judgmentHashes].sort()) !== JSON.stringify(expectedHashes)) throw new Error(`${adjudication.adjudicationPacketId}: judgment hash mismatch`);
  counts[adjudication.decision] = (counts[adjudication.decision] ?? 0) + 1;
  const record = {
    schemaVersion: 1,
    adjudicationId: `public-pilot-v1:${adjudication.adjudicationPacketId}`,
    caseHash: adjudication.caseHash,
    judgmentHashes: adjudication.judgmentHashes,
    rubricVersion: packet.rubricVersion,
    decision: adjudication.decision,
    labelAuthority: "triage-only",
    failureCategories: adjudication.failureCategories,
    rationale: adjudication.rationale
  };
  validate(recordValidator, record, record.adjudicationId);
  return record;
});
await atomicText(`${directory}/records.private.jsonl`, records.map((record: any) => JSON.stringify(record)).join("\n") + "\n");
await atomicText(`${directory}/summary.private.json`, JSON.stringify({
  schemaVersion: 1,
  adjudicationId: "public-pilot-v1-adjudication",
  records: records.length,
  counts,
  inputs: {
    packetsSha256: await sha256File(packetsPath),
    outputSha256: await sha256File(outputPath),
    promptSha256: await sha256File("data/loop/adjudicator-prompt-v1.md"),
    rubricSha256: await sha256File("data/loop/rubric-v1.md"),
    policySha256: await sha256File("data/loop/converter-policy-v2.md")
  },
  labelAuthority: "triage-only"
}, null, 2) + "\n");
console.log(`Validated ${records.length} adjudications: ${Object.entries(counts).map(([decision, count]) => `${decision}=${count}`).join(", ")}`);

function value(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function validate(validator: any, data: unknown, identity: string): void { if (!validator(data)) throw new Error(`${identity}: ${ajv.errorsText(validator.errors)}`); }
async function loadJsonl<T>(path: string): Promise<T[]> { const records: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) records.push(JSON.parse(line)); return records; }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function atomicText(path: string, data: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, data); await rename(temporary, path); }
