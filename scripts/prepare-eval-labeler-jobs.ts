import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const candidateDirectory = "data/work/semantic-eval-candidates-v2";
const outputDirectory = "data/work/semantic-eval-labeler-v2";
const packetsPath = `${candidateDirectory}/packets.private.jsonl`;
const manifestPath = `${candidateDirectory}/manifest.private.json`;
const promptPath = "data/loop/semantic-labeler-prompt-v2.md";
const policyPath = "data/loop/converter-policy-v2.md";
const shardSize = integerArgument("--shard-size", 20);
if (shardSize < 1) throw new Error("--shard-size must be positive");
if (!process.argv.includes("--approve-external-private-text-processing")) throw new Error("Refusing to package private natural-language text for model review without --approve-external-private-text-processing after an authorized privacy/runtime review");

const packets = await loadJsonl<Record<string, unknown>>(packetsPath);
const manifestSha256 = await sha256File(manifestPath);
const promptSha256 = await sha256File(promptPath);
const policySha256 = await sha256File(policyPath);
const generatedAt = new Date().toISOString();
await mkdir(outputDirectory, { recursive: true });
const jobs: Array<{ path: string; sha256: string; lane: string; records: number }> = [];
for (const lane of ["a", "b"] as const) {
  const thinking = "high" as const;
  const ordered = [...packets].sort((left, right) => rank(lane, String(left.candidateId)).localeCompare(rank(lane, String(right.candidateId))));
  for (let offset = 0; offset < ordered.length; offset += shardSize) {
    const shard = Math.floor(offset / shardSize) + 1;
    const path = `${outputDirectory}/luna-${lane}-${String(shard).padStart(3, "0")}.private.json`;
    const reviewerId = `luna-${lane}-semantic-v1`;
    const job = {
      schemaVersion: 2,
      jobId: `${reviewerId}-shard-${String(shard).padStart(3, "0")}`,
      instructions: {
        promptPath,
        rubricPath: "data/loop/semantic-model-rubric-v2.md",
        policyPath,
        outputSchemaPath: "data/schema/eval-review.schema.json",
        readBoundary: "Read only this job and the four listed repository files. Do not inspect converter code, output, tests, provenance, split data, or other jobs/reviews."
      },
      envelope: {
        schemaVersion: 2,
        reviewId: `${reviewerId}-shard-${String(shard).padStart(3, "0")}`,
        candidateSetId: "semantic-eval-candidates-v2",
        candidateManifestSha256: manifestSha256,
        reviewerId,
        reviewerKind: "model",
        modelIdentity: "openai-codex/gpt-5.6-luna",
        thinking,
        promptVersion: "semantic-labeler-prompt-v2",
        promptSha256,
        rubricVersion: "semantic-model-rubric-v2",
        policySha256,
        completedAt: generatedAt
      },
      packets: ordered.slice(offset, offset + shardSize)
    };
    await atomicWrite(path, JSON.stringify(job, null, 2) + "\n");
    jobs.push({ path, sha256: await sha256File(path), lane, records: job.packets.length });
  }
}
await atomicWrite(`${outputDirectory}/manifest.private.json`, JSON.stringify({
  schemaVersion: 2,
  labelerRunId: "luna-semantic-labeler-v2",
  modelIdentity: "openai-codex/gpt-5.6-luna",
  records: packets.length,
  shardSize,
  jobs,
  inputs: [
    { path: packetsPath, sha256: await sha256File(packetsPath) },
    { path: manifestPath, sha256: manifestSha256 },
    { path: promptPath, sha256: promptSha256 },
    { path: policyPath, sha256: policySha256 }
  ]
}, null, 2) + "\n");
console.log(`Prepared ${jobs.length} Luna labeler jobs (${packets.length} candidates × two fresh high-thinking lanes) in ${outputDirectory}`);

function rank(lane: string, candidateId: string): string { return createHash("sha256").update(`luna-labeler-order-v2\0${lane}\0${candidateId}`).digest("hex"); }
function integerArgument(name: string, fallback: number): number { const index = process.argv.indexOf(name); if (index < 0) return fallback; const value = Number(process.argv[index + 1]); if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`); return value; }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function loadJsonl<T>(path: string): Promise<T[]> { const rows: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line)); return rows; }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
