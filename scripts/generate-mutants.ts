import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { convertMarkdown } from "../src/convert.js";

const sourcePath = "data/spec/commonmark-0.31.2.jsonl";
const outputPath = "data/mutations/commonmark-mutants-v1.jsonl";
const reportPath = "data/reports/commonmark-mutant-report.json";
const targetCount = 500;

type SourceFixture = { id: string; source_markdown: string; section: string; provenance: { source_url: string; license: string; version: string } };
type Mutant = {
  schemaVersion: 1;
  id: string;
  parentId: string;
  mutation: string;
  sourceMarkdown: string;
  categories: string[];
  labelOrigin: "synthetic";
  provenance: { sourceUrl: string; license: string; version: string; derivedFrom: string };
};

async function main(): Promise<void> {
  const fixtures = await loadJsonl<SourceFixture>(sourcePath);
  const mutants: Mutant[] = [];
  const seen = new Set(fixtures.map((fixture) => normalize(fixture.source_markdown)));

  for (let fixtureIndex = 0; fixtureIndex < fixtures.length && mutants.length < targetCount; fixtureIndex++) {
    const fixture = fixtures[fixtureIndex];
    for (let offset = 0; offset < operations.length; offset++) {
      const operation = operations[(fixtureIndex + offset) % operations.length];
      const changed = operation.apply(fixture.source_markdown);
      if (changed == null || changed === fixture.source_markdown) continue;
      const dedupKey = operation.name === "lf-to-crlf" ? `crlf:${changed}` : normalize(changed);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const digest = createHash("sha256").update(`${fixture.id}\0${operation.name}\0${changed}`).digest("hex").slice(0, 12);
      mutants.push({
        schemaVersion: 1,
        id: `mutant-${operation.name}-${digest}`,
        parentId: fixture.id,
        mutation: operation.name,
        sourceMarkdown: changed,
        categories: ["controlled-mutation", slug(fixture.section), operation.name],
        labelOrigin: "synthetic",
        provenance: {
          sourceUrl: fixture.provenance.source_url,
          license: fixture.provenance.license,
          version: "mutator-v1",
          derivedFrom: fixture.id
        }
      });
      break;
    }
  }
  if (mutants.length !== targetCount) throw new Error(`Generated ${mutants.length}; expected ${targetCount}`);

  await mkdir("data/mutations", { recursive: true });
  await mkdir("data/reports", { recursive: true });
  await atomicWrite(outputPath, mutants.map((record) => JSON.stringify(record)).join("\n") + "\n");

  const failures: Array<{ id: string; error: string }> = [];
  const mutationCounts: Record<string, number> = {};
  const warningCounts: Record<string, number> = {};
  let multipleMessages = 0;
  for (const mutant of mutants) {
    mutationCounts[mutant.mutation] = (mutationCounts[mutant.mutation] ?? 0) + 1;
    try {
      const first = convertMarkdown(mutant.sourceMarkdown);
      const second = convertMarkdown(mutant.sourceMarkdown);
      if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("non-deterministic conversion");
      if (first.messages.some((message) => Array.from(message).length > 2_000)) throw new Error("message exceeds 2,000 code points");
      if (first.messages.length > 1) multipleMessages++;
      for (const warning of first.warnings) warningCounts[warning.code] = (warningCounts[warning.code] ?? 0) + 1;
    } catch (error) {
      failures.push({ id: mutant.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  await atomicJson(reportPath, {
    schemaVersion: 1,
    source: sourcePath,
    sourceSha256: await sha256(sourcePath),
    output: outputPath,
    outputSha256: await sha256(outputPath),
    targetCount,
    generated: mutants.length,
    uniqueParents: new Set(mutants.map((mutant) => mutant.parentId)).size,
    mutationCounts: sorted(mutationCounts),
    successful: mutants.length - failures.length,
    failures,
    multipleMessages,
    warningCounts: sorted(warningCounts),
    claims: "Controlled synthetic robustness cases only; converter output is not stored or labeled as human ground truth."
  });
  console.log(`Generated and checked ${mutants.length} mutants: ${failures.length} failures`);
  if (failures.length) process.exitCode = 1;
}

const operations: Array<{ name: string; apply: (value: string) => string | null }> = [
  { name: "append-asterisk", apply: (value) => `${value}*` },
  { name: "append-backtick", apply: (value) => `${value}\`` },
  { name: "prepend-blockquote", apply: (value) => `> ${value}` },
  { name: "prepend-list-marker", apply: (value) => `- ${value}` },
  { name: "lf-to-crlf", apply: (value) => value.includes("\n") ? value.replaceAll("\n", "\r\n") : null },
  { name: "first-space-to-tab", apply: (value) => value.includes(" ") ? value.replace(" ", "\t") : null },
  { name: "first-space-to-nbsp", apply: (value) => value.includes(" ") ? value.replace(" ", "\u00a0") : null },
  { name: "append-combining-mark", apply: (value) => `${value}e\u0301` },
  { name: "append-zwj-emoji", apply: (value) => `${value}👨‍👩‍👧‍👦` },
  { name: "append-discord-spoiler", apply: (value) => `${value} ||hidden||` }
];

async function loadJsonl<T>(path: string): Promise<T[]> {
  const rows: T[] = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function atomicJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, JSON.stringify(value, null, 2) + "\n"); }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
function normalize(value: string): string { return value.replaceAll("\r\n", "\n").trimEnd(); }
function slug(value: string): string { return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, ""); }
function sorted(value: Record<string, number>): Record<string, number> { return Object.fromEntries(Object.entries(value).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))); }

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
