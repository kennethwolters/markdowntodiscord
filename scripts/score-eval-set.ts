import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { convertMarkdown } from "../src/convert.js";

const directory = "data/work/semantic-eval-consensus-v2";
const inputPath = argument("--input") ?? `${directory}/labels.final.private.jsonl`;
const split = argument("--split") ?? "validation";
if (split !== "validation" && split !== "challenge") throw new Error("--split must be validation or challenge");
if (split === "challenge" && !process.argv.includes("--release-candidate")) throw new Error("Challenge scoring requires --release-candidate");
const outputPath = argument("--output") ?? `${directory}/${split}-score.private.json`;
const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
const reviewSchema = JSON.parse(await readFile("data/schema/eval-review.schema.json", "utf8")); ajv.addSchema(reviewSchema);
const validateGold = ajv.compile(JSON.parse(await readFile("data/schema/eval-consensus.schema.json", "utf8")));
const all = await loadJsonl<Record<string, any>>(inputPath);
for (const [index, item] of all.entries()) if (!validateGold(item)) throw new Error(`${inputPath}:${index + 1}: ${ajv.errorsText(validateGold.errors, { separator: "; " })}`);
if (new Set(all.map((item) => item.id)).size !== all.length) throw new Error("Duplicate case IDs");
const finalReport = JSON.parse(await readFile(`${directory}/final-report.private.json`, "utf8"));
if (finalReport.finalLabels !== all.length) throw new Error(`Final report expects ${finalReport.finalLabels} labels, received ${all.length}`);
const cases = all.filter((item) => item.split === split);
if (!cases.length) throw new Error(`No ${split} cases`);
const results = cases.map((item) => {
  try {
    const first = convertMarkdown(item.source.sourceMarkdown, item.options); const second = convertMarkdown(item.source.sourceMarkdown, item.options);
    const warnings = [...new Set(first.warnings.map((warning) => warning.code))].sort();
    const failures = scoreLabel(item.label, first.messages, warnings);
    if (JSON.stringify(first) !== JSON.stringify(second)) failures.push("nondeterministic-output");
    if (!first.messages.every((message) => Array.from(message).length <= (item.options.maxMessageLength ?? 2_000))) failures.push("message-capacity");
    if (!first.messages.every(hasBalancedFences)) failures.push("unbalanced-fence");
    if (item.options.neutralizeMentions !== false && !first.messages.every(hasNoActiveMentionsOutsideCode)) failures.push("active-mention");
    if (first.messages.some(hasUnsafeClickableScheme)) failures.push("unsafe-url-scheme");
    if (first.messages.some(hasBrokenUnicodeBoundary)) failures.push("unicode-boundary");
    return { id: item.id, pass: failures.length === 0, failures: [...new Set(failures)].sort(), categories: item.categories, risk: item.risk, bucket: item.portfolioBucket, source: item.source.family };
  } catch { return { id: item.id, pass: false, failures: ["conversion-crash"], categories: item.categories, risk: item.risk, bucket: item.portfolioBucket, source: item.source.family }; }
});
const passed = results.filter((item) => item.pass).length;
const report = {
  schemaVersion: 2, evalSetId: "semantic-eval-consensus-v2", split, releaseCandidateGate: split === "challenge",
  converterSha256: digest(Buffer.concat([await readFile("src/convert.ts"), await readFile("package.json"), await readFile("package-lock.json")])),
  inputSha256: await sha256File(inputPath), total: results.length, passed, failed: results.length - passed, passRate: passed / results.length, wilson95: wilson(passed, results.length),
  byBucket: grouped(results, (item) => item.bucket), bySource: grouped(results, (item) => item.source), byRisk: grouped(results, (item) => item.risk),
  failureCounts: count(results.flatMap((item) => item.failures)),
  ...(split === "validation" ? { failures: results.filter((item) => !item.pass).map((item) => ({ id: item.id, reasons: item.failures })) } : {})
};
await mkdir(dirname(outputPath), { recursive: true }); await atomicWrite(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(`Scored ${results.length} ${split} silver cases: ${passed} passed, ${results.length - passed} failed.`);

function scoreLabel(label: Record<string, any>, messages: string[], warnings: string[]): string[] { if (label.mode === "exact") return [...(!label.acceptableMessageArrays.some((expected: string[]) => JSON.stringify(expected) === JSON.stringify(messages)) ? ["exact-messages"] : []), ...(JSON.stringify([...label.expectedWarningCodes].sort()) !== JSON.stringify(warnings) ? ["exact-warning-codes"] : [])]; const output = messages.join("\n\n"); const a = label.assertions; const failures: string[] = []; for (const value of a.requiredText) if (!output.includes(value)) failures.push("required-text"); for (const value of a.forbiddenText) if (output.includes(value)) failures.push("forbidden-text"); for (const value of a.requiredUrls) if (!containsUrlIdentity(output, value)) failures.push("required-url"); for (const value of a.forbiddenUrls) if (containsUrlIdentity(output, value)) failures.push("forbidden-url"); for (const value of a.requiredWarningCodes) if (!warnings.includes(value)) failures.push("required-warning"); for (const value of a.forbiddenWarningCodes) if (warnings.includes(value)) failures.push("forbidden-warning"); if (a.forbidActiveMentions && !hasNoActiveMentionsOutsideCode(output)) failures.push("active-mention"); for (const group of a.orderedTextGroups ?? []) { let offset = 0; for (const value of group) { const found = output.indexOf(value, offset); if (found < 0) { failures.push("text-order"); break; } offset = found + value.length; } } return failures; }
function containsUrlIdentity(output: string, url: string): boolean { const continuation = /[A-Za-z0-9._~:/?#@!$&'*+,;=%-]/; let offset = 0; while (offset <= output.length - url.length) { const index = output.indexOf(url, offset); if (index < 0) return false; const before = output[index - 1] ?? ""; const after = output[index + url.length] ?? ""; if ((!before || !continuation.test(before)) && (!after || !continuation.test(after))) return true; offset = index + 1; } return false; }
function hasBalancedFences(value: string): boolean { let open = 0; for (const line of value.split("\n")) { const match = line.match(/^(`{3,})(?:[^`]*)$/); if (!match) continue; if (!open) open = match[1].length; else if (match[1].length >= open && line.slice(match[1].length).trim() === "") open = 0; } return open === 0; }
function hasNoActiveMentionsOutsideCode(value: string): boolean { let fence = 0; for (const line of value.split("\n")) { const marker = line.match(/^(`{3,})/); if (!fence && marker) { fence = marker[1].length; continue; } if (fence && marker && marker[1].length >= fence && line.slice(marker[1].length).trim() === "") { fence = 0; continue; } if (fence) continue; const prose = line.replace(/(`+)(?:[^`]|`(?!\1))*\1/g, ""); if (/@(?:everyone|here)\b/i.test(prose) || /<@[!&]?\d+>/.test(prose)) return false; } return true; }
function hasUnsafeClickableScheme(value: string): boolean { return /(?:<|\]\()\s*(?:javascript|data|vbscript):/i.test(value); }
function hasBrokenUnicodeBoundary(value: string): boolean { return /^\p{M}/u.test(value) || /\u200d$/u.test(value) || /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(value); }
function grouped<T>(values: T[], key: (item: T) => string): Record<string, unknown> { const groups = new Map<string, T[]>(); for (const item of values) { const name = key(item); groups.set(name, [...(groups.get(name) ?? []), item]); } return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => { const pass = items.filter((item: any) => item.pass).length; return [name, { total: items.length, passed: pass, passRate: pass / items.length, wilson95: wilson(pass, items.length) }]; })); }
function wilson(successes: number, total: number): { lower: number; upper: number } { if (!total) return { lower: 0, upper: 0 }; const z = 1.959963984540054; const p = successes / total; const denominator = 1 + z * z / total; const center = (p + z * z / (2 * total)) / denominator; const radius = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator; return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) }; }
function count(values: string[]): Record<string, number> { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return Object.fromEntries(Object.entries(result).sort((a, b) => b[1] - a[1])); }
function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function loadJsonl<T>(path: string): Promise<T[]> { const rows: T[] = []; const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line)); return rows; }
async function atomicWrite(path: string, value: string): Promise<void> { const temporary = `${path}.tmp`; await writeFile(temporary, value); await rename(temporary, path); }
