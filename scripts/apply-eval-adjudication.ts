import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const candidateDirectory = "data/work/semantic-eval-candidates-v2";
const consensusDirectory = "data/work/semantic-eval-consensus-v2";
const adjudicationPaths = repeatedArgument("--adjudication");
const reviewPaths = repeatedArgument("--review");
if (!adjudicationPaths.length || reviewPaths.length !== 2) throw new Error("Pass adjudication shards and exactly two complete reviews");
const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
const reviewSchema = JSON.parse(await readFile("data/schema/eval-review.schema.json", "utf8")); ajv.addSchema(reviewSchema);
const validateDecision = ajv.compile(JSON.parse(await readFile("data/schema/eval-adjudication.schema.json", "utf8")));
const validateGold = ajv.compile(JSON.parse(await readFile("data/schema/eval-consensus.schema.json", "utf8")));
const validateReview = ajv.getSchema(reviewSchema.$id)!;
const submissions = await Promise.all(reviewPaths.map(async (path) => ({ path, value: JSON.parse(await readFile(path, "utf8")), sha256: await sha256File(path) })));
for (const item of submissions) if (!validateReview(item.value)) throw new Error(`${item.path}: ${ajv.errorsText(validateReview.errors, { separator: "; " })}`);
const decisions = new Map<string, { value: Record<string, any>; submission: Record<string, any> }>();
const manifestSha256 = await sha256File(`${candidateDirectory}/manifest.private.json`);
const labelerPromptSha256 = await sha256File("data/loop/semantic-labeler-prompt-v2.md");
const promptSha256 = await sha256File("data/loop/semantic-adjudicator-prompt-v3.md");
const policySha256 = await sha256File("data/loop/converter-policy-v2.md");
for (const item of submissions) {
  if (item.value.candidateManifestSha256 !== manifestSha256 || item.value.promptSha256 !== labelerPromptSha256 || item.value.policySha256 !== policySha256) throw new Error(`${item.path} has stale review bindings`);
}
for (const path of adjudicationPaths) {
  const submission = JSON.parse(await readFile(path, "utf8"));
  if (!validateDecision(submission)) throw new Error(`${path}: ${ajv.errorsText(validateDecision.errors, { separator: "; " })}`);
  if (submission.candidateManifestSha256 !== manifestSha256 || submission.promptSha256 !== promptSha256 || submission.policySha256 !== policySha256) throw new Error(`${path} has stale bindings`);
  for (const value of submission.decisions) { if (decisions.has(value.candidateId)) throw new Error(`Duplicate decision ${value.candidateId}`); decisions.set(value.candidateId, { value, submission }); }
}
const freezeReport = JSON.parse(await readFile(`${consensusDirectory}/report.private.json`, "utf8"));
for (const item of [...freezeReport.inputs, ...freezeReport.artifacts]) if (await sha256File(item.path) !== item.sha256) throw new Error(`${item.path} differs from freeze report`);
for (const item of submissions) if (!freezeReport.inputs.some((input: Record<string, any>) => input.path === item.path && input.sha256 === item.sha256)) throw new Error(`${item.path} is not bound by the freeze report`);
const escalations = await loadJsonl<Record<string, any>>(`${consensusDirectory}/escalations.private.jsonl`);
if (decisions.size !== escalations.length || escalations.some((item) => !decisions.has(item.candidateId))) throw new Error(`Decisions cover ${decisions.size}/${escalations.length} escalations`);
const packetRows = await loadJsonl<Record<string, any>>(`${candidateDirectory}/packets.private.jsonl`);
const packets = new Map(packetRows.map((item) => [item.candidateId, item]));
const index = JSON.parse(await readFile(`${candidateDirectory}/index.private.json`, "utf8"));
const mappings = new Map<string, Record<string, any>>(index.mappings.map((item: Record<string, any>) => [item.candidateId, item]));
const byReview = submissions.map((submission) => {
  const result = new Map<string, Record<string, any>>();
  for (const review of submission.value.reviews) {
    if (result.has(review.candidateId) || !packets.has(review.candidateId)) throw new Error(`${submission.path} has duplicate or unknown ${review.candidateId}`);
    if (packets.get(review.candidateId)!.sourceToken !== review.sourceToken) throw new Error(`${submission.path} source token mismatch for ${review.candidateId}`);
    result.set(review.candidateId, review);
  }
  if (result.size !== packets.size || [...packets.keys()].some((id) => !result.has(id))) throw new Error(`${submission.path} covers ${result.size}/${packets.size} candidates`);
  return result;
});
const direct = await loadJsonl<Record<string, any>>(`${consensusDirectory}/labels.private.jsonl`);
if (direct.length !== freezeReport.directConsensus) throw new Error(`Direct consensus count differs from freeze report`);
for (const record of direct) if (!validateGold(record)) throw new Error(`${record.id}: ${ajv.errorsText(validateGold.errors, { separator: "; " })}`);
const promoted: Record<string, any>[] = [];
const quarantined: Record<string, any>[] = [];
for (const escalation of escalations) {
  const { value: decision, submission } = decisions.get(escalation.candidateId)!;
  const left = byReview[0].get(escalation.candidateId)!; const right = byReview[1].get(escalation.candidateId)!;
  const leftHash = reviewHash(submissions[0].value.reviewerId, left); const rightHash = reviewHash(submissions[1].value.reviewerId, right);
  if (escalation.sourceToken !== packets.get(escalation.candidateId)?.sourceToken || JSON.stringify(escalation.reviewHashes) !== JSON.stringify([leftHash, rightHash])) throw new Error(`${escalation.candidateId} differs from frozen escalation evidence`);
  const swap = digest(`semantic-adjudication-order-v2\0${escalation.candidateId}`).charCodeAt(0) % 2 === 1;
  const slots = swap ? { "select-a": { review: right, hash: rightHash }, "select-b": { review: left, hash: leftHash } } : { "select-a": { review: left, hash: leftHash }, "select-b": { review: right, hash: rightHash } };
  const expectedHashes = swap ? [rightHash, leftHash] : [leftHash, rightHash];
  if (JSON.stringify(decision.reviewHashes) !== JSON.stringify(expectedHashes)) throw new Error(`${decision.candidateId} displayed review hashes differ`);
  if (decision.decision === "quarantine") { quarantined.push({ schemaVersion: 2, candidateId: decision.candidateId, reasons: escalation.reasons, rationale: decision.rationale, adjudicationSha256: digest(canonical(decision)) }); continue; }
  if (left.privacy.decision !== "approved" || right.privacy.decision !== "approved") throw new Error(`${decision.candidateId} must remain quarantined because privacy was not approved by both reviewers`);
  const authored = decision.decision === "author";
  const chosen = authored
    ? { decision: "label", privacy: { decision: "approved" }, categories: decision.categories, risk: decision.risk, label: decision.label }
    : slots[decision.decision as "select-a" | "select-b"].review;
  if (chosen.decision !== "label" || chosen.privacy.decision !== "approved") throw new Error(`${decision.candidateId} selected an ineligible review`);
  const mapping = mappings.get(decision.candidateId)!; const packet = packets.get(decision.candidateId)!;
  const record = {
    schemaVersion: 2, id: decision.candidateId,
    source: { family: mapping.source.family, contentSha256: mapping.sourceSha256, lineageId: `${mapping.source.family}:${mapping.source.lineageId}`, sourceMarkdown: packet.sourceMarkdown, provenance: { dataset: mapping.source.dataset, revision: mapping.source.revision, upstreamRecordHash: mapping.source.upstreamRecordHash, license: mapping.source.license, privacyState: "model-screened", ...(mapping.privacy.automaticRedactions.length ? { redactionVersion: "direct-identifiers-v1" } : {}) } },
    split: mapping.split, portfolioBucket: mapping.portfolioBucket, categories: [...chosen.categories].sort(), risk: chosen.risk, options: packet.options, label: normalizeLabel(chosen.label),
    evidence: { authority: authored ? "astra-authored-silver" : "astra-adjudicated-model-consensus", rubricVersion: "semantic-model-rubric-v2", reviews: [
      { reviewerId: submissions[0].value.reviewerId, modelIdentity: submissions[0].value.modelIdentity, thinking: submissions[0].value.thinking, promptSha256: submissions[0].value.promptSha256, reviewSha256: leftHash },
      { reviewerId: submissions[1].value.reviewerId, modelIdentity: submissions[1].value.modelIdentity, thinking: submissions[1].value.thinking, promptSha256: submissions[1].value.promptSha256, reviewSha256: rightHash },
      { reviewerId: submission.adjudicationId, modelIdentity: submission.modelIdentity, thinking: submission.thinking, promptSha256: submission.promptSha256, reviewSha256: digest(canonical(decision)) }
    ], adjudicationSha256: digest(canonical(decision)), frozenAt: submission.completedAt }
  };
  if (!validateGold(record)) throw new Error(`${record.id}: ${ajv.errorsText(validateGold.errors, { separator: "; " })}`);
  promoted.push(record);
}
const final = [...direct, ...promoted].sort((a, b) => a.id.localeCompare(b.id));
if (new Set(final.map((item) => item.id)).size !== final.length) throw new Error("Duplicate final case IDs");
await mkdir(consensusDirectory, { recursive: true });
await atomicWrite(`${consensusDirectory}/labels.final.private.jsonl`, final.map((item) => JSON.stringify(item)).join("\n") + (final.length ? "\n" : ""));
await atomicWrite(`${consensusDirectory}/quarantine.private.jsonl`, quarantined.map((item) => JSON.stringify(item)).join("\n") + (quarantined.length ? "\n" : ""));
await atomicWrite(`${consensusDirectory}/final-report.private.json`, JSON.stringify({ schemaVersion: 2, evalSetId: "semantic-eval-consensus-v2", candidates: packets.size, directConsensus: direct.length, adjudicated: promoted.length, quarantined: quarantined.length, finalLabels: final.length, authority: "Model-generated silver evidence only; not specification, observed Discord, or human gold." }, null, 2) + "\n");
console.log(`Finalized ${final.length} silver labels (${direct.length} direct, ${promoted.length} adjudicated); quarantined ${quarantined.length}.`);

function normalizeLabel(label: Record<string, any>): Record<string, any> { if (label.mode === "exact") return { mode: "exact", acceptableMessageArrays: [...label.acceptableMessageArrays].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), expectedWarningCodes: [...label.expectedWarningCodes].sort() }; const a = label.assertions; return { mode: "semantic", assertions: { requiredText: [...a.requiredText].sort(), forbiddenText: [...a.forbiddenText].sort(), requiredUrls: [...a.requiredUrls].sort(), forbiddenUrls: [...a.forbiddenUrls].sort(), requiredWarningCodes: [...a.requiredWarningCodes].sort(), forbiddenWarningCodes: [...a.forbiddenWarningCodes].sort(), forbidActiveMentions: a.forbidActiveMentions, ...(a.orderedTextGroups ? { orderedTextGroups: [...a.orderedTextGroups].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) } : {}) } }; }
function reviewHash(reviewerId: string, review: Record<string, any>): string { return digest(canonical({ reviewerId, review })); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function repeatedArgument(name: string): string[] { const result: string[] = []; for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === name && process.argv[i + 1]) result.push(process.argv[i + 1]); return result; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function loadJsonl<T>(path: string): Promise<T[]> { const result: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) result.push(JSON.parse(line)); return result; }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
