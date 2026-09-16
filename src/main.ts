import "./style.css";
import { convertMarkdown, type ConversionWarning } from "./convert.js";

const source = requiredElement<HTMLTextAreaElement>("source");
const outputs = requiredElement<HTMLDivElement>("outputs");
const warnings = requiredElement<HTMLDivElement>("warnings");
const status = requiredElement<HTMLDivElement>("conversion-status");
const neutralize = requiredElement<HTMLInputElement>("neutralize");
const copyNext = requiredElement<HTMLButtonElement>("copy-all");
const sourceCount = requiredElement<HTMLSpanElement>("source-count");
const messageCount = requiredElement<HTMLSpanElement>("message-count");
const examplePicker = requiredElement<HTMLSelectElement>("example-picker");

const storage = { source: "markdown-to-discord:draft", neutralize: "markdown-to-discord:neutralize" };
const examples: Record<string, string> = {
  mixed: `# Release notes

Here is what changed in **version 2.0**:

| Feature | Status |
|---|---:|
| Import Markdown | Done |
| Discord output | Ready |

- [x] Preserve code
- [ ] Share with @everyone

\`\`\`ts
const message = "Long code blocks split safely";
\`\`\`

![Architecture](https://example.com/diagram.png)`,
  table: `## Launch checklist

| Task | Owner | Status |
|---|---|---:|
| Review notes | Sam | Done |
| Post update | Lee | Pending |

- [x] Test formatting
- [ ] Paste into Discord`,
  mentions: `Please notify @everyone and <@123456789012345678>.

Read [the safe guide](https://example.com/guide) and ignore [this unsafe link](javascript:alert(1)).`,
  "long-code": `# Long code example

\`\`\`js
${Array.from({ length: 90 }, (_, index) => `console.log("Line ${index + 1}: Discord-safe splitting");`).join("\n")}
\`\`\``
};

const warningHelp: Record<ConversionWarning["code"], { title: string; action: string; href: string }> = {
  "lossy-table": { title: "Table converted", action: "Check column alignment before posting.", href: "/discord-markdown-guide/#conversion" },
  "math-degraded": { title: "Math preserved as text", action: "Discord does not render LaTeX; verify the readable source.", href: "/discord-markdown-guide/#unsupported" },
  "html-flattened": { title: "HTML flattened", action: "Check that the readable text retains the intended meaning.", href: "/discord-markdown-guide/#unsupported" },
  "unresolved-reference": { title: "Reference link unresolved", action: "Add the missing link definition or replace it with an inline link.", href: "/discord-markdown-guide/#conversion" },
  "unsafe-url": { title: "Unsafe link disabled", action: "Verify the destination before replacing it with an https URL.", href: "/discord-markdown-guide/#conversion" },
  "mentions-neutralized": { title: "Mentions made safe", action: "They will display without notifying people or roles.", href: "/discord-markdown-guide/#mentions" },
  "message-split": { title: "Output split for Discord", action: "Copy and send each numbered message in order.", href: "/discord-markdown-guide/#limits" }
};

let currentMessages: string[] = [];
let nextCopyIndex = 0;
let timer = 0;
restorePreferences();

source.addEventListener("input", scheduleRender);
neutralize.addEventListener("change", () => { persist(); render(); });
requiredElement("load-example").addEventListener("click", () => {
  source.value = examples[examplePicker.value] ?? examples.mixed;
  persist();
  render();
  source.focus();
});
requiredElement("clear").addEventListener("click", () => {
  source.value = "";
  removeStoredDraft();
  render();
  source.focus();
});
copyNext.addEventListener("click", async () => {
  if (currentMessages.length === 0) return;
  const copiedIndex = nextCopyIndex;
  if (!await copyText(currentMessages[copiedIndex])) return;
  nextCopyIndex = (copiedIndex + 1) % currentMessages.length;
  const announcement = currentMessages.length === 1 ? "Output copied" : `Message ${copiedIndex + 1} of ${currentMessages.length} copied`;
  status.textContent = announcement;
  copyNext.textContent = announcement;
  copyNext.classList.add("copied");
  window.setTimeout(() => {
    copyNext.classList.remove("copied");
    updateCopyButton();
  }, 1_400);
});

render();

function scheduleRender(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { persist(); render(); }, 80);
}

function render(): void {
  const value = source.value;
  sourceCount.textContent = `${Array.from(value).length.toLocaleString()} characters`;
  outputs.replaceChildren();
  warnings.replaceChildren();

  if (!value.trim()) {
    currentMessages = [];
    nextCopyIndex = 0;
    outputs.append(emptyState("Your converted messages will appear here."));
    messageCount.textContent = "0 messages";
    status.textContent = "No output";
    copyNext.disabled = true;
    updateCopyButton();
    return;
  }

  const result = convertMarkdown(value, { neutralizeMentions: neutralize.checked });
  currentMessages = result.messages.filter((message) => message.length > 0);
  nextCopyIndex = 0;
  copyNext.disabled = currentMessages.length === 0;
  updateCopyButton();
  messageCount.textContent = `${currentMessages.length} ${currentMessages.length === 1 ? "message" : "messages"}`;

  renderWarnings(result.warnings);
  status.textContent = `${currentMessages.length} ${currentMessages.length === 1 ? "message" : "messages"} ready${result.warnings.length ? ` with ${result.warnings.length} conversion warnings` : ""}.`;
  currentMessages.forEach((message, index) => outputs.append(outputCard(message, index, currentMessages.length)));
}

function renderWarnings(items: ConversionWarning[]): void {
  const grouped = new Map<ConversionWarning["code"], ConversionWarning[]>();
  for (const warning of items) grouped.set(warning.code, [...(grouped.get(warning.code) ?? []), warning]);
  for (const [code, matches] of grouped) {
    const help = warningHelp[code];
    const item = document.createElement("div");
    item.className = "warning";
    const copy = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = matches.length > 1 ? `${help.title} (${matches.length})` : help.title;
    const detail = document.createElement("span");
    detail.textContent = ` ${matches.length > 1 && code === "unresolved-reference" ? matches.map((match) => match.message).join(" ") : help.action}`;
    copy.append(strong, detail);
    const link = document.createElement("a");
    link.href = help.href;
    link.textContent = "Learn more";
    item.append(copy, link);
    warnings.append(item);
  }
}

function updateCopyButton(): void {
  copyNext.textContent = currentMessages.length <= 1
    ? "Copy output"
    : `Copy message ${nextCopyIndex + 1} of ${currentMessages.length}`;
  copyNext.setAttribute("aria-label", copyNext.textContent);
}

function outputCard(message: string, index: number, total: number): HTMLElement {
  const card = document.createElement("article");
  card.className = "message-card";
  card.setAttribute("aria-labelledby", `message-${index + 1}-label`);
  const heading = document.createElement("div");
  heading.className = "message-heading";
  const label = document.createElement("span");
  label.id = `message-${index + 1}-label`;
  label.textContent = total === 1 ? "Ready to paste" : `Message ${index + 1} of ${total}`;
  const count = document.createElement("span");
  count.className = "message-length";
  count.textContent = `${Array.from(message).length.toLocaleString()} / 2,000`;
  heading.append(label, count);

  const pre = document.createElement("pre");
  pre.textContent = message;
  const button = document.createElement("button");
  button.className = "copy-button";
  button.type = "button";
  button.textContent = `Copy message${total > 1 ? ` ${index + 1}` : ""}`;
  button.addEventListener("click", async () => {
    if (await copyText(message)) {
      showCopied(button, "Copied");
      status.textContent = `${total > 1 ? `Message ${index + 1}` : "Output"} copied`;
    }
  });
  card.append(heading, pre, button);
  return card;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    let error = document.getElementById("clipboard-error");
    if (!error) {
      error = document.createElement("div");
      error.id = "clipboard-error";
      error.className = "warning error";
      error.setAttribute("role", "alert");
      warnings.append(error);
    }
    error.textContent = "Clipboard access was blocked. Select the message text and copy it manually.";
    return false;
  }
}

function persist(): void {
  try {
    localStorage.setItem(storage.source, source.value);
    localStorage.setItem(storage.neutralize, String(neutralize.checked));
  } catch { /* Conversion remains usable when storage is blocked. */ }
}
function restorePreferences(): void {
  try {
    source.value = localStorage.getItem(storage.source) ?? "";
    const savedNeutralize = localStorage.getItem(storage.neutralize);
    if (savedNeutralize !== null) neutralize.checked = savedNeutralize !== "false";
  } catch { /* Use HTML defaults when storage is blocked. */ }
}
function removeStoredDraft(): void {
  try { localStorage.removeItem(storage.source); } catch { /* Nothing else to clear. */ }
}
function showCopied(button: HTMLButtonElement, label: string): void {
  const previous = button.textContent;
  button.textContent = label;
  button.classList.add("copied");
  window.setTimeout(() => {
    button.textContent = previous;
    button.classList.remove("copied");
  }, 1_400);
}
function emptyState(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "empty-state";
  element.textContent = text;
  return element;
}
function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
