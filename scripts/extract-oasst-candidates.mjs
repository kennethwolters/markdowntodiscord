import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const sourcePath = "data/raw/oasst1/2023-04-12_oasst_ready.messages.jsonl.gz";
const manifestPath = "data/raw/oasst1/manifest.json";
const indexPath = "data/work/oasst1-candidate-index.json";
const checkpointPath = "data/work/oasst1-candidate-extraction.checkpoint.json";
const outputPath = "data/work/oasst1-candidates.private.jsonl";
const summaryPath = "data/reports/oasst1-candidate-extraction-summary.json";
const chunkSize = positiveInteger(argument("--chunk-size") ?? "5000", "--chunk-size");
const stopAfter = argument("--stop-after") ? positiveInteger(argument("--stop-after"), "--stop-after") : Infinity;
const reset = process.argv.includes("--reset");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await verifyFile(sourcePath, manifest.bytes, manifest.sha256, "source");
const indexBytes = await readFile(indexPath);
const indexSha256 = digest(indexBytes);
const index = JSON.parse(indexBytes.toString("utf8"));
if (index.sourceSha256 !== manifest.sha256) throw new Error("Candidate index and raw source checksums do not match.");

const targets = new Map();
for (const [stratum, items] of Object.entries(index.samples)) {
  for (const item of items) {
    const current = targets.get(item.sourceRow) ?? { ...item, samplingStrata: [] };
    current.samplingStrata.push(stratum);
    targets.set(item.sourceRow, current);
  }
}
for (const target of targets.values()) target.samplingStrata.sort();
const expectedUniqueHashes = new Set([...targets.values()].map((target) => target.textSha256));

await mkdir("data/work", { recursive: true });
await mkdir("data/reports", { recursive: true });
let state = reset ? initialState() : await loadCheckpoint();
const lines = createInterface({ input: createReadStream(sourcePath).pipe(createGunzip()), crlfDelay: Infinity });
let lineNumber = 0;
let processedThisRun = 0;

for await (const line of lines) {
  lineNumber++;
  if (lineNumber <= state.processedRows) continue;
  if (!line.trim()) continue;
  state.processedRows = lineNumber;
  processedThisRun++;

  const target = targets.get(lineNumber);
  if (target) {
    const row = JSON.parse(line);
    if (row.role !== "assistant" || typeof row.text !== "string") throw new Error(`Candidate source row ${lineNumber} is no longer an assistant text row.`);
    const normalized = row.text.replaceAll("\r\n", "\n");
    if (digest(normalized) !== target.textSha256) throw new Error(`Candidate hash mismatch at source row ${lineNumber}.`);
    if (row.message_id !== target.sourceRecordId || row.message_tree_id !== target.lineageId) throw new Error(`Candidate lineage mismatch at source row ${lineNumber}.`);
    const redacted = redactDirectIdentifiers(normalized);
    state.records[target.textSha256] = {
      textSha256: target.textSha256,
      sourceRow: lineNumber,
      sourceRecordId: row.message_id,
      lineageId: row.message_tree_id,
      language: row.lang || "unknown",
      codePoints: Array.from(redacted.text).length,
      features: detectFeaturesFromStrata(target.samplingStrata),
      samplingStrata: target.samplingStrata,
      text: redacted.text,
      automaticRedactions: redacted.kinds,
      sourcePiiLabel: numericPiiLabel(row.labels),
      requiresHumanPiiReview: true
    };
  }

  if (processedThisRun % chunkSize === 0) {
    await saveCheckpoint();
    console.log(`checkpoint rows=${state.processedRows.toLocaleString()} extracted=${Object.keys(state.records).length.toLocaleString()}/${targets.size.toLocaleString()}`);
  }
  if (processedThisRun >= stopAfter) {
    await saveCheckpoint();
    console.log(`Stopped deliberately after ${processedThisRun.toLocaleString()} new rows. Re-run to resume.`);
    process.exit(0);
  }
}

const extractedHashes = new Set(Object.keys(state.records));
const missingHashes = [...expectedUniqueHashes].filter((hash) => !extractedHashes.has(hash));
if (missingHashes.length) throw new Error(`Missing ${missingHashes.length} of ${expectedUniqueHashes.size} unique candidate hashes.`);
state.complete = true;
await saveCheckpoint();
const records = Object.values(state.records).sort((a, b) => a.sourceRow - b.sourceRow);
await atomicWrite(outputPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
const redactionCounts = {};
for (const record of records) for (const kind of record.automaticRedactions) redactionCounts[kind] = (redactionCounts[kind] ?? 0) + 1;
await atomicJson(summaryPath, {
  schemaVersion: 1,
  sourceSha256: manifest.sha256,
  candidateIndexSha256: indexSha256,
  uniqueCandidates: records.length,
  stratumReferences: Object.values(index.samples).reduce((sum, items) => sum + items.length, 0),
  candidatesWithAutomaticRedactions: records.filter((record) => record.automaticRedactions.length).length,
  automaticRedactionCounts: redactionCounts,
  candidatesWithPositiveSourcePiiLabel: records.filter((record) => (record.sourcePiiLabel ?? 0) > 0).length,
  privateOutput: outputPath,
  releaseStatus: "private-review-only",
  privacy: "Text is stored only in gitignored local work data. Direct email, IPv4, and phone-like strings are replaced; every candidate still requires human PII review before promotion."
});
console.log(`Complete: extracted ${records.length} unique private candidates to ${outputPath}`);

function detectFeaturesFromStrata(strata) { return strata.filter((value) => value.startsWith("feature:")).map((value) => value.slice("feature:".length)).sort(); }
function initialState() {
  return { schemaVersion: 1, sourceSha256: manifest.sha256, candidateIndexSha256: indexSha256, processedRows: 0, records: {}, complete: false };
}
async function loadCheckpoint() {
  try {
    const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (saved.sourceSha256 !== manifest.sha256 || saved.candidateIndexSha256 !== indexSha256) throw new Error("Extraction checkpoint input differs; verify inputs and use --reset.");
    console.log(saved.complete ? "Existing complete checkpoint found; verifying EOF." : `Resuming after source row ${saved.processedRows.toLocaleString()}`);
    return saved;
  } catch (error) {
    if (error?.code === "ENOENT") return initialState();
    throw error;
  }
}
function redactDirectIdentifiers(text) {
  const kinds = [];
  let output = text;
  output = replace(output, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]", "email", kinds);
  output = replace(output, /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, "[REDACTED_IPV4]", "ipv4", kinds);
  output = replace(output, /(?<![\w])(?:\+?\d[\d .()-]{8,}\d)(?![\w])/g, "[REDACTED_PHONE]", "phone-like", kinds);
  return { text: output, kinds: [...new Set(kinds)].sort() };
}
function replace(value, pattern, replacement, kind, kinds) {
  if (!pattern.test(value)) return value;
  kinds.push(kind);
  pattern.lastIndex = 0;
  return value.replace(pattern, replacement);
}
function numericPiiLabel(labels) {
  const value = labels?.pii?.value;
  return typeof value === "number" ? value : null;
}
async function verifyFile(path, expectedBytes, expectedSha256, label) {
  if ((await stat(path)).size !== expectedBytes) throw new Error(`${label} size mismatch`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== expectedSha256) throw new Error(`${label} checksum mismatch: ${actual}`);
  console.log(`Verified ${label} ${actual}`);
}
async function saveCheckpoint() { await atomicJson(checkpointPath, state); }
async function atomicJson(path, value) { await atomicWrite(path, JSON.stringify(value, null, 2) + "\n"); }
async function atomicWrite(path, value) { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function argument(name) { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1]; }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`); return parsed; }
