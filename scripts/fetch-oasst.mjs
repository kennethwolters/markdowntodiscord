import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const url = "https://huggingface.co/datasets/OpenAssistant/oasst1/resolve/main/2023-04-12_oasst_ready.messages.jsonl.gz?download=true";
const expectedSha256 = "286a6e9a5a413b3272ae9c0b5a20d327983dea1c24342ae28cb244a6da65185c";
const expectedBytes = 34_196_309;
const destination = "data/raw/oasst1/2023-04-12_oasst_ready.messages.jsonl.gz";
const partial = `${destination}.part`;
const manifestPath = "data/raw/oasst1/manifest.json";

await mkdir("data/raw/oasst1", { recursive: true });

if (await validExistingFile(destination)) {
  await publishManifest();
  console.log(`Already verified and manifest published: ${destination}`);
  process.exit(0);
}

let offset = await fileSize(partial);
if (offset > expectedBytes) {
  throw new Error(`Partial file is larger than expected (${offset} > ${expectedBytes}); remove ${partial}`);
}

const headers = offset ? { Range: `bytes=${offset}-` } : {};
console.log(`${offset ? "Resuming" : "Downloading"} at byte ${offset.toLocaleString()} of ${expectedBytes.toLocaleString()}`);
const response = await fetch(url, { headers, redirect: "follow" });
if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);

if (offset && response.status !== 206) {
  console.log("Server ignored the range request; restarting the partial download.");
  offset = 0;
}

const output = createWriteStream(partial, { flags: offset ? "a" : "w" });
await pipeline(Readable.fromWeb(response.body), output);

const actualBytes = await fileSize(partial);
if (actualBytes !== expectedBytes) {
  throw new Error(`Incomplete download: received ${actualBytes} bytes, expected ${expectedBytes}. Re-run to resume.`);
}
const actualSha256 = await sha256(partial);
if (actualSha256 !== expectedSha256) {
  throw new Error(`Checksum mismatch for ${partial}: ${actualSha256}`);
}

await rename(partial, destination);
await publishManifest();
console.log(`Verified ${destination} (${actualSha256})`);

async function validExistingFile(path) {
  try {
    return (await fileSize(path)) === expectedBytes && (await sha256(path)) === expectedSha256;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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

async function publishManifest() {
  await atomicJson(manifestPath, {
    dataset: "OpenAssistant/oasst1",
    release: "2023-04-12 ready messages",
    source_url: url,
    dataset_card: "https://huggingface.co/datasets/OpenAssistant/oasst1",
    license: "Apache-2.0",
    file: destination,
    bytes: expectedBytes,
    sha256: expectedSha256
  });
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  const handle = await open(temporary, "r");
  await handle.sync();
  await handle.close();
  await rename(temporary, path);
}
