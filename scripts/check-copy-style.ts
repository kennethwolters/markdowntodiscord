import { readFile } from "node:fs/promises";

const files = [
  "index.html",
  "discord-markdown-guide/index.html",
  "404.html",
  "src/main.ts"
];

const rules: Array<{ label: string; pattern: RegExp }> = [
  { label: "em or en dash", pattern: /[—–]/g },
  { label: "AI-marketing phrase", pattern: /\b(?:delve|seamless(?:ly)?|effortless(?:ly)?|elevate|unlock|revolutioni[sz]e|game[ -]changer|in today['’]s|whether you['’]re|designed to|powerful and|robust and)\b/gi }
];

const failures: string[] = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(`${file}:${line}: ${rule.label}: ${JSON.stringify(match[0])}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Public copy style check failed:\n${failures.join("\n")}`);
}

console.log(`Checked public copy in ${files.length} files.`);
