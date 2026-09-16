import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";

const directory = "data/work/loop-pilot-v1";
const packetsPath = `${directory}/packets.private.jsonl`;
const indexPath = `${directory}/index.private.json`;
const outputDirectory = `${directory}/evaluation`;
const criticArguments = values("--critic");
if (criticArguments.length < 2) throw new Error("Provide at least two --critic id:provider:model=path arguments");
const critics = criticArguments.map(parseCritic);
if (new Set(critics.map((critic) => critic.id)).size !== critics.length) throw new Error("Critic IDs must be unique");

const packets = await loadJsonl<Record<string, any>>(packetsPath);
const packetMap = new Map(packets.map((packet) => [packet.packetId, packet]));
const index = JSON.parse(await readFile(indexPath, "utf8"));
const mappingMap = new Map<string, Record<string, any>>(index.mappings.map((mapping: Record<string, any>) => [mapping.packetId, mapping]));
if (packets.length !== index.mappings.length) throw new Error("Packet/index count mismatch");
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const criticValidator = ajv.compile(JSON.parse(await readFile("data/schema/loop-critic-output.schema.json", "utf8")));
const judgmentValidator = ajv.compile(JSON.parse(await readFile("data/schema/loop-judgment.schema.json", "utf8")));
const promptSha256 = await sha256File("data/loop/critic-prompt-v3.md");
const judgmentsByCritic = new Map<string, Map<string, Record<string, any>>>();
const criticSummaries = [];
const normalizedJudgments: Record<string, any>[] = [];

for (const critic of critics) {
  const raw = JSON.parse(await readFile(critic.path, "utf8"));
  validate(criticValidator, raw, critic.path);
  if (raw.judgments.length !== packets.length) throw new Error(`${critic.id}: returned ${raw.judgments.length}/${packets.length} judgments`);
  const byPacket = new Map<string, Record<string, any>>();
  const verdicts = { pass: 0, fail: 0, abstain: 0 };
  let goldPass = 0;
  for (const rawJudgment of raw.judgments) {
    const packet = packetMap.get(rawJudgment.packetId);
    if (!packet) throw new Error(`${critic.id}: unknown packet ${rawJudgment.packetId}`);
    if (byPacket.has(rawJudgment.packetId)) throw new Error(`${critic.id}: duplicate packet ${rawJudgment.packetId}`);
    if (rawJudgment.caseHash !== packet.caseHash) throw new Error(`${critic.id}: case hash mismatch for ${rawJudgment.packetId}`);
    validateCitations(rawJudgment, packet, critic.id);
    const judgment = {
      schemaVersion: 1,
      judgmentId: `public-pilot-v1:${critic.id}:${rawJudgment.packetId}`,
      caseHash: rawJudgment.caseHash,
      critic: { role: "critic", provider: critic.provider, model: critic.model },
      promptSha256,
      rubricVersion: packet.rubricVersion,
      presentationNonce: packet.presentationNonce,
      scores: rawJudgment.scores,
      verdict: rawJudgment.verdict,
      citations: rawJudgment.citations,
      confidence: rawJudgment.confidence,
      ...(rawJudgment.abstentionReason ? { abstentionReason: rawJudgment.abstentionReason } : {})
    };
    validate(judgmentValidator, judgment, judgment.judgmentId);
    const record = { packetId: rawJudgment.packetId, judgment, judgmentSha256: sha256Value(judgment) };
    normalizedJudgments.push(record);
    byPacket.set(rawJudgment.packetId, record);
    verdicts[rawJudgment.verdict as keyof typeof verdicts]++;
    if (mappingMap.get(rawJudgment.packetId)?.labelClass === "gold" && rawJudgment.verdict === "pass") goldPass++;
  }
  if (byPacket.size !== packets.length) throw new Error(`${critic.id}: incomplete packet coverage`);
  judgmentsByCritic.set(critic.id, byPacket);
  criticSummaries.push({
    criticId: critic.id,
    provider: critic.provider,
    model: critic.model,
    outputSha256: await sha256File(critic.path),
    verdicts,
    meanConfidence: raw.judgments.reduce((sum: number, item: any) => sum + item.confidence, 0) / raw.judgments.length,
    goldPasses: goldPass,
    goldTotal: index.mappings.filter((mapping: any) => mapping.labelClass === "gold").length
  });
}

const pairwiseAgreement = [];
for (let left = 0; left < critics.length; left++) for (let right = left + 1; right < critics.length; right++) {
  let agreements = 0;
  for (const packet of packets) {
    const a = judgmentsByCritic.get(critics[left].id)!.get(packet.packetId)!.judgment.verdict;
    const b = judgmentsByCritic.get(critics[right].id)!.get(packet.packetId)!.judgment.verdict;
    if (a === b) agreements++;
  }
  pairwiseAgreement.push({ left: critics[left].id, right: critics[right].id, agreements, total: packets.length, rate: agreements / packets.length });
}

const routingCounts: Record<string, number> = {};
const triage = packets.map((packet) => {
  const judgments = critics.map((critic) => judgmentsByCritic.get(critic.id)!.get(packet.packetId)!);
  const verdicts = judgments.map((record) => record.judgment.verdict);
  const uniqueVerdicts = new Set(verdicts);
  const route = verdicts.includes("abstain") ? "adjudicate-abstention"
    : uniqueVerdicts.size > 1 ? "adjudicate-disagreement"
    : verdicts[0] === "fail" ? "adjudicate-unanimous-failure"
    : "no-review";
  routingCounts[route] = (routingCounts[route] ?? 0) + 1;
  const mapping = mappingMap.get(packet.packetId)!;
  return {
    packetId: packet.packetId,
    caseHash: packet.caseHash,
    baselineCaseId: mapping.baselineCaseId,
    labelClass: mapping.labelClass,
    route,
    judgments: judgments.map((record, index) => ({ criticId: critics[index].id, verdict: record.judgment.verdict, judgmentSha256: record.judgmentSha256 }))
  };
});

await mkdir(outputDirectory, { recursive: true });
await atomicText(`${outputDirectory}/judgments.private.jsonl`, normalizedJudgments.map((record) => JSON.stringify(record)).join("\n") + "\n");
await atomicText(`${outputDirectory}/triage.private.jsonl`, triage.map((record) => JSON.stringify(record)).join("\n") + "\n");
const summary = {
  schemaVersion: 1,
  pilotId: index.pilotId,
  records: packets.length,
  inputs: {
    packetsSha256: await sha256File(packetsPath),
    indexSha256: await sha256File(indexPath),
    promptSha256,
    rubricSha256: await sha256File("data/loop/rubric-v1.md"),
    policySha256: await sha256File("data/loop/converter-policy-v2.md")
  },
  critics: criticSummaries,
  pairwiseAgreement,
  routingCounts,
  interpretation: "Agent judgments and routing are triage-only. Gold-pass counts apply only to existing policy-gold controls; invariant-only cases have no correctness label."
};
await atomicJson(`${outputDirectory}/summary.private.json`, summary);
console.log(criticSummaries.map((critic) => `${critic.criticId}: ${critic.verdicts.pass} pass, ${critic.verdicts.fail} fail, ${critic.verdicts.abstain} abstain; gold ${critic.goldPasses}/${critic.goldTotal}`).join("\n"));
console.log(pairwiseAgreement.map((pair) => `${pair.left}/${pair.right}: ${(pair.rate * 100).toFixed(1)}% agreement`).join("\n"));
console.log(Object.entries(routingCounts).map(([route, count]) => `${route}: ${count}`).join("\n"));

function parseCritic(argument: string): { id: string; provider: string; model: string; path: string } {
  const separator = argument.indexOf("=");
  if (separator <= 0) throw new Error(`Invalid critic argument: ${argument}`);
  const identity = argument.slice(0, separator).split(":");
  if (identity.length !== 3 || identity.some((part) => !part)) throw new Error(`Expected id:provider:model=path, received ${argument}`);
  return { id: identity[0], provider: identity[1], model: identity[2], path: argument.slice(separator + 1) };
}
function validateCitations(judgment: Record<string, any>, packet: Record<string, any>, critic: string): void {
  const sides = { source: packet.sourceMarkdown, output: packet.outputMessages.join("\n\n") };
  for (const citation of judgment.citations) {
    const length = Array.from(sides[citation.side as keyof typeof sides]).length;
    if (citation.end <= citation.start || citation.end > length) throw new Error(`${critic}: invalid ${citation.side} citation ${citation.start}:${citation.end} for ${judgment.packetId} length ${length}`);
  }
}
function validate(validator: any, value: unknown, identity: string): void { if (!validator(value)) throw new Error(`${identity}: ${ajv.errorsText(validator.errors)}`); }
function values(name: string): string[] { const result: string[] = []; for (let index = 0; index < process.argv.length; index++) if (process.argv[index] === name && process.argv[index + 1]) result.push(process.argv[++index]); return result; }
function sha256Value(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function loadJsonl<T>(path: string): Promise<T[]> { const records: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) records.push(JSON.parse(line)); return records; }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function atomicJson(path: string, value: unknown): Promise<void> { await atomicText(path, JSON.stringify(value, null, 2) + "\n"); }
async function atomicText(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
