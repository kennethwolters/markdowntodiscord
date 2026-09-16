import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const candidateManifestPath = "data/work/semantic-eval-candidates-v2/manifest.private.json";
const finalReportPath = "data/work/semantic-eval-consensus-v2/final-report.private.json";
const labelsPath = "data/work/semantic-eval-consensus-v2/labels.final.private.jsonl";
const validationPath = "data/work/semantic-eval-consensus-v2/validation-score.private.json";
const challengePath = "data/work/semantic-eval-consensus-v2/challenge-score.private.json";
const indexPath = "data/work/semantic-eval-candidates-v2/index.private.json";
const quarantinePath = "data/work/semantic-eval-consensus-v2/quarantine.private.jsonl";
const outputPath = "data/reports/semantic-eval-v2.json";
const [candidate, final, validation, challenge, index] = await Promise.all([candidateManifestPath, finalReportPath, validationPath, challengePath, indexPath].map(readJson));
const quarantinedIds = new Set((await readJsonl(quarantinePath)).map((item) => item.candidateId));
const quarantinedMappings = index.mappings.filter((item: Record<string, any>) => quarantinedIds.has(item.candidateId));
const report = {
  schemaVersion: 1,
  evalSetId: "semantic-eval-consensus-v2",
  status: "initial-silver-baseline",
  candidates: {
    total: candidate.records,
    sources: candidate.sourceCounts,
    portfolio: candidate.bucketCounts,
    splits: candidate.splitCounts,
    highImpact: candidate.highImpact,
    interactions: candidate.interactions,
    over2000CodePoints: candidate.over2000CodePoints
  },
  curation: {
    dualLunaDirectConsensus: final.directConsensus,
    astraAdjudicatedOrAuthored: final.adjudicated,
    quarantined: final.quarantined,
    finalSilverLabels: final.finalLabels,
    quarantineSlices: {
      bySplit: counts(quarantinedMappings, (item) => item.split),
      bySource: counts(quarantinedMappings, (item) => item.source.family),
      byBucket: counts(quarantinedMappings, (item) => item.portfolioBucket)
    }
  },
  validation: publicScore(validation),
  challenge: publicScore(challenge),
  artifacts: {
    candidateManifestSha256: await sha256File(candidateManifestPath),
    labelsSha256: await sha256File(labelsPath),
    quarantineSha256: await sha256File(quarantinePath),
    curationReportSha256: await sha256File(finalReportPath),
    validationScoreSha256: await sha256File(validationPath),
    challengeScoreSha256: await sha256File(challengePath)
  },
  interpretation: "Unweighted stratified diagnostic pass rates among retained labels. Quarantines are reported separately and excluded from pass-rate denominators; these rates are not population estimates.",
  authority: "Model-generated semantic silver evidence. This report is not human, specification, policy, or observed-Discord gold; private source text, case IDs, labels, and challenge membership are omitted."
};
await mkdir("data/reports", { recursive: true });
await atomicWrite(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(`Wrote aggregate semantic evaluation report to ${outputPath}`);

function publicScore(value: Record<string, any>): Record<string, any> { return { total: value.total, passed: value.passed, failed: value.failed, passRate: value.passRate, wilson95: value.wilson95, byBucket: value.byBucket, bySource: value.bySource, byRisk: value.byRisk, failureCounts: value.failureCounts }; }
async function readJson(path: string): Promise<any> { return JSON.parse(await readFile(path, "utf8")); }
async function readJsonl(path: string): Promise<any[]> { return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
function counts(items: Record<string, any>[], key: (item: Record<string, any>) => string): Record<string, number> { const result: Record<string, number> = {}; for (const item of items) { const value = key(item); result[value] = (result[value] ?? 0) + 1; } return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
