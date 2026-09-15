import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

type Node = {
  type: string;
  value?: string;
  alt?: string | null;
  depth?: number;
  ordered?: boolean;
  start?: number;
  checked?: boolean | null;
  url?: string;
  title?: string | null;
  identifier?: string;
  lang?: string | null;
  children?: Node[];
  align?: Array<"left" | "right" | "center" | null>;
};

type Definition = { url: string; title?: string | null };

export interface ConvertOptions {
  maxMessageLength?: number;
  neutralizeMentions?: boolean;
}

export interface ConversionWarning {
  code: "lossy-table" | "html-flattened" | "unresolved-reference" | "unsafe-url" | "mentions-neutralized" | "message-split";
  message: string;
}

export interface ConversionResult {
  messages: string[];
  warnings: ConversionWarning[];
}

interface Context {
  definitions: Map<string, Definition>;
  warnings: ConversionWarning[];
  neutralizeMentions: boolean;
}

const parser = unified().use(remarkParse).use(remarkGfm);

export function convertMarkdown(source: string, options: ConvertOptions = {}): ConversionResult {
  const max = options.maxMessageLength ?? 2_000;
  if (!Number.isInteger(max) || max < 32) throw new RangeError("maxMessageLength must be an integer of at least 32");

  const tree = parser.parse(source) as unknown as Node;
  const definitions = new Map<string, Definition>();
  collectDefinitions(tree, definitions);
  const context: Context = {
    definitions,
    warnings: [],
    neutralizeMentions: options.neutralizeMentions ?? true
  };

  const blocks = (tree.children ?? [])
    .filter((node) => node.type !== "definition")
    .map((node) => renderBlock(node, context))
    .filter(Boolean);
  const rendered = blocks.join("\n\n").trim();
  const messages = splitDiscordMessages(rendered, max);
  if (messages.length > 1) {
    context.warnings.push({ code: "message-split", message: `Output was split into ${messages.length} Discord messages.` });
  }
  return { messages, warnings: context.warnings };
}

function collectDefinitions(node: Node, definitions: Map<string, Definition>): void {
  if (node.type === "definition" && node.identifier && node.url) {
    definitions.set(node.identifier.toLowerCase(), { url: node.url, title: node.title });
  }
  for (const child of node.children ?? []) collectDefinitions(child, definitions);
}

function renderBlock(node: Node, context: Context, depth = 0): string {
  switch (node.type) {
    case "paragraph": return renderInlineChildren(node, context);
    case "heading": return `${"#".repeat(Math.min(node.depth ?? 1, 6))} ${renderInlineChildren(node, context)}`;
    case "thematicBreak": return "──────────";
    case "blockquote": return prefixLines(renderChildren(node, context, depth), "> ");
    case "code": return fencedCode(node.value ?? "", node.lang ?? "");
    case "list": return renderList(node, context, depth);
    case "table": return renderTable(node, context);
    case "html":
      context.warnings.push({ code: "html-flattened", message: "Raw HTML was flattened to readable text." });
      return renderText(flattenHtml(node.value ?? ""), context);
    case "footnoteDefinition": return `[^${node.identifier ?? "note"}]: ${renderChildren(node, context, depth)}`;
    default:
      if (node.children) return renderChildren(node, context, depth);
      return node.value ?? "";
  }
}

function renderChildren(node: Node, context: Context, depth = 0): string {
  return (node.children ?? []).map((child) => renderBlock(child, context, depth)).filter(Boolean).join("\n\n");
}

function renderInlineChildren(node: Node, context: Context): string {
  return (node.children ?? []).map((child) => renderInline(child, context)).join("");
}

function renderInline(node: Node, context: Context): string {
  switch (node.type) {
    case "text": return renderText(node.value ?? "", context);
    case "strong": return `**${renderInlineChildren(node, context)}**`;
    case "emphasis": return `*${renderInlineChildren(node, context)}*`;
    case "delete": return `~~${renderInlineChildren(node, context)}~~`;
    case "inlineCode": return inlineCode(node.value ?? "");
    case "break": return "\n";
    case "link": return renderLink(renderInlineChildren(node, context), node.url ?? "", context);
    case "image": return renderLink(`Image: ${renderText(node.alt || "image", context)}`, node.url ?? "", context);
    case "linkReference": return renderReference(node, context, false);
    case "imageReference": return renderReference(node, context, true);
    case "html":
      context.warnings.push({ code: "html-flattened", message: "Inline HTML was flattened to readable text." });
      return renderText(flattenHtml(node.value ?? "", false), context);
    case "footnoteReference": return `[^${node.identifier ?? "note"}]`;
    default:
      if (node.children) return renderInlineChildren(node, context);
      return node.value ?? "";
  }
}

function renderReference(node: Node, context: Context, image: boolean): string {
  const definition = context.definitions.get((node.identifier ?? "").toLowerCase());
  const label = image ? `Image: ${renderText(node.alt || node.identifier || "image", context)}` : renderInlineChildren(node, context);
  if (definition) return renderLink(label, definition.url, context);
  context.warnings.push({ code: "unresolved-reference", message: `Reference '${node.identifier ?? ""}' could not be resolved.` });
  return image ? `![${node.alt ?? ""}]` : `[${label}]`;
}

function renderList(node: Node, context: Context, depth: number): string {
  const start = node.start ?? 1;
  return (node.children ?? []).map((item, index) => {
    const marker = node.ordered ? `${start + index}. ` : "- ";
    const task = item.checked == null ? "" : item.checked ? "☑ " : "☐ ";
    const body = renderChildren(item, context, depth + 1).replaceAll("\n\n", "\n");
    const continuation = " ".repeat(marker.length);
    return `${"  ".repeat(depth)}${marker}${task}${body.replaceAll("\n", `\n${"  ".repeat(depth)}${continuation}`)}`;
  }).join("\n");
}

function renderTable(node: Node, context: Context): string {
  const rows = (node.children ?? []).map((row) => (row.children ?? []).map((cell) => plainInlineText(cell).replaceAll("\n", " ")));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: width }, (_, column) => Math.max(3, ...rows.map((row) => codePointLength(row[column] ?? ""))));
  const format = (row: string[]) => row.map((cell, column) => pad(cell, widths[column])).join(" | ").trimEnd();
  const lines = [format(rows[0]), widths.map((value) => "-".repeat(value)).join("-+-"), ...rows.slice(1).map(format)];
  context.warnings.push({ code: "lossy-table", message: "A GFM table was converted to an aligned code block." });
  return fencedCode(lines.join("\n"), "text");
}

function plainInlineText(node: Node): string {
  if (node.type === "image") return `${node.alt || "image"} (${node.url ?? ""})`;
  if (node.type === "link") return `${(node.children ?? []).map(plainInlineText).join("")} (${node.url ?? ""})`;
  if (node.type === "inlineCode") return node.value ?? "";
  if (node.children) return node.children.map(plainInlineText).join("");
  return node.value ?? "";
}

function renderText(value: string, context: Context): string {
  const escaped = escapeDiscordText(value);
  return context.neutralizeMentions ? neutralizeMentions(escaped, context) : escaped;
}

function escapeDiscordText(value: string): string {
  const pieces = value.split(/(\|\|[^\n|]+\|\|)/g);
  return pieces.map((piece, index) => {
    if (index % 2 === 1) return piece;
    const escaped = piece.replaceAll(/([\\*_~`])/g, "\\$1");
    return escaped.split("\n").map((line) => line.replace(/^( {0,3})(?=(?:#|>|[-+]\s|\d+[.)]\s))/, "$1\\")).join("\n");
  }).join("");
}

function inlineCode(value: string): string {
  const longest = longestBacktickRun(value);
  const fence = "`".repeat(Math.max(1, longest + 1));
  const padding = value.startsWith("`") || value.endsWith("`") || (value.startsWith(" ") && value.endsWith(" ")) ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function fencedCode(value: string, language: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function longestBacktickRun(value: string): number {
  return Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
}

function renderLink(label: string, url: string, context: Context): string {
  if (/^(?:https?:|mailto:)/i.test(url)) return `[${label}](${url.replaceAll(" ", "%20").replaceAll(")", "\\)")})`;
  context.warnings.push({ code: "unsafe-url", message: "A relative or unsafe link was converted to non-clickable text." });
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return `${label} [unsafe URL removed]`;
  return `${label} (${escapeDiscordText(url)})`;
}

function flattenHtml(value: string, trim = true): string {
  const flattened = value
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<\/?(?:p|div|details|summary|li|ul|ol|h[1-6])(?:\s[^>]*)?>/gi, "\n")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/\n{3,}/g, "\n\n");
  return trim ? flattened.trim() : flattened;
}

function neutralizeMentions(value: string, context: Context): string {
  const next = value
    .replaceAll(/@(everyone|here)\b/gi, "@\u200B$1")
    .replaceAll(/<@([!&]?\d+)>/g, "<@\u200B$1>");
  if (next !== value) context.warnings.push({ code: "mentions-neutralized", message: "Notification-sensitive mentions were neutralized." });
  return next;
}

function prefixLines(value: string, prefix: string): string {
  return value.split("\n").map((line) => `${prefix}${line}`.trimEnd()).join("\n");
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - codePointLength(value)));
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function splitDiscordMessages(value: string, max = 2_000): string[] {
  if (!Number.isInteger(max) || max < 16) throw new RangeError("max must be an integer of at least 16");
  if (!value) return [""];
  const blocks = splitTopLevelBlocks(value);
  const messages: string[] = [];
  let current = "";

  for (const block of blocks) {
    const pieces = splitOversizedBlock(block, max);
    for (const piece of pieces) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (codePointLength(candidate) <= max) current = candidate;
      else {
        if (current) messages.push(current);
        current = piece;
      }
    }
  }
  if (current || messages.length === 0) messages.push(current);
  return messages;
}

function splitTopLevelBlocks(value: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fenceLength = 0;
  for (const line of value.split("\n")) {
    const fence = line.match(/^(`{3,})/);
    if (!fenceLength && fence) fenceLength = fence[1].length;
    else if (fenceLength && fence && fence[1].length >= fenceLength && line.slice(fence[1].length).trim() === "") fenceLength = 0;

    if (!fenceLength && line === "") {
      if (current.length) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function splitOversizedBlock(block: string, max: number): string[] {
  if (codePointLength(block) <= max) return [block];
  const fenced = block.match(/^(`{3,})([^\n]*)\n([\s\S]*)\n\1$/);
  if (fenced) {
    const [, , language, body] = fenced;
    return splitFencedBody(body, language, max);
  }
  for (const marker of ["**", "~~", "||", "*"]) {
    if (block.startsWith(marker) && block.endsWith(marker) && block.length > marker.length * 2) {
      const inner = block.slice(marker.length, -marker.length);
      const available = max - codePointLength(marker) * 2;
      return splitPlain(inner, available).map((part) => `${marker}${part}${marker}`);
    }
  }
  return splitPlain(block, max);
}

function splitFencedBody(body: string, language: string, max: number): string[] {
  const safeLanguage = codePointLength(fencedCode("", language)) <= max ? language : "";
  const points = graphemes(body);
  if (points.length === 0) return [fencedCode("", safeLanguage)];
  const parts: string[] = [];
  let start = 0;

  while (start < points.length) {
    let low = start + 1;
    let high = points.length;
    let best = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = fencedCode(points.slice(start, middle).join(""), safeLanguage);
      if (codePointLength(candidate) <= max) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (best < 0) throw new Error("Unable to fit code content inside the configured message limit");
    parts.push(fencedCode(points.slice(start, best).join(""), safeLanguage));
    start = best;
  }
  return parts;
}

function splitPlain(value: string, max: number): string[] {
  const remaining = graphemes(value);
  const parts: string[] = [];
  while (codePointLength(remaining.join("")) > max) {
    let at = fittingGraphemePrefix(remaining, max);
    const earliest = Math.max(1, at - 400);
    for (let index = at; index >= earliest; index--) {
      if (remaining[index - 1] === "\n" || remaining[index - 1] === " ") { at = index; break; }
    }
    parts.push(remaining.splice(0, at).join("").trimEnd());
    while (remaining[0] === "\n" || remaining[0] === " ") remaining.shift();
  }
  if (remaining.length) parts.push(remaining.join(""));
  return parts;
}

function fittingGraphemePrefix(values: string[], maxCodePoints: number): number {
  let length = 0;
  let index = 0;
  while (index < values.length) {
    const next = codePointLength(values[index]);
    if (length + next > maxCodePoints) break;
    length += next;
    index++;
  }
  if (index === 0) throw new Error("A single grapheme exceeds the configured message limit");
  return index;
}

function graphemes(value: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(value), (entry) => entry.segment);
}
