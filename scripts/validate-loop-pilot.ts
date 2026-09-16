import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";

const directory = "data/work/loop-pilot-v1";
const packetsPath = `${directory}/packets.private.jsonl`;
const indexPath = `${directory}/index.private.json`;
const manifestPath = `${directory}/manifest.json`;
const shardPaths = [`${directory}/packets-001.private.jsonl`, `${directory}/packets-002.private.jsonl`];
const packetSchema = JSON.parse(await readFile("data/schema/loop-packet.schema.json", "utf8"));
const manifestSchema = JSON.parse(await readFile("data/schema/loop-pilot-manifest.schema.json", "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validatePacket = ajv.compile(packetSchema);
const validateManifest = ajv.compile(manifestSchema);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assertValid(validateManifest, manifest, manifestPath);

const requiredInputs = ["data/loop/baseline-v1/cases.jsonl", "data/loop/rubric-v1.md", "data/loop/converter-policy-v2.md"];
const requiredArtifacts = [packetsPath, ...shardPaths, indexPath];
assertEqual(JSON.stringify(manifest.inputs.map((item: { path: string }) => item.path).sort()), JSON.stringify([...requiredInputs].sort()), "pilot input membership");
assertEqual(JSON.stringify(manifest.artifacts.map((item: { path: string }) => item.path).sort()), JSON.stringify([...requiredArtifacts].sort()), "pilot artifact membership");
for (const file of [...manifest.inputs, ...manifest.artifacts]) assertEqual(await sha256File(file.path), file.sha256, `${file.path} SHA-256`);

const rubricSha256 = await sha256File("data/loop/rubric-v1.md");
const policySha256 = await sha256File("data/loop/converter-policy-v2.md");
const packets = [];
const lines = createInterface({ input: createReadStream(packetsPath), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const packet = JSON.parse(line);
  assertValid(validatePacket, packet, `${packetsPath}:${packets.length + 1}`);
  assertEqual(packet.rubricSha256, rubricSha256, `${packet.packetId} rubric SHA-256`);
  assertEqual(packet.policySha256, policySha256, `${packet.packetId} policy SHA-256`);
  const caseHash = digest(JSON.stringify({ sourceMarkdown: packet.sourceMarkdown, options: packet.options, messages: packet.outputMessages, warnings: packet.warningCodes }));
  assertEqual(packet.caseHash, caseHash, `${packet.packetId} case hash`);
  packets.push(packet);
}
assertEqual(packets.length, manifest.records, "pilot record count");
assertEqual(new Set(packets.map((item) => item.packetId)).size, packets.length, "unique packet IDs");
assertEqual(new Set(packets.map((item) => item.caseHash)).size, packets.length, "unique case hashes");
const shardedPackets = [];
for (const shardPath of shardPaths) {
  const shardLines = createInterface({ input: createReadStream(shardPath), crlfDelay: Infinity });
  for await (const line of shardLines) if (line.trim()) shardedPackets.push(JSON.parse(line));
}
assertEqual(JSON.stringify(shardedPackets), JSON.stringify(packets), "ordered shard concatenation");
assertEqual(shardedPackets.length, packets.length, "sharded packet count");

const index = JSON.parse(await readFile(indexPath, "utf8"));
assertEqual(index.pilotId, manifest.pilotId, "pilot manifest/index ID");
assertEqual(index.mappings.length, packets.length, "pilot index count");
const packetIdentity = new Map(packets.map((packet) => [packet.packetId, packet.caseHash]));
for (const mapping of index.mappings) assertEqual(packetIdentity.get(mapping.packetId), mapping.caseHash, `${mapping.packetId} index mapping`);
console.log(`Validated ${packets.length} blinded critic packets and all pilot hashes.`);

function assertValid(validate: any, value: unknown, identity: string): void { if (!validate(value)) throw new Error(`${identity}: ${ajv.errorsText(validate.errors)}`); }
function assertEqual(actual: unknown, expected: unknown, identity: string): void { if (actual !== expected) throw new Error(`${identity}: expected ${expected}, received ${actual}`); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
