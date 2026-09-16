import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const candidateDirectory = "data/work/semantic-eval-candidates-v2";
const consensusDirectory = "data/work/semantic-eval-consensus-v2";
const outputDirectory = "data/work/semantic-eval-adjudication-v3";
const packets = new Map((await loadJsonl<Record<string, any>>(`${candidateDirectory}/packets.private.jsonl`)).map((item) => [item.candidateId, item]));
const escalations = await loadJsonl<Record<string, any>>(`${consensusDirectory}/escalations.private.jsonl`);
const reviewPaths = repeatedArgument("--review");
if (reviewPaths.length !== 2) throw new Error("Pass exactly two complete --review files");
if (!escalations.length) throw new Error("No escalation cases to prepare");
const reviews = await Promise.all(reviewPaths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
const byReview = reviews.map((submission) => new Map<string, Record<string, any>>(submission.reviews.map((item: Record<string, any>) => [item.candidateId, item])));
const promptPath = "data/loop/semantic-adjudicator-prompt-v3.md";
const policyPath = "data/loop/converter-policy-v2.md";
const rubricPath = "data/loop/semantic-model-rubric-v2.md";
const manifestPath = `${candidateDirectory}/manifest.private.json`;
const shardSize = integerArgument("--shard-size", 20);
const generatedAt = new Date().toISOString();
await mkdir(outputDirectory, { recursive: true });
const jobs: Array<{ path: string; sha256: string; records: number }> = [];
for (let offset = 0; offset < escalations.length; offset += shardSize) {
  const shard = Math.floor(offset / shardSize) + 1;
  const path = `${outputDirectory}/astra-${String(shard).padStart(3, "0")}.private.json`;
  const cases = escalations.slice(offset, offset + shardSize).map((escalation) => {
    const source = packets.get(escalation.candidateId); if (!source) throw new Error(`Unknown ${escalation.candidateId}`);
    const left = byReview[0].get(escalation.candidateId)!; const right = byReview[1].get(escalation.candidateId)!;
    const leftHash = reviewHash(reviews[0].reviewerId, left); const rightHash = reviewHash(reviews[1].reviewerId, right);
    if (JSON.stringify(escalation.reviewHashes) !== JSON.stringify([leftHash, rightHash])) throw new Error(`${escalation.candidateId} review hash mismatch`);
    const swap = digest(`semantic-adjudication-order-v2\0${escalation.candidateId}`).charCodeAt(0) % 2 === 1;
    const ordered = swap ? [[rightHash, right], [leftHash, left]] : [[leftHash, left], [rightHash, right]];
    return { candidateId: escalation.candidateId, sourcePacket: source, reviews: ordered.map(([reviewHash, review], index) => ({ slot: index === 0 ? "A" : "B", reviewHash, review })) };
  });
  const job = {
    schemaVersion: 2, jobId: `astra-semantic-v3-${String(shard).padStart(3, "0")}`,
    instructions: { promptPath, policyPath, rubricPath, outputSchemaPath: "data/schema/eval-adjudication.schema.json", readBoundary: "Read only this job and the four listed files." },
    envelope: { schemaVersion: 2, adjudicationId: `astra-semantic-v3-${String(shard).padStart(3, "0")}`, candidateSetId: "semantic-eval-candidates-v2", candidateManifestSha256: await sha256File(manifestPath), modelIdentity: "openai-codex/gpt-6-astra", thinking: "xhigh", promptVersion: "semantic-adjudicator-prompt-v3", promptSha256: await sha256File(promptPath), policySha256: await sha256File(policyPath), completedAt: generatedAt },
    cases
  };
  await atomicWrite(path, JSON.stringify(job, null, 2) + "\n"); jobs.push({ path, sha256: await sha256File(path), records: cases.length });
}
await atomicWrite(`${outputDirectory}/manifest.private.json`, JSON.stringify({ schemaVersion: 2, adjudicationRunId: "astra-semantic-v3", records: escalations.length, shardSize, jobs, inputs: [{ path: `${consensusDirectory}/escalations.private.jsonl`, sha256: await sha256File(`${consensusDirectory}/escalations.private.jsonl`) }, ...await Promise.all(reviewPaths.map(async (path) => ({ path, sha256: await sha256File(path) })))] }, null, 2) + "\n");
console.log(`Prepared ${jobs.length} blinded Astra escalation jobs for ${escalations.length} cases.`);

function reviewHash(reviewerId: string, review: Record<string, any>): string { return digest(canonical({ reviewerId, review })); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function repeatedArgument(name: string): string[] { const values: string[] = []; for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[i + 1]); return values; }
function integerArgument(name: string, fallback: number): number { const index = process.argv.indexOf(name); if (index < 0) return fallback; const value = Number(process.argv[index + 1]); if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`); return value; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function loadJsonl<T>(path: string): Promise<T[]> { const result: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) result.push(JSON.parse(line)); return result; }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
