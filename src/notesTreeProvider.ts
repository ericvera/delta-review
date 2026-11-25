import { basename, dirname } from "node:path";
import * as vscode from "vscode";
import type { NoteDocument } from "./notes";
import {
  documentNoteGroupDescription,
  groupNoteThreads,
  notesGroupCollapseKey,
} from "./notesGrouping";
import {
  type AnyNoteThread,
  isFileThread,
  isGeneralThread,
  isLineThread,
  type ThreadStatus,
} from "./noteThreads";

// REVIEW NOTES tree: notes grouped by file, rendered as a sibling SCM section
// of the DELTA REVIEW view. Deliberately decoupled from ReviewTreeProvider —
// its own element union and provider class, so the main view's rendering is
// never touched by notes work.

export interface NotesGeneralGroupElement {
  kind: "generalGroup";
  threads: AnyNoteThread[];
}

export interface NotesFileGroupElement {
  kind: "fileGroup";
  document?: NoteDocument;
  // Repo-relative path, '/'-separated (git style); for a document group, the
  // file name inside the cluster notes dir
  file: string;
  // File notes first, then line notes by current position
  threads: AnyNoteThread[];
}

export interface NoteRowElement {
  kind: "note";
  thread: AnyNoteThread;
}

export type NotesTreeElement =
  NotesGeneralGroupElement | NotesFileGroupElement | NoteRowElement;

export const notesCollapseKeyFor = (
  element: NotesGeneralGroupElement | NotesFileGroupElement,
): string =>
  element.kind === "generalGroup"
    ? notesGroupCollapseKey({ kind: "general" })
    : notesGroupCollapseKey({ ...element, kind: "file" });

const MAX_LABEL_LENGTH = 60;

// Row label: first line of the original note text, truncated to keep rows
// compact (the tooltip carries the full text)
const noteLabel = (thread: AnyNoteThread): string => {
  const firstLine = (thread.turns[0]?.text ?? "").split("\n", 1)[0] ?? "";
  return firstLine.length > MAX_LABEL_LENGTH
    ? `${firstLine.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`
    : firstLine;
};

// Status icons: filled dot = open (yours to follow up), outline = addressed
// (awaiting you — no half-full codicon exists), clock = pending (answered,
// work still queued; purple while unread, dimmed once read — a ThemeIcon
// cannot carry an unread-dot overlay), check = resolved
const noteIcon = (status: ThreadStatus, unread: boolean): vscode.ThemeIcon => {
  switch (status) {
    case "open":
      return new vscode.ThemeIcon(
        "circle-large-filled",
        new vscode.ThemeColor("charts.blue"),
      );
    case "addressed":
      return new vscode.ThemeIcon(
        "circle-large-outline",
        new vscode.ThemeColor("charts.yellow"),
      );
    case "pending":
      return new vscode.ThemeIcon(
        "clock",
        new vscode.ThemeColor(unread ? "charts.purple" : "disabledForeground"),
      );
    case "resolved":
      return new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("charts.green"),
      );
  }
};

export class NotesTreeProvider implements vscode.TreeDataProvider<NotesTreeElement> {
  private threads: AnyNoteThread[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<
    NotesTreeElement | undefined
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly isCollapsed: (key: string) => boolean,
    private readonly isUnread: (thread: AnyNoteThread) => boolean,
    private readonly documentLabel: (
      document: NoteDocument,
      file: string,
    ) => string,
  ) {}

  setThreads(threads: AnyNoteThread[]): void {
    this.threads = threads;
    this.changeEmitter.fire(undefined);
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getChildren(element?: NotesTreeElement): NotesTreeElement[] {
    if (element === undefined) {
      // With no notes this returns [] — never a message row — so the
      // viewsWelcome empty state renders
      return groupNoteThreads(this.threads).map(
        (group): NotesGeneralGroupElement | NotesFileGroupElement =>
          group.kind === "general"
            ? { kind: "generalGroup", threads: group.threads }
            : { ...group, kind: "fileGroup" },
      );
    }
    if (element.kind === "generalGroup" || element.kind === "fileGroup") {
      return element.threads.map((thread): NoteRowElement => ({
        kind: "note",
        thread,
      }));
    }
    return [];
  }

  getTreeItem(element: NotesTreeElement): vscode.TreeItem {
    if (element.kind === "generalGroup") {
      const item = new vscode.TreeItem(
        "General notes",
        this.isCollapsed(notesCollapseKeyFor(element))
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon("comment-discussion");
      item.description = String(element.threads.length);
      item.id = "notesGeneral";
      return item;
    }
    if (element.kind === "fileGroup" && element.document !== undefined) {
      const item = new vscode.TreeItem(
        this.documentLabel(element.document, element.file),
        this.isCollapsed(notesCollapseKeyFor(element))
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = documentNoteGroupDescription(
        element.document,
        element.threads.length,
      );
      const tooltip = new vscode.MarkdownString();
      tooltip.appendCodeblock(element.file, "text");
      item.tooltip = tooltip;
      item.id = `notesFile:${element.document}:${element.file}`;
      return item;
    }
    if (element.kind === "fileGroup") {
      const item = new vscode.TreeItem(
        basename(element.file),
        this.isCollapsed(notesCollapseKeyFor(element))
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      // Directory + note count as dim description text; the count includes
      // resolved notes — the group reflects everything recorded on the file
      const directory = dirname(element.file);
      const count = String(element.threads.length);
      item.description = directory === "." ? count : `${directory} · ${count}`;
      const tooltip = new vscode.MarkdownString();
      tooltip.appendCodeblock(element.file, "text");
      item.tooltip = tooltip;
      item.id = `notesFile:${element.file}`;
      return item;
    }

    const { thread } = element;
    const unread = this.isUnread(thread);
    const label = noteLabel(thread);
    const item = new vscode.TreeItem(
      unread ? { label, highlights: [[0, label.length]] } : label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `note:${thread.note.id}`;
    item.iconPath = noteIcon(thread.status, unread);
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(thread.turns[0]?.text ?? "");
    tooltip.appendMarkdown(
      `\n\nStatus: ${thread.status}${unread ? " (unread)" : ""}`,
    );
    if (isGeneralThread(thread)) {
      tooltip.appendMarkdown(
        "\n\nGeneral note · click to open its conversation",
      );
    } else if (isFileThread(thread)) {
      item.description = thread.note.outdated ? "file ⚠" : "file";
      if (thread.note.outdated) {
        tooltip.appendMarkdown("\n\n⚠ Outdated — the file left the diff");
      }
    } else if (isLineThread(thread)) {
      const descriptionParts = [`:${thread.note.currentStartLine}`];
      if (thread.note.side === "base") {
        descriptionParts.push("base");
      }
      if (thread.note.outdated) {
        descriptionParts.push("⚠");
      }
      item.description = descriptionParts.join(" ");
      if (thread.note.outdated) {
        tooltip.appendMarkdown(
          "\n\n⚠ Outdated — the noted lines changed since the note was written",
        );
      }
    }
    item.tooltip = tooltip;
    item.contextValue = unread
      ? "noteRow-pendingUnread"
      : `noteRow-${thread.status}`;
    item.command = isGeneralThread(thread)
      ? {
          command: "deltaReview.openGeneralNote",
          title: "Open General Note",
          arguments: [thread],
        }
      : {
          command: "deltaReview.openNoteInDiff",
          title: "Open Note in Diff",
          arguments: [thread],
        };
    return item;
  }
}
