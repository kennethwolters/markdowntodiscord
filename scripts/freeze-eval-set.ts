import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const candidateDirectory = "data/work/semantic-eval-candidates-v2";
const outputDirectory = "data/work/semantic-eval-consensus-v2";
const packetsPath = `${candidateDirectory}/packets.private.jsonl`;
const indexPath = `${candidateDirectory}/index.private.json`;
const manifestPath = `${candidateDirectory}/manifest.private.json`;
const keyPath = `${candidateDirectory}/blinding-key.private`;
const policyPath = "data/loop/converter-policy-v2.md";
const promptPath = "data/loop/semantic-labeler-prompt-v2.md";
const goldPath = `${outputDirectory}/labels.private.jsonl`;
const escalationPath = `${outputDirectory}/escalations.private.jsonl`;
const reportPath = `${outputDirectory}/report.private.json`;
const reviewPaths = repeatedArgument("--review");
if (reviewPaths.length !== 2) throw new Error("Pass exactly two complete blinded review files");

const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
const reviewSchema = JSON.parse(await readFile("data/schema/eval-review.schema.json", "utf8")); ajv.addSchema(reviewSchema);
const validateReview = ajv.getSchema(reviewSchema.$id)!;
const validatePacket = ajv.compile(JSON.parse(await readFile("data/schema/eval-candidate-packet.schema.json", "utf8")));
const validateManifest = ajv.compile(JSON.parse(await readFile("data/schema/eval-candidate-manifest.schema.json", "utf8")));
const validateGold = ajv.compile(JSON.parse(await readFile("data/schema/eval-consensus.schema.json", "utf8")));
const submissions = await Promise.all(reviewPaths.map(async (path) => ({ path, value: JSON.parse(await readFile(path, "utf8")), sha256: await sha256File(path) })));
for (const item of submissions) assertValid(validateReview, item.value, item.path);
if (submissions[0].value.reviewerId === submissions[1].value.reviewerId) throw new Error("Review identities must differ");
if (submissions.some((item) => item.value.modelIdentity !== "openai-codex/gpt-5.6-luna" || item.value.thinking !== "high")) throw new Error("Bulk review requires Luna high");

const manifest = JSON.parse(await readFile(manifestPath, "utf8")); assertValid(validateManifest, manifest, manifestPath);
const manifestSha256 = await sha256File(manifestPath);
const promptSha256 = await sha256File(promptPath);
const policySha256 = await sha256File(policyPath);
for (const item of submissions) {
  if (item.value.candidateManifestSha256 !== manifestSha256 || item.value.promptSha256 !== promptSha256 || item.value.policySha256 !== policySha256) throw new Error(`${item.path} has stale bindings`);
}
for (const artifact of manifest.artifacts) if (await sha256File(artifact.path) !== artifact.sha256) throw new Error(`${artifact.path} differs from manifest`);
const key = (await readFile(keyPath, "utf8")).trim();
const packetRows = await loadJsonl<Record<string, any>>(packetsPath);
const packets = new Map<string, Record<string, any>>();
for (const [index, packet] of packetRows.entries()) { assertValid(validatePacket, packet, `${packetsPath}:${index + 1}`); packets.set(packet.candidateId, packet); }
const index = JSON.parse(await readFile(indexPath, "utf8"));
const mappings = new Map<string, Record<string, any>>(index.mappings.map((item: Record<string, any>) => [item.candidateId, item]));
if (packets.size !== manifest.records || mappings.size !== manifest.records) throw new Error("Candidate cardinality mismatch");
for (const [id, packet] of packets) {
  const mapping = mappings.get(id); if (!mapping) throw new Error(`Missing mapping ${id}`);
  const contentHash = digest(packet.sourceMarkdown.replace(/\r\n?/g, "\n"));
  if (id !== `eval-v2-${keyedDigest(key, `candidate-v2\0${contentHash}`).slice(0, 16)}` || mapping.sourceSha256 !== contentHash) throw new Error(`${id} identity binding failed`);
}
const reviews = submissions.map((submission) => {
  const map = new Map<string, Record<string, any>>();
  for (const review of submission.value.reviews) {
    if (map.has(review.candidateId) || !packets.has(review.candidateId)) throw new Error(`${submission.path} has duplicate or unknown ${review.candidateId}`);
    if (packets.get(review.candidateId)!.sourceToken !== review.sourceToken) throw new Error(`${review.candidateId} source token mismatch`);
    map.set(review.candidateId, review);
  }
  if (map.size !== packets.size || [...packets.keys()].some((id) => !map.has(id))) throw new Error(`${submission.path} covers ${map.size}/${packets.size} candidates`);
  return map;
});

const direct: Record<string, any>[] = [];
const escalations: Record<string, any>[] = [];
for (const candidateId of [...packets.keys()].sort()) {
  const first = reviews[0].get(candidateId)!; const second = reviews[1].get(candidateId)!; const mapping = mappings.get(candidateId)!;
  const agrees = first.decision === "label" && second.decision === "label" && first.privacy.decision === "approved" && second.privacy.decision === "approved" && canonical(comparable(first)) === canonical(comparable(second));
  const requiresAudit = mapping.highImpact || mapping.split === "challenge" || first.risk === "unsafe" || second.risk === "unsafe";
  if (!agrees || requiresAudit) {
    escalations.push({
      schemaVersion: 2, candidateId, sourceToken: first.sourceToken,
      route: !agrees ? "review-disagreement" : mapping.split === "challenge" ? "challenge-audit" : "high-impact-audit",
      reasons: !agrees ? disagreementReasons(first, second) : [mapping.portfolioBucket, ...(first.risk === "unsafe" ? ["unsafe-risk"] : [])],
      reviewHashes: submissions.map((submission, index) => reviewHash(submission.value.reviewerId, index === 0 ? first : second))
    });
    continue;
  }
  direct.push(buildRecord(candidateId, first, mapping, packets.get(candidateId)!, submissions, promptSha256));
}
for (const record of direct) assertValid(validateGold, record, record.id);
await mkdir(outputDirectory, { recursive: true });
await atomicWrite(goldPath, direct.map((item) => JSON.stringify(item)).join("\n") + (direct.length ? "\n" : ""));
await atomicWrite(escalationPath, escalations.map((item) => JSON.stringify(item)).join("\n") + (escalations.length ? "\n" : ""));
await atomicJson(reportPath, {
  schemaVersion: 2, evalSetId: "semantic-eval-consensus-v2", status: escalations.length ? "direct-consensus-frozen-escalations-pending" : "frozen",
  candidates: packets.size, reviewedByBoth: packets.size, directConsensus: direct.length, escalations: escalations.length,
  escalationRoutes: counts(escalations.map((item) => item.route)),
  splitCounts: counts(direct.map((item) => item.split)), bucketCounts: counts(direct.map((item) => item.portfolioBucket)),
  inputs: [{ path: packetsPath, sha256: await sha256File(packetsPath) }, { path: indexPath, sha256: await sha256File(indexPath) }, ...submissions.map((item) => ({ path: item.path, sha256: item.sha256 }))],
  artifacts: [{ path: goldPath, sha256: await sha256File(goldPath) }, { path: escalationPath, sha256: await sha256File(escalationPath) }],
  authority: "Ordinary exact dual-Luna agreement is silver evidence. All disagreements, high-impact cases, and challenge cases require blinded Astra escalation before scoring."
});
console.log(`Froze ${direct.length} ordinary dual-Luna labels; routed ${escalations.length} cases to escalation.`);

function buildRecord(id: string, review: Record<string, any>, mapping: Record<string, any>, packet: Record<string, any>, items: Array<Record<string, any>>, promptSha256: string): Record<string, any> {
  return {
    schemaVersion: 2, id,
    source: { family: mapping.source.family, contentSha256: mapping.sourceSha256, lineageId: `${mapping.source.family}:${mapping.source.lineageId}`, sourceMarkdown: packet.sourceMarkdown,
      provenance: { dataset: mapping.source.dataset, revision: mapping.source.revision, upstreamRecordHash: mapping.source.upstreamRecordHash, license: mapping.source.license, privacyState: "model-screened", ...(mapping.privacy.automaticRedactions.length ? { redactionVersion: "direct-identifiers-v1" } : {}) } },
    split: mapping.split, portfolioBucket: mapping.portfolioBucket, categories: [...review.categories].sort(), risk: review.risk, options: packet.options, label: normalizeLabel(review.label),
    evidence: { authority: "dual-luna-consensus", rubricVersion: "semantic-model-rubric-v2", reviews: items.map((item, index) => ({ reviewerId: item.value.reviewerId, modelIdentity: item.value.modelIdentity, thinking: item.value.thinking, promptSha256, reviewSha256: reviewHash(item.value.reviewerId, index === 0 ? reviews[0].get(id)! : reviews[1].get(id)!) })).sort((a, b) => a.reviewerId.localeCompare(b.reviewerId)), frozenAt: items.map((item) => item.value.completedAt).sort().at(-1) }
  };
}
function disagreementReasons(a: Record<string, any>, b: Record<string, any>): string[] { const reasons: string[] = []; if (a.privacy.decision !== "approved" || b.privacy.decision !== "approved") reasons.push("privacy-not-approved"); if (a.decision !== b.decision) reasons.push("decision-disagreement"); if (a.decision !== "label" || b.decision !== "label") reasons.push("not-both-labeled"); if (canonical([...a.categories].sort()) !== canonical([...b.categories].sort())) reasons.push("category-disagreement"); if (a.risk !== b.risk) reasons.push("risk-disagreement"); if (a.label && b.label && canonical(normalizeLabel(a.label)) !== canonical(normalizeLabel(b.label))) reasons.push("label-disagreement"); return [...new Set(reasons)]; }
function comparable(value: Record<string, any>): unknown { return { categories: [...value.categories].sort(), risk: value.risk, label: normalizeLabel(value.label) }; }
function normalizeLabel(label: Record<string, any>): Record<string, any> { if (label.mode === "exact") return { mode: "exact", acceptableMessageArrays: [...label.acceptableMessageArrays].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), expectedWarningCodes: [...label.expectedWarningCodes].sort() }; const a = label.assertions; return { mode: "semantic", assertions: { requiredText: [...a.requiredText].sort(), forbiddenText: [...a.forbiddenText].sort(), requiredUrls: [...a.requiredUrls].sort(), forbiddenUrls: [...a.forbiddenUrls].sort(), requiredWarningCodes: [...a.requiredWarningCodes].sort(), forbiddenWarningCodes: [...a.forbiddenWarningCodes].sort(), forbidActiveMentions: a.forbidActiveMentions, ...(a.orderedTextGroups ? { orderedTextGroups: [...a.orderedTextGroups].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) } : {}) } }; }
function reviewHash(reviewerId: string, review: Record<string, any>): string { return digest(canonical({ reviewerId, review })); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function counts(values: string[]): Record<string, number> { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return result; }
function repeatedArgument(name: string): string[] { const values: string[] = []; for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[i + 1]); return values; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function keyedDigest(key: string, value: string): string { return createHmac("sha256", key).update(value).digest("hex"); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function loadJsonl<T>(path: string): Promise<T[]> { const rows: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line)); return rows; }
function assertValid(validate: { (value: unknown): boolean; errors?: unknown }, value: unknown, id: string): void { if (!validate(value)) throw new Error(`${id}: ${ajv.errorsText(validate.errors as any, { separator: "; " })}`); }
async function atomicJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, JSON.stringify(value, null, 2) + "\n"); }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
