import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const pilotDirectory = "data/work/loop-pilot-v1";
const evaluationDirectory = `${pilotDirectory}/evaluation`;
const outputDirectory = `${pilotDirectory}/adjudication`;
const packets = await loadJsonl<Record<string, any>>(`${pilotDirectory}/packets.private.jsonl`);
const triage = await loadJsonl<Record<string, any>>(`${evaluationDirectory}/triage.private.jsonl`);
const judgments = await loadJsonl<Record<string, any>>(`${evaluationDirectory}/judgments.private.jsonl`);
const packetMap = new Map(packets.map((packet) => [packet.packetId, packet]));
const judgmentsByPacket = new Map<string, Record<string, any>[]>();
for (const record of judgments) {
  const list = judgmentsByPacket.get(record.packetId) ?? [];
  list.push(record);
  judgmentsByPacket.set(record.packetId, list);
}
const selected = triage.filter((record) => record.route !== "no-review");
const adjudicationPackets = selected.map((record) => {
  const packet = packetMap.get(record.packetId);
  if (!packet) throw new Error(`Missing packet ${record.packetId}`);
  const records = judgmentsByPacket.get(record.packetId) ?? [];
  if (records.length < 2) throw new Error(`Missing judgments for ${record.packetId}`);
  return {
    schemaVersion: 1,
    adjudicationPacketId: `adjudication-v1-${packet.caseHash.slice(0, 16)}`,
    caseHash: packet.caseHash,
    rubricVersion: packet.rubricVersion,
    policyVersion: packet.policyVersion,
    sourceMarkdown: packet.sourceMarkdown,
    options: packet.options,
    outputMessages: packet.outputMessages,
    warningCodes: packet.warningCodes,
    route: record.route,
    judgments: records.map((item) => ({
      judgmentSha256: item.judgmentSha256,
      protocolStatus: item.protocolStatus,
      scores: item.judgment.scores,
      verdict: item.judgment.verdict,
      citations: item.judgment.citations,
      confidence: item.judgment.confidence,
      ...(item.quarantineReason ? { quarantineReason: item.quarantineReason } : {})
    }))
  };
});
await mkdir(outputDirectory, { recursive: true });
const packetsPath = `${outputDirectory}/packets.private.jsonl`;
await atomicText(packetsPath, adjudicationPackets.map((packet) => JSON.stringify(packet)).join("\n") + "\n");
await atomicText(`${outputDirectory}/manifest.private.json`, JSON.stringify({
  schemaVersion: 1,
  adjudicationId: "public-pilot-v1-adjudication",
  status: "prepared",
  records: adjudicationPackets.length,
  sourcePacketsSha256: await sha256File(`${pilotDirectory}/packets.private.jsonl`),
  triageSha256: await sha256File(`${evaluationDirectory}/triage.private.jsonl`),
  judgmentsSha256: await sha256File(`${evaluationDirectory}/judgments.private.jsonl`),
  packetsSha256: await sha256File(packetsPath),
  disclosure: "Packets omit baseline identity, provenance, label class, split, critic identity, expected output, and answer keys."
}, null, 2) + "\n");
console.log(`Prepared ${adjudicationPackets.length} blinded adjudication packets.`);

async function loadJsonl<T>(path: string): Promise<T[]> { const records: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) records.push(JSON.parse(line)); return records; }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function atomicText(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
