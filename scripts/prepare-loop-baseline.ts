import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { arch, platform } from "node:process";
import { convertMarkdown, type ConvertOptions, type ConversionResult } from "../src/convert.js";

type Split = "train" | "validation" | "public-test";
type InputCase = {
  id: string;
  kind: "policy" | "commonmark" | "mutant";
  path: string;
  sourceMarkdown: string;
  lineageId: string;
  categories: string[];
  options?: ConvertOptions;
  gold?: { origin: "policy"; expectedMessages: string[]; expectedWarningCodes: string[] };
};

type BaselineCase = {
  schemaVersion: 1;
  id: string;
  source: { kind: InputCase["kind"]; path: string; recordId: string; contentSha256: string; lineageId: string };
  split: Split;
  labelClass: "gold" | "invariant-only";
  categories: string[];
  conversion: { messages: string[]; warningCodes: string[]; deterministic: boolean };
  invariants: { noCrash: boolean; withinCapacity: boolean; balancedFences: boolean; activeMentionsAbsent: boolean; mentionPolicyConformant: boolean };
  gold?: {
    origin: "policy";
    expectedMessages: string[];
    expectedWarningCodes: string[];
    exactMessagesMatch: boolean;
    warningCodesMatch: boolean;
  };
};

const sources = {
  policy: "data/fixtures/discord-policy-v1.jsonl",
  commonmark: "data/spec/commonmark-0.31.2.jsonl",
  mutant: "data/mutations/commonmark-mutants-v1.jsonl"
} as const;
const baselineVersion = argument("--version") ?? "2";
if (!/^\d+$/.test(baselineVersion)) throw new Error(`Invalid baseline version: ${baselineVersion}`);
const runId = `public-baseline-v${baselineVersion}`;
const outputDirectory = `data/loop/baseline-v${baselineVersion}`;
const casesPath = `${outputDirectory}/cases.jsonl`;
const reportPath = `${outputDirectory}/report.json`;
const manifestPath = `${outputDirectory}/manifest.json`;
const splitPolicy = { version: "sha256-lineage-v1", unit: "source-lineage", train: 70, validation: 20, publicTest: 10 } as const;
const checkOnly = process.argv.includes("--check");

async function main(): Promise<void> {
  const inputs = await loadInputs();
  const cases = inputs.map(runCase).sort((left, right) => left.id.localeCompare(right.id));
  const casesJsonl = cases.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const report = createReport(cases);
  const reportJson = JSON.stringify(report, null, 2) + "\n";
  if (report.gold.failed > 0 || report.invariants.failedCases > 0) {
    throw new Error(`Baseline gate failed: ${report.gold.failed} gold failures, ${report.invariants.failedCases} invariant failures (${report.failures.join(", ")})`);
  }
  if (checkOnly) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assertRuntimeCompatibility(manifest);
    assertExact(await readFile(casesPath, "utf8"), casesJsonl, casesPath);
    assertExact(await readFile(reportPath, "utf8"), reportJson, reportPath);
    console.log(`Replayed ${cases.length} baseline cases with exact committed outputs under ${manifest.runtimeCompatibility}.`);
    return;
  }

  await mkdir(outputDirectory, { recursive: true });
  await atomicWrite(casesPath, casesJsonl);
  await atomicWrite(reportPath, reportJson);

  const sourceEntries = await Promise.all(Object.values(sources).map(async (path) => ({
    path,
    sha256: await sha256File(path),
    records: await countRecords(path)
  })));
  const converterIdentity = createHash("sha256")
    .update(await readFile("src/convert.ts"))
    .update("\0")
    .update(await readFile("package-lock.json"))
    .digest("hex");
  const manifest = {
    schemaVersion: 1,
    runId,
    runKind: "baseline",
    status: "complete",
    converterIdentity: {
      repositoryCommit: null,
      sourceSha256: converterIdentity,
      policyFixtureSha256: await sha256File(sources.policy)
    },
    runtime: {
      node: process.version,
      platform,
      architecture: arch,
      icu: process.versions.icu ?? "unknown",
      unicode: process.versions.unicode ?? "unknown"
    },
    runtimeCompatibility: "node-icu-unicode-locale-v1",
    segmentationLocale: "en",
    sources: sourceEntries,
    splitPolicy,
    artifacts: [
      { path: casesPath, sha256: await sha256File(casesPath) },
      { path: reportPath, sha256: await sha256File(reportPath) }
    ],
    notes: "Public deterministic substrate only. Policy fixtures are gold; CommonMark and mutant records provide invariants, not expected Discord output. Converter identity hashes src/convert.ts and package-lock.json."
  };
  await atomicJson(manifestPath, manifest);

  console.log(`Prepared ${cases.length} baseline cases: ${report.gold.passed}/${report.gold.total} gold passed, ${report.invariants.failedCases} invariant failures`);
}

async function loadInputs(): Promise<InputCase[]> {
  const policy = (await loadJsonl<Record<string, unknown>>(sources.policy)).map((row) => ({
    id: String(row.id),
    kind: "policy" as const,
    path: sources.policy,
    sourceMarkdown: String(row.sourceMarkdown),
    lineageId: String(row.id),
    categories: uniqueStrings(row.categories),
    options: (row.options ?? undefined) as ConvertOptions | undefined,
    gold: {
      origin: "policy" as const,
      expectedMessages: row.expectedDiscordMessages as string[],
      expectedWarningCodes: uniqueStrings(row.expectedWarningCodes)
    }
  }));
  const commonmark = (await loadJsonl<Record<string, unknown>>(sources.commonmark)).map((row) => ({
    id: String(row.id),
    kind: "commonmark" as const,
    path: sources.commonmark,
    sourceMarkdown: String(row.source_markdown),
    lineageId: String(row.id),
    categories: uniqueStrings(row.categories)
  }));
  const mutants = (await loadJsonl<Record<string, unknown>>(sources.mutant)).map((row) => ({
    id: String(row.id),
    kind: "mutant" as const,
    path: sources.mutant,
    sourceMarkdown: String(row.sourceMarkdown),
    lineageId: String(row.parentId),
    categories: uniqueStrings(row.categories)
  }));
  return [...policy, ...commonmark, ...mutants];
}

function runCase(input: InputCase): BaselineCase {
  let first: ConversionResult;
  let second: ConversionResult;
  try {
    first = convertMarkdown(input.sourceMarkdown, input.options);
    second = convertMarkdown(input.sourceMarkdown, input.options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 1,
      id: `${input.kind}:${input.id}`,
      source: sourceIdentity(input),
      split: splitFor(input.lineageId),
      labelClass: input.gold ? "gold" : "invariant-only",
      categories: input.categories,
      conversion: { messages: [""], warningCodes: [`conversion-crash:${message}`], deterministic: false },
      invariants: { noCrash: false, withinCapacity: false, balancedFences: false, activeMentionsAbsent: false, mentionPolicyConformant: false },
      ...(input.gold ? { gold: goldResult(input.gold, [""], []) } : {})
    };
  }

  const max = input.options?.maxMessageLength ?? 2_000;
  const warningCodes = [...new Set(first.warnings.map((warning) => warning.code))].sort();
  const activeMentionsAbsent = first.messages.every(hasNoActiveMentionsOutsideCode);
  return {
    schemaVersion: 1,
    id: `${input.kind}:${input.id}`,
    source: sourceIdentity(input),
    split: splitFor(input.lineageId),
    labelClass: input.gold ? "gold" : "invariant-only",
    categories: [...new Set(input.categories)].sort(),
    conversion: {
      messages: first.messages,
      warningCodes,
      deterministic: JSON.stringify(first) === JSON.stringify(second)
    },
    invariants: {
      noCrash: true,
      withinCapacity: first.messages.every((message) => codePointLength(message) <= max),
      balancedFences: first.messages.every(hasBalancedFences),
      activeMentionsAbsent,
      mentionPolicyConformant: input.options?.neutralizeMentions === false || activeMentionsAbsent
    },
    ...(input.gold ? { gold: goldResult(input.gold, first.messages, warningCodes) } : {})
  };
}

function sourceIdentity(input: InputCase): BaselineCase["source"] {
  return {
    kind: input.kind,
    path: input.path,
    recordId: input.id,
    contentSha256: digest(input.sourceMarkdown),
    lineageId: input.lineageId
  };
}

function goldResult(gold: NonNullable<InputCase["gold"]>, messages: string[], warningCodes: string[]): NonNullable<BaselineCase["gold"]> {
  return {
    origin: gold.origin,
    expectedMessages: gold.expectedMessages,
    expectedWarningCodes: gold.expectedWarningCodes,
    exactMessagesMatch: JSON.stringify(messages) === JSON.stringify(gold.expectedMessages),
    warningCodesMatch: JSON.stringify(warningCodes) === JSON.stringify([...gold.expectedWarningCodes].sort())
  };
}

function createReport(cases: BaselineCase[]) {
  const goldCases = cases.filter((item) => item.gold);
  const goldPassed = goldCases.filter((item) => item.gold?.exactMessagesMatch && item.gold.warningCodesMatch).length;
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
    splitCounts[item.split]++;
    kindCounts[item.source.kind] = (kindCounts[item.source.kind] ?? 0) + 1;
    for (const warning of item.conversion.warningCodes) warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    runId,
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

function splitFor(lineageId: string): Split {
  const bucket = Number.parseInt(digest(`split-v1\0${lineageId}`).slice(0, 8), 16) % 100;
  if (bucket < splitPolicy.train) return "train";
  if (bucket < splitPolicy.train + splitPolicy.validation) return "validation";
  return "public-test";
}

function hasBalancedFences(value: string): boolean {
  let open = 0;
  for (const line of value.split("\n")) {
    const match = line.match(/^(`{3,})(?:[^`]*)$/);
    if (!match) continue;
    if (open === 0) open = match[1].length;
    else if (match[1].length >= open && line.slice(match[1].length).trim() === "") open = 0;
  }
  return open === 0;
}

function hasNoActiveMentionsOutsideCode(value: string): boolean {
  let fenceLength = 0;
  for (const line of value.split("\n")) {
    const fence = line.match(/^(`{3,})/);
    if (!fenceLength && fence) { fenceLength = fence[1].length; continue; }
    if (fenceLength && fence && fence[1].length >= fenceLength && line.slice(fence[1].length).trim() === "") { fenceLength = 0; continue; }
    if (fenceLength) continue;
    const prose = line.replace(/(`+)(?:[^`]|`(?!\1))*\1/g, "");
    if (/@(?:everyone|here)\b/i.test(prose) || /<@[!&]?\d+>/.test(prose)) return false;
  }
  return true;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"))].sort();
}
function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function codePointLength(value: string): number { return Array.from(value).length; }
function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function countRecords(path: string): Promise<number> { let count = 0; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) count++; return count; }
async function loadJsonl<T>(path: string): Promise<T[]> { const rows: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line)); return rows; }
async function atomicJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, JSON.stringify(value, null, 2) + "\n"); }
function assertRuntimeCompatibility(manifest: Record<string, any>): void {
  if (manifest.runtimeCompatibility !== "node-icu-unicode-locale-v1") throw new Error(`Unsupported runtime compatibility policy: ${manifest.runtimeCompatibility}`);
  const expected = { node: process.version, icu: process.versions.icu ?? "unknown", unicode: process.versions.unicode ?? "unknown", locale: "en" };
  const recorded = { node: manifest.runtime.node, icu: manifest.runtime.icu, unicode: manifest.runtime.unicode, locale: manifest.segmentationLocale };
  if (JSON.stringify(recorded) !== JSON.stringify(expected)) {
    throw new Error(`Incompatible replay runtime: expected ${JSON.stringify(recorded)}, received ${JSON.stringify(expected)}`);
  }
}
function assertExact(actual: string, expected: string, identity: string): void { if (actual !== expected) throw new Error(`${identity} differs from replayed output; run npm run loop:prepare`); }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
function sortedRecord(value: Record<string, number>): Record<string, number> { return Object.fromEntries(Object.entries(value).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))); }

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
