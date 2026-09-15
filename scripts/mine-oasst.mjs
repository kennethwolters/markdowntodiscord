import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { detectMarkdownFeatures } from "./lib/markdown-features.mjs";

const sourcePath = "data/raw/oasst1/2023-04-12_oasst_ready.messages.jsonl.gz";
const manifestPath = "data/raw/oasst1/manifest.json";
const checkpointPath = "data/work/oasst1-feature-scan.checkpoint.json";
const reportPath = "data/reports/oasst1-feature-report.json";
const checkpointEvery = positiveInteger(argument("--chunk-size") ?? "5000", "--chunk-size");
const stopAfter = argument("--stop-after") ? positiveInteger(argument("--stop-after"), "--stop-after") : Infinity;
const reset = process.argv.includes("--reset");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await verifySource(manifest);
await mkdir("data/work", { recursive: true });
await mkdir("data/reports", { recursive: true });

let state = reset ? initialState(manifest.sha256) : await loadCheckpoint(manifest.sha256);
const input = createReadStream(sourcePath).pipe(createGunzip());
const lines = createInterface({ input, crlfDelay: Infinity });
let lineNumber = 0;
let processedThisRun = 0;

for await (const line of lines) {
  lineNumber++;
  if (lineNumber <= state.processedRows) continue;
  if (!line.trim()) continue;

  let row;
  try { row = JSON.parse(line); }
  catch (error) { throw new Error(`Invalid JSON at source line ${lineNumber}: ${error.message}`); }

  state.processedRows = lineNumber;
  processedThisRun++;
  if (row.role === "assistant" && typeof row.text === "string") analyzeAssistant(row, state);

  if (processedThisRun % checkpointEvery === 0) {
    await saveCheckpoint(state);
    console.log(`checkpoint rows=${state.processedRows.toLocaleString()} assistant=${state.assistantRows.toLocaleString()}`);
  }
  if (processedThisRun >= stopAfter) {
    await saveCheckpoint(state);
    console.log(`Stopped deliberately after ${processedThisRun.toLocaleString()} new rows. Re-run to resume.`);
    process.exit(0);
  }
}

state.complete = true;
await saveCheckpoint(state);
const report = {
  schemaVersion: 1,
  dataset: manifest.dataset,
  release: manifest.release,
  sourceSha256: manifest.sha256,
  processedRows: state.processedRows,
  assistantRows: state.assistantRows,
  featureCounts: sortedObject(state.featureCounts),
  lengthBuckets: state.lengthBuckets,
  languageCounts: sortedObject(state.languageCounts),
  generatedFromCheckpoint: checkpointPath,
  privacy: "Aggregate counts only; no conversation text or user identifiers retained.",
  featureDetection: "Lexical prevalence heuristics, not parser-validity labels. Fence balance is a stateful delimiter heuristic and remains a candidate signal."
};
await atomicJson(reportPath, report);
console.log(`Complete: wrote ${reportPath}`);

function analyzeAssistant(row, target) {
  const text = row.text;
  target.assistantRows++;
  target.languageCounts[row.lang || "unknown"] = (target.languageCounts[row.lang || "unknown"] ?? 0) + 1;
  const length = Array.from(text).length;
  const bucket = length <= 100 ? "0-100" : length <= 500 ? "101-500" : length <= 2000 ? "501-2000" : "2001+";
  target.lengthBuckets[bucket]++;

  for (const feature of detectMarkdownFeatures(text)) {
    target.featureCounts[feature] = (target.featureCounts[feature] ?? 0) + 1;
  }
}

function initialState(sourceSha256) {
  return {
    schemaVersion: 1,
    sourceSha256,
    processedRows: 0,
    assistantRows: 0,
    featureCounts: {},
    languageCounts: {},
    lengthBuckets: { "0-100": 0, "101-500": 0, "501-2000": 0, "2001+": 0 },
    complete: false
  };
}

async function loadCheckpoint(sourceSha256) {
  try {
    const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (saved.sourceSha256 !== sourceSha256) throw new Error("Checkpoint source checksum differs from the input manifest; use --reset after verifying the new source.");
    if (saved.complete) console.log("Existing complete checkpoint found; scan will verify EOF without duplicating counts.");
    else console.log(`Resuming after source row ${saved.processedRows.toLocaleString()}`);
    return saved;
  } catch (error) {
    if (error?.code === "ENOENT") return initialState(sourceSha256);
    throw error;
  }
}

async function verifySource(sourceManifest) {
  const sourceStat = await stat(sourcePath);
  if (sourceStat.size !== sourceManifest.bytes) {
    throw new Error(`Source size mismatch: ${sourceStat.size} bytes, manifest requires ${sourceManifest.bytes}`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(sourcePath)) hash.update(chunk);
  const digest = hash.digest("hex");
  if (digest !== sourceManifest.sha256) {
    throw new Error(`Source checksum mismatch: ${digest}; manifest requires ${sourceManifest.sha256}`);
  }
  console.log(`Verified source ${digest}`);
}

async function saveCheckpoint(value) { await atomicJson(checkpointPath, value); }
async function atomicJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, path);
}
function sortedObject(value) { return Object.fromEntries(Object.entries(value).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))); }
function argument(name) { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1]; }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`); return parsed; }
