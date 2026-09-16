import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaPaths = [
  "data/schema/loop-run.schema.json",
  "data/schema/loop-case.schema.json",
  "data/schema/loop-judgment.schema.json",
  "data/schema/loop-adjudication.schema.json",
  "data/schema/loop-attempt.schema.json",
  "data/schema/loop-report.schema.json",
  "data/schema/loop-packet.schema.json",
  "data/schema/loop-pilot-manifest.schema.json",
  "data/schema/loop-calibration-key.schema.json",
  "data/schema/loop-calibration-manifest.schema.json",
  "data/schema/loop-critic-output.schema.json",
  "data/schema/loop-calibration-report.schema.json",
  "data/schema/loop-adjudicator-output.schema.json"
];
const manifestPath = "data/loop/baseline-v1/manifest.json";
const casesPath = "data/loop/baseline-v1/cases.jsonl";

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();
for (const path of schemaPaths) {
  const schema = JSON.parse(await readFile(path, "utf8"));
  if (!ajv.validateSchema(schema)) throw new Error(`Invalid JSON Schema ${path}: ${ajv.errorsText(ajv.errors)}`);
  validators.set(path, ajv.compile(schema));
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
validate(validators.get(schemaPaths[0])!, manifest, manifestPath);
const requiredSourcePaths = [
  "data/fixtures/discord-policy-v1.jsonl",
  "data/spec/commonmark-0.31.2.jsonl",
  "data/mutations/commonmark-mutants-v1.jsonl"
];
const requiredArtifactPaths = ["data/loop/baseline-v1/cases.jsonl", "data/loop/baseline-v1/report.json"];
assertEqual(JSON.stringify(manifest.sources.map((item: { path: string }) => item.path).sort()), JSON.stringify([...requiredSourcePaths].sort()), "manifest source membership");
assertEqual(JSON.stringify(manifest.artifacts.map((item: { path: string }) => item.path).sort()), JSON.stringify([...requiredArtifactPaths].sort()), "manifest artifact membership");
for (const source of manifest.sources) {
  assertEqual(await sha256File(source.path), source.sha256, `${source.path} SHA-256`);
  assertEqual(await countRecords(source.path), source.records, `${source.path} record count`);
}
const converterIdentity = createHash("sha256")
  .update(await readFile("src/convert.ts"))
  .update("\0")
  .update(await readFile("package-lock.json"))
  .digest("hex");
assertEqual(converterIdentity, manifest.converterIdentity.sourceSha256, "converter identity");
assertEqual(await sha256File("data/fixtures/discord-policy-v1.jsonl"), manifest.converterIdentity.policyFixtureSha256, "policy fixture identity");
for (const artifact of manifest.artifacts) assertEqual(await sha256File(artifact.path), artifact.sha256, `${artifact.path} artifact SHA-256`);

const sourceRecords = await loadSourceRecords();
let records = 0;
const cases: Array<Record<string, any>> = [];
const lineageSplits = new Map<string, string>();
const lines = createInterface({ input: createReadStream(casesPath), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  records++;
  const record = JSON.parse(line);
  cases.push(record);
  validate(validators.get(schemaPaths[1])!, record, `${casesPath}:${records}`);
  const source = sourceRecords.get(record.id);
  if (!source) throw new Error(`${record.id} does not resolve to a source record`);
  assertEqual(record.source.kind, source.kind, `${record.id} source kind`);
  assertEqual(record.source.path, source.path, `${record.id} source path`);
  assertEqual(record.source.recordId, source.recordId, `${record.id} source record ID`);
  assertEqual(record.source.lineageId, source.lineageId, `${record.id} lineage`);
  assertEqual(record.source.contentSha256, digest(source.content), `${record.id} content SHA-256`);
  const expectedSplit = splitFor(record.source.lineageId);
  assertEqual(record.split, expectedSplit, `${record.id} deterministic split`);
  const existing = lineageSplits.get(record.source.lineageId);
  if (existing && existing !== record.split) throw new Error(`${record.source.lineageId} crosses ${existing} and ${record.split}`);
  lineageSplits.set(record.source.lineageId, record.split);
}
if (records === 0) throw new Error(`${casesPath} contains no records`);
const reportPath = "data/loop/baseline-v1/report.json";
const report = JSON.parse(await readFile(reportPath, "utf8"));
validate(validators.get(schemaPaths[5])!, report, reportPath);
assertEqual(manifest.runId, report.runId, "manifest/report run ID");
assertEqual(JSON.stringify(report), JSON.stringify(expectedReport(cases)), "recomputed baseline report");
for (const calibrationReportPath of ["data/reports/critic-calibration-v1.json", "data/reports/critic-calibration-v2.json"]) {
  const calibrationReport = JSON.parse(await readFile(calibrationReportPath, "utf8"));
  validate(validators.get(schemaPaths[11])!, calibrationReport, calibrationReportPath);
  assertEqual(calibrationReport.controls.positive + calibrationReport.controls.negative, calibrationReport.controls.total, `${calibrationReport.calibrationId} control total`);
  for (const critic of calibrationReport.critics) {
    assertEqual(critic.correct + critic.incorrect + critic.abstained, calibrationReport.controls.total, `${calibrationReport.calibrationId}/${critic.criticId} decision total`);
    assertClose(critic.accuracy, critic.correct / calibrationReport.controls.total, `${calibrationReport.calibrationId}/${critic.criticId} accuracy`);
  }
  assertClose(calibrationReport.pairwiseVerdictAgreement.rate, calibrationReport.pairwiseVerdictAgreement.agreements / calibrationReport.pairwiseVerdictAgreement.total, `${calibrationReport.calibrationId} pairwise agreement rate`);
}
console.log(`Validated ${schemaPaths.length} loop schemas, bound manifest hashes, recomputed reports, and ${records} baseline cases.`);

function expectedReport(cases: Array<Record<string, any>>): Record<string, unknown> {
  const goldCases = cases.filter((item) => item.gold);
  const goldPassed = goldCases.filter((item) => item.gold.exactMessagesMatch && item.gold.warningCodesMatch).length;
  const failedCases = cases.filter((item) =>
    !item.conversion.deterministic ||
    !item.invariants.noCrash ||
    !item.invariants.withinCapacity ||
    !item.invariants.balancedFences ||
    !item.invariants.mentionPolicyConformant
  );
  const splitCounts = { train: 0, validation: 0, "public-test": 0 };
  const kindCounts: Record<string, number> = {};
  const warningCounts: Record<string, number> = {};
  for (const item of cases) {
    splitCounts[item.split as keyof typeof splitCounts]++;
    kindCounts[item.source.kind] = (kindCounts[item.source.kind] ?? 0) + 1;
    for (const warning of item.conversion.warningCodes) warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    runId: "public-baseline-v1",
    cases: cases.length,
    splitCounts,
    kindCounts: sortedRecord(kindCounts),
    gold: { total: goldCases.length, passed: goldPassed, failed: goldCases.length - goldPassed },
    invariants: {
      failedCases: failedCases.length,
      deterministic: cases.filter((item) => item.conversion.deterministic).length,
      withinCapacity: cases.filter((item) => item.invariants.withinCapacity).length,
      balancedFences: cases.filter((item) => item.invariants.balancedFences).length,
      activeMentionsAbsent: cases.filter((item) => item.invariants.activeMentionsAbsent).length,
      mentionPolicyConformant: cases.filter((item) => item.invariants.mentionPolicyConformant).length
    },
    warningCounts: sortedRecord(warningCounts),
    failures: failedCases.map((item) => item.id),
    interpretation: "Gold metrics apply only to policy fixtures. Other cases measure deterministic invariants and are not semantic correctness labels."
  };
}
function sortedRecord(value: Record<string, number>): Record<string, number> { return Object.fromEntries(Object.entries(value).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))); }

async function loadSourceRecords(): Promise<Map<string, { kind: string; path: string; recordId: string; lineageId: string; content: string }>> {
  const records = new Map<string, { kind: string; path: string; recordId: string; lineageId: string; content: string }>();
  for (const row of await loadJsonl("data/fixtures/discord-policy-v1.jsonl")) add("policy", "data/fixtures/discord-policy-v1.jsonl", row, "sourceMarkdown", "id");
  for (const row of await loadJsonl("data/spec/commonmark-0.31.2.jsonl")) add("commonmark", "data/spec/commonmark-0.31.2.jsonl", row, "source_markdown", "id");
  for (const row of await loadJsonl("data/mutations/commonmark-mutants-v1.jsonl")) add("mutant", "data/mutations/commonmark-mutants-v1.jsonl", row, "sourceMarkdown", "parentId");
  return records;

  function add(kind: string, path: string, row: Record<string, unknown>, contentKey: string, lineageKey: string): void {
    const recordId = String(row.id);
    const id = `${kind}:${recordId}`;
    if (records.has(id)) throw new Error(`Duplicate source identity ${id}`);
    records.set(id, { kind, path, recordId, lineageId: String(row[lineageKey]), content: String(row[contentKey]) });
  }
}
function splitFor(lineageId: string): "train" | "validation" | "public-test" {
  const hash = createHash("sha256").update(`split-v1\0${lineageId}`).digest("hex");
  const bucket = Number.parseInt(hash.slice(0, 8), 16) % 100;
  if (bucket < 70) return "train";
  if (bucket < 90) return "validation";
  return "public-test";
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function loadJsonl(path: string): Promise<Record<string, unknown>[]> { const records: Record<string, unknown>[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) records.push(JSON.parse(line)); return records; }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function countRecords(path: string): Promise<number> { let count = 0; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) count++; return count; }
function assertEqual(actual: unknown, expected: unknown, identity: string): void { if (actual !== expected) throw new Error(`${identity}: expected ${expected}, received ${actual}`); }
function assertClose(actual: number, expected: number, identity: string): void { if (Math.abs(actual - expected) > Number.EPSILON * 8) throw new Error(`${identity}: expected ${expected}, received ${actual}`); }

function validate(validator: ValidateFunction, value: unknown, identity: string): void {
  if (!validator(value)) throw new Error(`${identity}: ${ajv.errorsText(validator.errors, { separator: "; " })}`);
}
