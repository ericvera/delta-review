import type { GeneralNote } from "./notes";
import type { NoteThread, ThreadStatus } from "./noteThreads";

// HTML for the general-note conversation tab. Pure module — no vscode; the
// panel supplies pre-rendered markdown bodies, the nonce and the CSP source.

export type NotesKey = { repo: string; branch: string };

export type GeneralNoteMessageType =
  "reply" | "resolve" | "unresolve" | "delete" | "markRead" | "add" | "cancel";

export interface GeneralNoteHtmlInput {
  mode: "note" | "draft";
  thread?: NoteThread<GeneralNote>;
  unread: boolean;
  branch: string;
  // One pre-rendered body per turn, in turn order
  bodiesHtml: string[];
  nonce: string;
  cspSource: string;
  now: Date;
}

const MAX_TITLE_LENGTH = 40;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const statusLabels: Record<ThreadStatus, string> = {
  open: "Open",
  addressed: "Addressed",
  pending: "Pending",
  resolved: "Resolved",
};

export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Double-quoted attribute values only: single quotes stay literal so the CSP
// keywords read as written
const escapeAttribute = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const plainTextHtml = (text: string): string =>
  `<p>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</p>`;

export const sameNotesKey = (a: NotesKey, b: NotesKey): boolean =>
  a.repo === b.repo && a.branch === b.branch;

const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";

export const generalNoteTitle = (text: string): string => {
  const line = firstLine(text);
  return line.length > MAX_TITLE_LENGTH
    ? `${line.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : line;
};

const pad = (value: number): string => String(value).padStart(2, "0");

// Local time, `d MMM HH:mm`; an unparsable timestamp is shown verbatim
export const formatCreated = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const formatRelative = (iso: string, now: Date): string => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return iso;
  }
  const minutes = Math.floor((now.getTime() - at) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.floor(hours / 24)} d ago`;
};

const statusColor = (status: ThreadStatus, unread: boolean): string => {
  switch (status) {
    case "open":
      return "var(--vscode-charts-blue)";
    case "addressed":
      return "var(--vscode-charts-yellow)";
    case "pending":
      return unread
        ? "var(--vscode-charts-purple)"
        : "var(--vscode-disabledForeground)";
    case "resolved":
      return "var(--vscode-charts-green)";
  }
};

// Rendered note bodies pass raw HTML through, so a body could carry its own
// `data-action` element. Only elements stamped with this render's nonce are
// wired up, which a note body cannot know in advance.
const button = (
  nonce: string,
  action: GeneralNoteMessageType,
  label: string,
  kind: "primary" | "secondary" | "link",
): string =>
  `<button type="button" class="${kind}" data-action="${action}" data-control="${escapeAttribute(nonce)}">${escapeHtml(label)}</button>`;

const styles = `
body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 12px 20px; }
h1 { display: flex; align-items: center; gap: 8px; font-size: 1.3em; font-weight: 600; margin: 0 0 4px; }
h1 .title { overflow-wrap: anywhere; }
.actions { margin-left: auto; display: flex; gap: 4px; flex-shrink: 0; }
.pill { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--status-color); color: var(--status-color); white-space: nowrap; }
.meta { color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
.thread { border-left: 3px solid var(--status-color); background: var(--vscode-editorWidget-background); border-radius: 3px; }
.thread.unread { background: color-mix(in srgb, var(--vscode-charts-purple) 10%, var(--vscode-editorWidget-background)); }
.turn { display: grid; grid-template-columns: 28px 1fr; column-gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
.avatar { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.turn.agent .avatar { background: var(--vscode-charts-purple); }
.who { font-weight: 600; }
.when { color: var(--vscode-descriptionForeground); font-weight: 400; margin-left: 6px; }
.body { grid-column: 2; overflow-wrap: anywhere; }
.body p:first-child { margin-top: 4px; }
.body p:last-child { margin-bottom: 0; }
.body code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
.body pre { background: var(--vscode-textCodeBlock-background); padding: 8px; overflow-x: auto; }
.body pre code { background: none; padding: 0; }
.body a { color: var(--vscode-textLink-foreground); }
.reply { padding: 10px 12px; }
textarea { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical; font-family: inherit; font-size: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 6px; }
textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.buttons { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
button { font-family: inherit; font-size: inherit; border: none; border-radius: 2px; padding: 4px 12px; cursor: pointer; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.link { background: none; color: var(--vscode-descriptionForeground); padding: 2px 6px; }
button.link:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
`;

const script = (nonce: string): string => `
const vscode = acquireVsCodeApi();
const box = document.getElementById("text");
const saved = vscode.getState();
if (box && saved && typeof saved.text === "string") { box.value = saved.text; }
if (box) { box.addEventListener("input", () => vscode.setState({ text: box.value })); }
const control = ${JSON.stringify(nonce)};
for (const el of document.querySelectorAll("[data-action][data-control]")) {
  if (el.dataset.control !== control) { continue; }
  el.addEventListener("click", () => {
    const type = el.dataset.action;
    if (type === "reply" || type === "add") {
      const text = box ? box.value.trim() : "";
      if (text === "") { if (box) { box.focus(); } return; }
      vscode.postMessage({ type, text });
      return;
    }
    vscode.postMessage({ type });
  });
}
window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "sent" && box) {
    box.value = "";
    vscode.setState({ text: "" });
  }
});
`;

const page = (
  input: GeneralNoteHtmlInput,
  statusColorValue: string,
  content: string,
): string => {
  const csp = `default-src 'none'; style-src ${input.cspSource} 'unsafe-inline'; script-src 'nonce-${input.nonce}'; img-src ${input.cspSource} https: data:`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>:root { --status-color: ${statusColorValue}; }${styles}</style>
</head>
<body>
${content}
<script nonce="${escapeAttribute(input.nonce)}">${script(input.nonce)}</script>
</body>
</html>`;
};

const draftContent = (input: GeneralNoteHtmlInput): string => `
<h1><span class="title">New General note</span></h1>
<div class="meta">Not tied to a file · branch ${escapeHtml(input.branch)}</div>
<div class="thread">
<div class="reply">
<textarea id="text" placeholder="What should the agent look at?"></textarea>
<div class="buttons">${button(input.nonce, "cancel", "Cancel", "secondary")}${button(input.nonce, "add", "Add Note", "primary")}</div>
</div>
</div>`;

const noteContent = (
  input: GeneralNoteHtmlInput,
  thread: NoteThread<GeneralNote>,
): string => {
  const resolved = thread.status === "resolved";
  const pill = statusLabels[thread.status] + (input.unread ? " • Unread" : "");
  const turns = thread.turns
    .map((turn, index) => {
      const author = turn.author === "agent" ? "Agent" : "You";
      return `<div class="turn ${turn.author}">
<div class="avatar">${author.charAt(0)}</div>
<div class="who">${author}<span class="when">${escapeHtml(formatRelative(turn.at, input.now))}</span></div>
<div class="body">${input.bodiesHtml[index] ?? ""}</div>
</div>`;
    })
    .join("\n");
  const footer =
    (input.unread
      ? button(input.nonce, "markRead", "Mark Read", "secondary")
      : "") + button(input.nonce, "reply", "Reply", "primary");
  return `
<h1><span class="title">${escapeHtml(firstLine(thread.turns[0]?.text ?? ""))}</span><span class="pill">${escapeHtml(pill)}</span>
<span class="actions">${resolved ? button(input.nonce, "unresolve", "↺ Unresolve", "link") : button(input.nonce, "resolve", "✓ Resolve", "link")}${button(input.nonce, "delete", "🗑 Delete", "link")}</span></h1>
<div class="meta">General note · branch ${escapeHtml(input.branch)} · created ${escapeHtml(formatCreated(thread.note.createdAt))}</div>
<div class="thread${input.unread ? " unread" : ""}">
${turns}
<div class="reply">
<textarea id="text" placeholder="Reply..."></textarea>
<div class="buttons">${footer}</div>
</div>
</div>`;
};

export const renderGeneralNoteHtml = (input: GeneralNoteHtmlInput): string => {
  if (input.mode === "draft" || input.thread === undefined) {
    return page(input, "var(--vscode-focusBorder)", draftContent(input));
  }
  return page(
    input,
    statusColor(input.thread.status, input.unread),
    noteContent(input, input.thread),
  );
};
