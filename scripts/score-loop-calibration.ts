import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";

const directory = "data/work/loop-calibration-v1";
const packetsPath = `${directory}/packets.private.jsonl`;
const keyPath = `${directory}/answer-key.private.json`;
const outputPath = `${directory}/score.private.json`;
const criticArguments = values("--critic");
if (criticArguments.length < 2) throw new Error("Provide at least two --critic name=path arguments");
const critics = criticArguments.map((argument) => {
  const separator = argument.indexOf("=");
  if (separator <= 0) throw new Error(`Invalid critic argument: ${argument}`);
  return { name: argument.slice(0, separator), path: argument.slice(separator + 1) };
});
if (new Set(critics.map((item) => item.name)).size !== critics.length) throw new Error("Critic names must be unique");

const packets = await loadJsonl<Record<string, any>>(packetsPath);
const packetMap = new Map(packets.map((packet) => [packet.packetId, packet]));
const key = JSON.parse(await readFile(keyPath, "utf8"));
const answerMap = new Map<string, Record<string, any>>(key.answers.map((answer: Record<string, any>) => [answer.packetId, answer]));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validate = ajv.compile(JSON.parse(await readFile("data/schema/loop-critic-output.schema.json", "utf8")));
const results = [];
const judgmentsByCritic = new Map<string, Map<string, Record<string, any>>>();

for (const critic of critics) {
  const output = JSON.parse(await readFile(critic.path, "utf8"));
  if (!validate(output)) throw new Error(`${critic.path}: ${ajv.errorsText(validate.errors)}`);
  if (output.judgments.length !== packets.length) throw new Error(`${critic.name} returned ${output.judgments.length}/${packets.length} judgments`);
  const judgments = new Map<string, Record<string, any>>();
  for (const judgment of output.judgments) {
    const packet = packetMap.get(judgment.packetId);
    if (!packet) throw new Error(`${critic.name}: unknown packet ${judgment.packetId}`);
    if (judgments.has(judgment.packetId)) throw new Error(`${critic.name}: duplicate packet ${judgment.packetId}`);
    if (judgment.caseHash !== packet.caseHash) throw new Error(`${critic.name}: case hash mismatch ${judgment.packetId}`);
    validateCitations(judgment, packet, critic.name);
    judgments.set(judgment.packetId, judgment);
  }
  const counts = { correct: 0, incorrect: 0, abstain: 0, truePass: 0, falseFail: 0, trueFail: 0, falsePass: 0 };
  for (const packet of packets) {
    const judgment = judgments.get(packet.packetId)!;
    const expected = answerMap.get(packet.packetId)?.expectedVerdict;
    if (judgment.verdict === "abstain") counts.abstain++;
    else if (judgment.verdict === expected) counts.correct++;
    else counts.incorrect++;
    if (expected === "pass") judgment.verdict === "pass" ? counts.truePass++ : counts.falseFail++;
    if (expected === "fail") judgment.verdict === "fail" ? counts.trueFail++ : counts.falsePass++;
  }
  judgmentsByCritic.set(critic.name, judgments);
  results.push({
    name: critic.name,
    path: critic.path,
    sha256: await sha256File(critic.path),
    ...counts,
    accuracyIncludingAbstainAsError: counts.correct / packets.length,
    positiveControlRecall: counts.truePass / key.answers.filter((item: any) => item.expectedVerdict === "pass").length,
    negativeControlRecall: counts.trueFail / key.answers.filter((item: any) => item.expectedVerdict === "fail").length,
    meanConfidence: output.judgments.reduce((sum: number, item: any) => sum + item.confidence, 0) / output.judgments.length
  });
}

const pairwiseAgreement = [];
for (let left = 0; left < critics.length; left++) for (let right = left + 1; right < critics.length; right++) {
  let agreements = 0;
  for (const packet of packets) if (judgmentsByCritic.get(critics[left].name)!.get(packet.packetId)!.verdict === judgmentsByCritic.get(critics[right].name)!.get(packet.packetId)!.verdict) agreements++;
  pairwiseAgreement.push({ left: critics[left].name, right: critics[right].name, agreements, total: packets.length, rate: agreements / packets.length });
}
await atomicJson(outputPath, {
  schemaVersion: 1,
  calibrationId: key.calibrationId,
  packetsSha256: await sha256File(packetsPath),
  answerKeySha256: await sha256File(keyPath),
  prompt: { path: "data/loop/critic-prompt-v3.md", sha256: await sha256File("data/loop/critic-prompt-v3.md") },
  rubric: { path: "data/loop/rubric-v1.md", sha256: await sha256File("data/loop/rubric-v1.md") },
  policy: { path: "data/loop/converter-policy-v2.md", sha256: await sha256File("data/loop/converter-policy-v2.md") },
  critics: results,
  pairwiseAgreement,
  interpretation: "Control accuracy measures critic calibration only. It is not converter quality and does not promote agent judgments to gold."
});
console.log(results.map((item) => `${item.name}: ${(item.accuracyIncludingAbstainAsError * 100).toFixed(1)}% accuracy, ${(item.negativeControlRecall * 100).toFixed(1)}% negative recall`).join("\n"));
console.log(pairwiseAgreement.map((item) => `${item.left}/${item.right}: ${(item.rate * 100).toFixed(1)}% agreement`).join("\n"));

function validateCitations(judgment: Record<string, any>, packet: Record<string, any>, critic: string): void {
  const values = { source: packet.sourceMarkdown, output: packet.outputMessages.join("\n\n") };
  for (const citation of judgment.citations) {
    const length = Array.from(values[citation.side as keyof typeof values]).length;
    if (citation.end <= citation.start || citation.end > length) throw new Error(`${critic}: invalid ${citation.side} citation ${citation.start}:${citation.end} for ${judgment.packetId} length ${length}`);
  }
}
function values(name: string): string[] { const result: string[] = []; for (let index = 0; index < process.argv.length; index++) if (process.argv[index] === name && process.argv[index + 1]) result.push(process.argv[++index]); return result; }
async function loadJsonl<T>(path: string): Promise<T[]> { const records: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) records.push(JSON.parse(line)); return records; }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function atomicJson(path: string, value: unknown): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + "\n"); await rename(temporary, path); }
