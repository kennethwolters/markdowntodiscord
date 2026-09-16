import "./style.css";
import type { ConversionResult, ConversionWarning, ConvertOptions } from "./convert.js";

const source = requiredElement<HTMLTextAreaElement>("source");
const outputs = requiredElement<HTMLDivElement>("outputs");
const warnings = requiredElement<HTMLDivElement>("warnings");
const status = requiredElement<HTMLDivElement>("conversion-status");
const neutralize = requiredElement<HTMLInputElement>("neutralize");
const copyNext = requiredElement<HTMLButtonElement>("copy-all");
const sourceCount = requiredElement<HTMLSpanElement>("source-count");
const messageCount = requiredElement<HTMLSpanElement>("message-count");
const fileInput = requiredElement<HTMLInputElement>("file-input");
const clearButton = requiredElement<HTMLButtonElement>("clear");
const inputPanel = source.closest<HTMLElement>(".input-panel")!;
const undoClear = requiredElement<HTMLDivElement>("undo-clear");

const storage = { source: "markdown-to-discord:tab-draft", neutralize: "markdown-to-discord:neutralize", progress: "markdown-to-discord:copy-progress" };
const maxFileBytes = 2 * 1024 * 1024;

const warningHelp: Record<ConversionWarning["code"], { title: string; action: string; href: string }> = {
  "lossy-table": { title: "Table converted", action: "Check column alignment before posting.", href: "/discord-markdown-guide/#unsupported" },
  "math-degraded": { title: "Math preserved as text", action: "Discord does not render LaTeX; verify the readable source.", href: "/discord-markdown-guide/#unsupported" },
  "html-flattened": { title: "HTML flattened", action: "Check that the readable text retains the intended meaning.", href: "/discord-markdown-guide/#unsupported" },
  "unresolved-reference": { title: "Reference link unresolved", action: "Add the missing link definition or replace it with an inline link.", href: "/discord-markdown-guide/#unsupported" },
  "unsafe-url": { title: "Unsafe link disabled", action: "Verify the destination before replacing it with an https URL.", href: "/discord-markdown-guide/#unsupported" },
  "mentions-neutralized": { title: "Mentions made safe", action: "They will display without notifying people or roles.", href: "/discord-markdown-guide/#mentions" },
  "message-split": { title: "Output split for Discord", action: "Copy and send each numbered message in order.", href: "/discord-markdown-guide/#limits" }
};

type ConversionResponse = { id: number; result: ConversionResult };

let converterWorker: Worker | undefined;
let nextConversionId = 0;
let renderVersion = 0;
const pendingConversions = new Map<number, { resolve: (result: ConversionResult) => void; reject: (error: Error) => void }>();
let currentMessages: string[] = [];
let nextCopyIndex = 0;
let timer = 0;
let undoTimer = 0;
let clearedDraft: string | undefined;
let clearedCopyProgress: number[] = [];
const copiedIndices = new Set<number>();
restorePreferences();

source.addEventListener("input", () => { if (clearedDraft !== undefined) { clearedDraft = undefined; hideUndo(); } scheduleRender(); });
source.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !copyNext.disabled) { event.preventDefault(); copyNext.click(); }
});
neutralize.addEventListener("change", () => { persist(); void render(); });
requiredElement("open-file").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => { const file = fileInput.files?.[0]; if (file) await loadFile(file); fileInput.value = ""; });
for (const eventName of ["dragenter", "dragover"]) inputPanel.addEventListener(eventName, (event) => { event.preventDefault(); inputPanel.classList.add("dragging"); });
for (const eventName of ["dragleave", "drop"]) inputPanel.addEventListener(eventName, (event) => { event.preventDefault(); inputPanel.classList.remove("dragging"); });
inputPanel.addEventListener("drop", async (event) => { const file = event.dataTransfer?.files[0]; if (file) await loadFile(file); });
clearButton.addEventListener("click", () => {
  if (!source.value) return;
  clearedDraft = source.value;
  clearedCopyProgress = [...copiedIndices];
  source.value = "";
  removeStoredDraft();
  void render();
  showUndo();
  source.focus();
});
requiredElement("undo-clear-button").addEventListener("click", () => {
  if (clearedDraft === undefined) return;
  source.value = clearedDraft;
  const progress = [...clearedCopyProgress];
  clearedDraft = undefined;
  clearedCopyProgress = [];
  hideUndo();
  persist();
  const restoredDraft = source.value;
  void render().then(() => {
    if (source.value !== restoredDraft) return;
    for (const index of progress) if (index < currentMessages.length) markCopied(index);
  });
  source.focus();
});
copyNext.addEventListener("click", async () => {
  if (currentMessages.length === 0) return;
  const copiedIndex = nextCopyIndex;
  if (!await copyText(currentMessages[copiedIndex])) return;
  markCopied(copiedIndex);
  const announcement = currentMessages.length === 1 ? "Output copied" : `Message ${copiedIndex + 1} of ${currentMessages.length} copied`;
  status.textContent = announcement;
  copyNext.textContent = "✓";
  copyNext.classList.add("copied");
  window.setTimeout(() => {
    copyNext.classList.remove("copied");
    updateCopyButton();
  }, 1_400);
});

void render();

function scheduleRender(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { persist(); void render(); }, 80);
}

async function render(): Promise<void> {
  const version = ++renderVersion;
  const value = source.value;
  copiedIndices.clear();
  sourceCount.textContent = Array.from(value).length.toLocaleString();
  clearButton.disabled = value.length === 0;
  outputs.replaceChildren();
  warnings.replaceChildren();

  if (!value.trim()) {
    currentMessages = [];
    nextCopyIndex = 0;
    outputs.append(emptyState("↓"));
    messageCount.textContent = "0";
    status.textContent = "No output";
    copyNext.disabled = true;
    updateCopyButton();
    return;
  }

  outputs.append(emptyState("↓"));
  status.textContent = "Converting";
  let result: ConversionResult;
  try {
    result = await convertInWorker(value, { neutralizeMentions: neutralize.checked });
  } catch {
    if (version === renderVersion) showUiError("Conversion failed. Reload the page and try again.");
    return;
  }
  if (version !== renderVersion) return;
  outputs.replaceChildren();
  currentMessages = result.messages.filter((message) => message.length > 0);
  nextCopyIndex = 0;
  restoreCopyProgress();
  copyNext.disabled = currentMessages.length === 0;
  updateCopyButton();
  messageCount.textContent = currentMessages.length.toLocaleString();

  renderWarnings(result.warnings);
  status.textContent = `${currentMessages.length} ${currentMessages.length === 1 ? "message" : "messages"} ready${result.warnings.length ? ` with ${result.warnings.length} conversion warnings` : ""}.`;
  currentMessages.forEach((message, index) => outputs.append(outputCard(message, index, currentMessages.length)));
  for (const index of copiedIndices) applyCopiedState(index);
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
    copy.append(strong);
    copy.title = matches.length > 1 && code === "unresolved-reference" ? matches.map((match) => match.message).join(" ") : help.action;
    const link = document.createElement("a");
    link.href = help.href;
    link.textContent = "?";
    link.setAttribute("aria-label", `Help: ${help.title}`);
    link.title = help.action;
    item.append(copy, link);
    warnings.append(item);
  }
}

function updateCopyButton(): void {
  const complete = currentMessages.length > 1 && copiedIndices.size === currentMessages.length;
  copyNext.disabled = currentMessages.length === 0 || complete;
  copyNext.textContent = complete
    ? `✓ ${currentMessages.length} / ${currentMessages.length}`
    : currentMessages.length <= 1
      ? "⧉"
      : `⧉ ${nextCopyIndex + 1} / ${currentMessages.length}`;
  const label = complete
    ? `All ${currentMessages.length} messages copied`
    : currentMessages.length <= 1
      ? "Copy output"
      : `Copy message ${nextCopyIndex + 1} of ${currentMessages.length}`;
  copyNext.setAttribute("aria-label", label);
  copyNext.title = label;
}

function outputCard(message: string, index: number, total: number): HTMLElement {
  const card = document.createElement("article");
  card.className = "message-card";
  card.dataset.messageIndex = String(index);
  card.setAttribute("aria-labelledby", `message-${index + 1}-label`);
  const heading = document.createElement("div");
  heading.className = "message-heading";
  const label = document.createElement("span");
  label.id = `message-${index + 1}-label`;
  label.textContent = total === 1 ? "1" : `${index + 1} / ${total}`;
  const count = document.createElement("span");
  count.className = "message-length";
  count.textContent = `${Array.from(message).length.toLocaleString()} / 2,000`;
  heading.append(label, count);

  const pre = document.createElement("pre");
  pre.textContent = message;
  const button = document.createElement("button");
  button.className = "copy-button";
  button.type = "button";
  button.textContent = "⧉";
  button.setAttribute("aria-label", `Copy message${total > 1 ? ` ${index + 1}` : ""}`);
  button.title = `Copy message${total > 1 ? ` ${index + 1}` : ""}`;
  button.addEventListener("click", async () => {
    if (await copyText(message)) {
      showCopied(button, "✓");
      markCopied(index);
      status.textContent = `${total > 1 ? `Message ${index + 1}` : "Output"} copied`;
    }
  });
  card.append(heading, pre, button);
  return card;
}

function convertInWorker(value: string, options: ConvertOptions): Promise<ConversionResult> {
  if (!converterWorker) {
    converterWorker = new Worker(new URL("./converter.worker.ts", import.meta.url), { type: "module" });
    converterWorker.addEventListener("message", (event: MessageEvent<ConversionResponse>) => {
      const pending = pendingConversions.get(event.data.id);
      if (!pending) return;
      pendingConversions.delete(event.data.id);
      pending.resolve(event.data.result);
    });
    converterWorker.addEventListener("error", (event) => {
      const error = new Error(event.message || "Converter worker failed");
      for (const pending of pendingConversions.values()) pending.reject(error);
      pendingConversions.clear();
      converterWorker?.terminate();
      converterWorker = undefined;
    });
  }
  const id = ++nextConversionId;
  return new Promise((resolve, reject) => {
    pendingConversions.set(id, { resolve, reject });
    converterWorker!.postMessage({ id, source: value, options });
  });
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

function markCopied(index: number): void {
  copiedIndices.add(index);
  applyCopiedState(index);
  nextCopyIndex = currentMessages.findIndex((_, candidate) => !copiedIndices.has(candidate));
  if (nextCopyIndex < 0) nextCopyIndex = currentMessages.length;
  saveCopyProgress();
  updateCopyButton();
}
function applyCopiedState(index: number): void {
  const card = outputs.querySelector<HTMLElement>(`[data-message-index="${index}"]`);
  card?.classList.add("message-copied");
  const label = card?.querySelector<HTMLElement>(".message-heading span:first-child");
  if (label && !label.textContent?.startsWith("✓ ")) label.textContent = `✓ ${label.textContent}`;
}
async function loadFile(file: File): Promise<void> {
  if (!isMarkdownFile(file)) { showUiError("Choose a Markdown or plain-text file (.md, .markdown, or .txt)."); return; }
  if (file.size > maxFileBytes) { showUiError("That file is larger than 2 MB. Choose a smaller Markdown file."); return; }
  if (source.value && !window.confirm("Replace the current draft with this file?")) return;
  try {
    source.value = (await file.text()).replace(/^\uFEFF/, "");
    clearedDraft = undefined;
    hideUndo();
    persist();
    await render();
    source.focus();
    status.textContent = `${file.name} loaded locally.`;
  } catch { showUiError("The file could not be read. It was not uploaded."); }
}
function isMarkdownFile(file: File): boolean { return /\.(?:md|markdown|txt)$/i.test(file.name) || ["text/markdown", "text/plain"].includes(file.type); }
function showUiError(message: string): void {
  let error = document.getElementById("input-error");
  if (!error) { error = document.createElement("div"); error.id = "input-error"; error.className = "warning error"; error.setAttribute("role", "alert"); warnings.prepend(error); }
  error.textContent = message;
}
function showUndo(): void {
  window.clearTimeout(undoTimer);
  undoClear.hidden = false;
  undoTimer = window.setTimeout(() => { clearedDraft = undefined; hideUndo(); }, 10_000);
}
function hideUndo(): void { window.clearTimeout(undoTimer); undoClear.hidden = true; }
function progressIdentity(): string {
  let hash = 2166136261;
  const value = `${neutralize.checked}\0${source.value}\0${currentMessages.join("\0")}`;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16);
}
function saveCopyProgress(): void {
  try { sessionStorage.setItem(storage.progress, JSON.stringify({ identity: progressIdentity(), copied: [...copiedIndices] })); } catch { /* Progress remains usable in memory. */ }
}
function restoreCopyProgress(): void {
  copiedIndices.clear();
  try {
    const saved = JSON.parse(sessionStorage.getItem(storage.progress) ?? "null");
    if (saved?.identity === progressIdentity() && Array.isArray(saved.copied)) for (const index of saved.copied) if (Number.isInteger(index) && index >= 0 && index < currentMessages.length) copiedIndices.add(index);
  } catch { /* Ignore malformed or unavailable session state. */ }
  nextCopyIndex = currentMessages.findIndex((_, index) => !copiedIndices.has(index));
  if (nextCopyIndex < 0) nextCopyIndex = currentMessages.length;
}
function persist(): void {
  try {
    sessionStorage.setItem(storage.source, source.value);
    localStorage.setItem(storage.neutralize, String(neutralize.checked));
  } catch { /* Conversion remains usable when storage is blocked. */ }
}
function restorePreferences(): void {
  try {
    localStorage.removeItem("markdown-to-discord:draft");
    source.value = sessionStorage.getItem(storage.source) ?? "";
    const savedNeutralize = localStorage.getItem(storage.neutralize);
    if (savedNeutralize !== null) neutralize.checked = savedNeutralize !== "false";
  } catch { /* Use HTML defaults when storage is blocked. */ }
}
function removeStoredDraft(): void {
  try { sessionStorage.removeItem(storage.source); sessionStorage.removeItem(storage.progress); } catch { /* Nothing else to clear. */ }
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
