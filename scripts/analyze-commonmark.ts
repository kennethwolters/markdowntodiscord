import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { convertMarkdown } from "../src/convert.js";

const inputPath = "data/spec/commonmark-0.31.2.jsonl";
const outputPath = "data/reports/commonmark-conversion-report.json";

async function main(): Promise<void> {
  const sourceSha256 = await sha256(inputPath);
  const lines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
  const report = {
    schemaVersion: 1,
    source: inputPath,
    sourceSha256,
    records: 0,
    successful: 0,
    failures: [] as Array<{ id: string; error: string }>,
    warningCounts: {} as Record<string, number>,
    outputMessageCounts: { one: 0, multiple: 0 },
    emptyOutputs: 0,
    maxOutputCodePoints: 0,
    maxMessagesPerFixture: 0,
    note: "Execution/capacity report only. CommonMark expected HTML is not Discord user-preference ground truth."
  };

  for await (const line of lines) {
    if (!line.trim()) continue;
    const fixture = JSON.parse(line);
    report.records++;
    try {
      const result = convertMarkdown(fixture.source_markdown);
      report.successful++;
      if (result.messages.length === 1) report.outputMessageCounts.one++;
      else report.outputMessageCounts.multiple++;
      if (result.messages.every((message) => message.length === 0)) report.emptyOutputs++;
      report.maxMessagesPerFixture = Math.max(report.maxMessagesPerFixture, result.messages.length);
      for (const message of result.messages) {
        const length = Array.from(message).length;
        report.maxOutputCodePoints = Math.max(report.maxOutputCodePoints, length);
        if (length > 2_000) throw new Error(`Output exceeded limit: ${length}`);
      }
      for (const warning of result.warnings) report.warningCounts[warning.code] = (report.warningCounts[warning.code] ?? 0) + 1;
    } catch (error) {
      report.failures.push({ id: fixture.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  report.warningCounts = Object.fromEntries(Object.entries(report.warningCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  await mkdir("data/reports", { recursive: true });
  await atomicJson(outputPath, report);
  console.log(`Analyzed ${report.records} fixtures: ${report.successful} successful, ${report.failures.length} failed`);
  if (report.failures.length) process.exitCode = 1;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, path);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
