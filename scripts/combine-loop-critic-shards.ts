import { readFile, rename, writeFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const outputPath = value("--output");
const shardPaths = values("--shard");
if (!outputPath || shardPaths.length < 2) throw new Error("Provide --output path and at least two --shard paths");
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validate = ajv.compile(JSON.parse(await readFile("data/schema/loop-critic-output.schema.json", "utf8")));
const judgments: Record<string, any>[] = [];
const packetIds = new Set<string>();
for (const shardPath of shardPaths) {
  const shard = JSON.parse(await readFile(shardPath, "utf8"));
  if (!validate(shard)) throw new Error(`${shardPath}: ${ajv.errorsText(validate.errors)}`);
  for (const judgment of shard.judgments) {
    if (packetIds.has(judgment.packetId)) throw new Error(`Duplicate packet across shards: ${judgment.packetId}`);
    packetIds.add(judgment.packetId);
    judgments.push(judgment);
  }
}
const temporary = `${outputPath}.tmp`;
await writeFile(temporary, JSON.stringify({ judgments }) + "\n");
await rename(temporary, outputPath);
console.log(`Combined ${judgments.length} unique judgments from ${shardPaths.length} shards into ${outputPath}`);

function value(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function values(name: string): string[] { const result: string[] = []; for (let index = 0; index < process.argv.length; index++) if (process.argv[index] === name && process.argv[index + 1]) result.push(process.argv[++index]); return result; }
