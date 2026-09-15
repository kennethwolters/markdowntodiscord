import "./style.css";
import { convertMarkdown } from "./convert.js";

const source = requiredElement<HTMLTextAreaElement>("source");
const outputs = requiredElement<HTMLDivElement>("outputs");
const warnings = requiredElement<HTMLDivElement>("warnings");
const neutralize = requiredElement<HTMLInputElement>("neutralize");
const copyAll = requiredElement<HTMLButtonElement>("copy-all");
const sourceCount = requiredElement<HTMLSpanElement>("source-count");
const messageCount = requiredElement<HTMLSpanElement>("message-count");

const example = `# Release notes

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

![Architecture](https://example.com/diagram.png)`;

let currentMessages: string[] = [];
let timer = 0;

source.addEventListener("input", scheduleRender);
neutralize.addEventListener("change", render);
requiredElement("load-example").addEventListener("click", () => {
  source.value = example;
  render();
  source.focus();
});
requiredElement("clear").addEventListener("click", () => {
  source.value = "";
  render();
  source.focus();
});
copyAll.addEventListener("click", async () => {
  if (await copyText(currentMessages.join("\n\n"))) showCopied(copyAll, "Copied all");
});

render();

function scheduleRender(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(render, 80);
}

function render(): void {
  const value = source.value;
  sourceCount.textContent = `${Array.from(value).length.toLocaleString()} characters`;
  outputs.replaceChildren();
  warnings.replaceChildren();

  if (!value) {
    currentMessages = [];
    outputs.append(emptyState("Your converted messages will appear here."));
    messageCount.textContent = "0 messages";
    copyAll.disabled = true;
    return;
  }

  const result = convertMarkdown(value, { neutralizeMentions: neutralize.checked });
  currentMessages = result.messages;
  copyAll.disabled = false;
  messageCount.textContent = `${result.messages.length} ${result.messages.length === 1 ? "message" : "messages"}`;

  const uniqueWarnings = [...new Map(result.warnings.map((warning) => [warning.code, warning])).values()];
  for (const warning of uniqueWarnings) {
    const item = document.createElement("div");
    item.className = "warning";
    item.textContent = warning.message;
    warnings.append(item);
  }

  result.messages.forEach((message, index) => outputs.append(outputCard(message, index, result.messages.length)));
}

function outputCard(message: string, index: number, total: number): HTMLElement {
  const card = document.createElement("article");
  card.className = "message-card";
  const heading = document.createElement("div");
  heading.className = "message-heading";
  const label = document.createElement("span");
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
  button.textContent = "Copy message";
  button.addEventListener("click", async () => {
    if (await copyText(message)) showCopied(button, "Copied");
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
