import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const manifestPath = "data/manifests/wildchat-1m-7d6490e.json";
const manifest = (await import(`../${manifestPath}`, { with: { type: "json" } })).default;
const maxShards = argument("--max-shards") ? positiveInteger(argument("--max-shards"), "--max-shards") : manifest.files.length;
const outputRoot = "data/raw/wildchat-1m";
await mkdir(outputRoot, { recursive: true });

let completed = 0;
for (const file of manifest.files.slice(0, maxShards)) {
  const destination = `${outputRoot}/${file.path.split("/").pop()}`;
  if (await validFile(destination, file)) {
    completed++;
    console.log(`verified ${completed}/${Math.min(maxShards, manifest.files.length)} ${destination}`);
    continue;
  }
  await downloadShard(file, destination);
  completed++;
  console.log(`downloaded ${completed}/${Math.min(maxShards, manifest.files.length)} ${destination}`);
}
console.log(`Checkpoint complete: ${completed} verified shard(s). Re-run safely to continue.`);

async function downloadShard(file, destination) {
  const partial = `${destination}.part`;
  let offset = await fileSize(partial);
  if (offset >= file.bytes) {
    if (offset === file.bytes && await sha256(partial) === file.sha256) {
      await rename(partial, destination);
      return;
    }
    await rm(partial, { force: true });
    offset = 0;
    console.log(`discarded invalid complete/oversized partial for ${file.path}`);
  }
  const url = `https://huggingface.co/datasets/${manifest.dataset}/resolve/${manifest.revision}/${file.path}?download=true`;
  const response = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${file.path}`);
  if (offset && response.status !== 206) {
    console.log(`range unsupported for ${file.path}; restarting shard`);
    offset = 0;
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: offset ? "a" : "w" }));
  if (await fileSize(partial) !== file.bytes) throw new Error(`Incomplete shard ${file.path}; re-run to resume.`);
  const actual = await sha256(partial);
  if (actual !== file.sha256) {
    await rm(partial, { force: true });
    throw new Error(`Checksum mismatch for ${file.path}: ${actual}; invalid partial removed`);
  }
  await rename(partial, destination);
}
async function validFile(path, file) {
  try { return (await fileSize(path)) === file.bytes && (await sha256(path)) === file.sha256; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
async function fileSize(path) {
  try { return (await stat(path)).size; }
  catch (error) { if (error?.code === "ENOENT") return 0; throw error; }
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function argument(name) { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1]; }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`); return parsed; }
