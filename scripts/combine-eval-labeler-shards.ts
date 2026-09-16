import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const lane = argument("--lane");
if (lane !== "a" && lane !== "b") throw new Error("--lane must be a or b");
const reviewPaths = repeatedArgument("--review");
if (!reviewPaths.length) throw new Error("Pass one or more --review shard files");
const outputPath = argument("--output") ?? `data/work/semantic-eval-labeler-v2/luna-${lane}-combined.private.json`;
const packets = await loadJsonl<Record<string, any>>("data/work/semantic-eval-candidates-v2/packets.private.jsonl");
const packetTokens = new Map(packets.map((packet) => [packet.candidateId, packet.sourceToken]));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schema = JSON.parse(await readFile("data/schema/eval-review.schema.json", "utf8"));
const validate = ajv.compile(schema);
const shards = await Promise.all(reviewPaths.map(async (path) => ({ path, value: JSON.parse(await readFile(path, "utf8")) })));
for (const shard of shards) {
  if (!validate(shard.value)) throw new Error(`${shard.path}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  for (const review of shard.value.reviews) validateLabelSemantics(review, shard.path);
}
const first = shards[0].value;
for (const shard of shards) {
  const value = shard.value;
  for (const key of ["candidateSetId", "candidateManifestSha256", "reviewerId", "reviewerKind", "modelIdentity", "thinking", "promptVersion", "promptSha256", "rubricVersion", "policySha256"] ) {
    if (value[key] !== first[key]) throw new Error(`${shard.path} differs on ${key}`);
  }
  if (value.modelIdentity !== "openai-codex/gpt-5.6-luna" || value.thinking !== "high") throw new Error(`${shard.path} is not a Luna high review`);
  if (value.reviewerId !== `luna-${lane}-semantic-v1`) throw new Error(`${shard.path} belongs to reviewer ${value.reviewerId}`);
}
const reviews: Record<string, any>[] = [];
const seen = new Set<string>();
for (const shard of shards) for (const review of shard.value.reviews) {
  if (seen.has(review.candidateId)) throw new Error(`Duplicate candidate ${review.candidateId}`);
  if (!packetTokens.has(review.candidateId)) throw new Error(`Unknown candidate ${review.candidateId}`);
  if (packetTokens.get(review.candidateId) !== review.sourceToken) throw new Error(`Source token mismatch for ${review.candidateId}`);
  seen.add(review.candidateId);
  reviews.push(review);
}
if (seen.size !== packetTokens.size || [...packetTokens.keys()].some((id) => !seen.has(id))) throw new Error(`Combined ${seen.size}/${packetTokens.size} candidates`);
const combined = {
  ...Object.fromEntries(Object.entries(first).filter(([key]) => key !== "reviews" && key !== "reviewId" && key !== "completedAt")),
  reviewId: `${first.reviewerId}-combined`,
  completedAt: shards.map((item) => item.value.completedAt).sort().at(-1),
  reviews: reviews.sort((left, right) => left.candidateId.localeCompare(right.candidateId))
};
if (!validate(combined)) throw new Error(`Combined review: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
await atomicWrite(outputPath, JSON.stringify(combined, null, 2) + "\n");
console.log(`Combined ${reviews.length} Luna lane ${lane} reviews into ${outputPath}`);

function validateLabelSemantics(review: Record<string, any>, path: string): void {
  if (review.decision !== "label" || review.label.mode !== "semantic") return;
  const assertions = review.label.assertions;
  for (const [required, forbidden] of [["requiredText", "forbiddenText"], ["requiredUrls", "forbiddenUrls"], ["requiredWarningCodes", "forbiddenWarningCodes"]]) {
    const overlap = assertions[required].filter((value: string) => assertions[forbidden].includes(value));
    if (overlap.length) throw new Error(`${path}/${review.candidateId}: contradictory ${required}/${forbidden}: ${overlap.join(", ")}`);
  }
}
function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function repeatedArgument(name: string): string[] { const values: string[] = []; for (let index = 0; index < process.argv.length; index++) if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]); return values; }
async function loadJsonl<T>(path: string): Promise<T[]> { const rows: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line)); return rows; }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
