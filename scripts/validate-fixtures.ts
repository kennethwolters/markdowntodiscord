import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { validateBenchmarkFixture } from "../src/fixtures/schema.js";

const paths = process.argv.slice(2);
if (!paths.length) throw new Error("Pass one or more JSONL fixture paths");
let records = 0;
const ids = new Set<string>();

for (const path of paths) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    try {
      const fixture = validateBenchmarkFixture(JSON.parse(line));
      if (ids.has(fixture.id)) throw new Error(`duplicate fixture id '${fixture.id}'`);
      ids.add(fixture.id);
      records++;
    } catch (error) {
      throw new Error(`${path}:${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
console.log(`Validated ${records} fixtures across ${paths.length} file(s)`);
