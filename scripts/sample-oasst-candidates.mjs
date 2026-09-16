import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { detectMarkdownFeatures } from "./lib/markdown-features.mjs";

const sourcePath = "data/raw/oasst1/2023-04-12_oasst_ready.messages.jsonl.gz";
const manifestPath = "data/raw/oasst1/manifest.json";
const checkpointPath = "data/work/oasst1-candidate-sample.checkpoint.json";
const indexPath = "data/work/oasst1-candidate-index.json";
const summaryPath = "data/reports/oasst1-candidate-sample-summary.json";
const chunkSize = positiveInteger(argument("--chunk-size") ?? "5000", "--chunk-size");
const perFeature = positiveInteger(argument("--per-feature") ?? "40", "--per-feature");
const representativeCount = positiveInteger(argument("--representative") ?? "200", "--representative");
const stopAfter = argument("--stop-after") ? positiveInteger(argument("--stop-after"), "--stop-after") : Infinity;
const reset = process.argv.includes("--reset");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await verifySource(manifest);
await mkdir("data/work", { recursive: true });
await mkdir("data/reports", { recursive: true });
let state = reset ? initialState(manifest.sha256) : await loadCheckpoint(manifest.sha256);
if (state.perFeature !== perFeature) throw new Error(`Checkpoint uses --per-feature ${state.perFeature}; resume with that value or use --reset.`);

const lines = createInterface({ input: createReadStream(sourcePath).pipe(createGunzip()), crlfDelay: Infinity });
let lineNumber = 0;
let processedThisRun = 0;
for await (const line of lines) {
  lineNumber++;
  if (lineNumber <= state.processedRows) continue;
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  state.processedRows = lineNumber;
  processedThisRun++;

  if (row.role === "assistant" && typeof row.text === "string") {
    state.assistantRows++;
    const normalized = row.text.replaceAll("\r\n", "\n");
    const textSha256 = digest(normalized);
    const features = detectMarkdownFeatures(normalized);
    const codePoints = Array.from(normalized).length;
    const item = {
      sourceRow: lineNumber,
      sourceRecordId: row.message_id,
      lineageId: row.message_tree_id,
      textSha256,
      language: row.lang || "unknown",
      codePoints
    };
    retainBottomK(state.samples, "representative", { ...item, priority: digest(`${manifest.sha256}\0representative\0${textSha256}`) }, representativeCount);
    for (const feature of features) retainBottomK(state.samples, `feature:${feature}`, { ...item, priority: digest(`${manifest.sha256}\0feature:${feature}\0${textSha256}`) }, perFeature);
    if (codePoints > 2_000) retainBottomK(state.samples, "length:over-2000", { ...item, priority: digest(`${manifest.sha256}\0length:over-2000\0${textSha256}`) }, perFeature);
    if (codePoints > 4_000) retainBottomK(state.samples, "length:over-4000", { ...item, priority: digest(`${manifest.sha256}\0length:over-4000\0${textSha256}`) }, perFeature);
    if (features.length >= 2) retainBottomK(state.samples, "interaction:two-plus", { ...item, priority: digest(`${manifest.sha256}\0interaction:two-plus\0${textSha256}`) }, perFeature * 2);
  }

  if (processedThisRun % chunkSize === 0) {
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
const samples = Object.fromEntries(Object.entries(state.samples).sort(([a], [b]) => a.localeCompare(b)).map(([feature, items]) => [feature, items.map(({ priority, ...item }) => item)]));
await atomicJson(indexPath, {
  schemaVersion: 1,
  sourceSha256: manifest.sha256,
  sampling: "Deterministic bottom-k SHA-256 priority per lexical feature; normalized CRLF; deduplicated by text hash within feature.",
  perFeature,
  representativeCount,
  samples
});
await atomicJson(summaryPath, {
  schemaVersion: 1,
  dataset: manifest.dataset,
  sourceSha256: manifest.sha256,
  processedRows: state.processedRows,
  assistantRows: state.assistantRows,
  perFeature,
  representativeCount,
  selectedByStratum: Object.fromEntries(Object.entries(samples).map(([stratum, items]) => [stratum, items.length])),
  privateIndex: indexPath,
  privacy: "Public summary contains counts only. The gitignored private index contains hashes, source row numbers, and upstream provenance identifiers, but no message text. Treat all provenance identifiers as sensitive local metadata."
});
console.log(`Complete: selected ${Object.values(samples).reduce((sum, items) => sum + items.length, 0)} feature-stratified references`);

function retainBottomK(samples, feature, item, limit) {
  const items = samples[feature] ?? (samples[feature] = []);
  if (items.some((existing) => existing.textSha256 === item.textSha256)) return;
  items.push(item);
  items.sort((a, b) => a.priority.localeCompare(b.priority));
  if (items.length > limit) items.length = limit;
}
function initialState(sourceSha256) {
  return { schemaVersion: 2, sourceSha256, perFeature, representativeCount, processedRows: 0, assistantRows: 0, samples: {}, complete: false };
}
async function loadCheckpoint(sourceSha256) {
  try {
    const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (saved.sourceSha256 !== sourceSha256 || saved.perFeature !== perFeature || saved.representativeCount !== representativeCount) throw new Error("Checkpoint sampling policy differs; verify inputs and use --reset.");
    console.log(saved.complete ? "Existing complete checkpoint found; verifying EOF." : `Resuming after source row ${saved.processedRows.toLocaleString()}`);
    return saved;
  } catch (error) {
    if (error?.code === "ENOENT") return initialState(sourceSha256);
    throw error;
  }
}
async function verifySource(sourceManifest) {
  const sourceStat = await stat(sourcePath);
  if (sourceStat.size !== sourceManifest.bytes) throw new Error(`Source size mismatch: ${sourceStat.size} != ${sourceManifest.bytes}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(sourcePath)) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== sourceManifest.sha256) throw new Error(`Source checksum mismatch: ${actual} != ${sourceManifest.sha256}`);
  console.log(`Verified source ${actual}`);
}
async function saveCheckpoint(value) { await atomicJson(checkpointPath, value); }
async function atomicJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, path);
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function argument(name) { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1]; }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`); return parsed; }
