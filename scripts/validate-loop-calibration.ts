import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";

const directory = "data/work/loop-calibration-v1";
const packetsPath = `${directory}/packets.private.jsonl`;
const keyPath = `${directory}/answer-key.private.json`;
const manifestPath = `${directory}/manifest.json`;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validatePacket = ajv.compile(JSON.parse(await readFile("data/schema/loop-packet.schema.json", "utf8")));
const validateKey = ajv.compile(JSON.parse(await readFile("data/schema/loop-calibration-key.schema.json", "utf8")));
const validateManifest = ajv.compile(JSON.parse(await readFile("data/schema/loop-calibration-manifest.schema.json", "utf8")));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const key = JSON.parse(await readFile(keyPath, "utf8"));
assertValid(validateManifest, manifest, manifestPath);
assertValid(validateKey, key, keyPath);

const requiredInputs = ["data/loop/baseline-v1/cases.jsonl", "data/loop/converter-policy-v2.md", "data/loop/rubric-v1.md"];
const requiredArtifacts = [packetsPath, keyPath];
assertEqual(JSON.stringify(manifest.inputs.map((item: { path: string }) => item.path).sort()), JSON.stringify([...requiredInputs].sort()), "calibration input membership");
assertEqual(JSON.stringify(manifest.artifacts.map((item: { path: string }) => item.path).sort()), JSON.stringify([...requiredArtifacts].sort()), "calibration artifact membership");
for (const file of [...manifest.inputs, ...manifest.artifacts]) assertEqual(await sha256File(file.path), file.sha256, `${file.path} SHA-256`);
assertEqual(key.calibrationId, manifest.calibrationId, "calibration manifest/key ID");

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
  assertEqual(packet.caseHash, digest(JSON.stringify({ sourceMarkdown: packet.sourceMarkdown, options: packet.options, messages: packet.outputMessages, warnings: packet.warningCodes })), `${packet.packetId} case hash`);
  packets.push(packet);
}
assertEqual(packets.length, manifest.records, "calibration record count");
assertEqual(key.answers.length, packets.length, "calibration answer count");
assertEqual(manifest.positiveControls + manifest.negativeControls, packets.length, "calibration control count");
const packetIdentity = new Map(packets.map((packet) => [packet.packetId, packet.caseHash]));
for (const answer of key.answers) assertEqual(packetIdentity.get(answer.packetId), answer.caseHash, `${answer.packetId} answer mapping`);
assertEqual(new Set(key.answers.map((answer: { baselineCaseId: string }) => answer.baselineCaseId)).size, manifest.positiveControls, "unique calibration parents");
console.log(`Validated ${packets.length} blinded controls and hidden answer mappings.`);

function assertValid(validate: any, value: unknown, identity: string): void { if (!validate(value)) throw new Error(`${identity}: ${ajv.errorsText(validate.errors)}`); }
function assertEqual(actual: unknown, expected: unknown, identity: string): void { if (actual !== expected) throw new Error(`${identity}: expected ${expected}, received ${actual}`); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
