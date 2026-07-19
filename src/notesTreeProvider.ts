import { basename, dirname } from "node:path";
import * as vscode from "vscode";
import type { NoteStatus } from "./notes";
import type { NoteThread } from "./noteThreads";

// REVIEW NOTES tree: notes grouped by file, rendered as a sibling SCM section
// of the DELTA REVIEW view. Deliberately decoupled from ReviewTreeProvider —
// its own element union and provider class, so the main view's rendering is
// never touched by notes work.

export interface NotesFileGroupElement {
  kind: "fileGroup";
  // Repo-relative path, '/'-separated (git style)
  file: string;
  // This file's threads, sorted by current position
  threads: NoteThread[];
}

export interface NoteRowElement {
  kind: "note";
  thread: NoteThread;
}

export type NotesTreeElement = NotesFileGroupElement | NoteRowElement;

// Collapse keys share the main view's persisted set; the `notes:` namespace
// can never collide with its status/cluster/folder keys.
export const notesCollapseKeyFor = (element: NotesFileGroupElement): string =>
  `notes:${element.file}`;

const MAX_LABEL_LENGTH = 60;

// Row label: first line of the original note text, truncated to keep rows
// compact (the tooltip carries the full text)
const noteLabel = (thread: NoteThread): string => {
  const firstLine = (thread.turns[0]?.text ?? "").split("\n", 1)[0] ?? "";
  return firstLine.length > MAX_LABEL_LENGTH
    ? `${firstLine.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`
    : firstLine;
};

// Status icons: filled dot = open (yours to follow up), outline = addressed
// (awaiting you — no half-full codicon exists), check = resolved
const noteIcon = (status: NoteStatus): vscode.ThemeIcon => {
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
    case "resolved":
      return new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("charts.green"),
      );
  }
};

export class NotesTreeProvider implements vscode.TreeDataProvider<NotesTreeElement> {
  private threads: NoteThread[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<
    NotesTreeElement | undefined
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly isCollapsed: (key: string) => boolean) {}

  setThreads(threads: NoteThread[]): void {
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
      const byFile = new Map<string, NoteThread[]>();
      for (const thread of this.threads) {
        const group = byFile.get(thread.note.file);
        if (group === undefined) {
          byFile.set(thread.note.file, [thread]);
        } else {
          group.push(thread);
        }
      }
      return [...byFile.entries()]
        .sort(([pathA], [pathB]) => (pathA < pathB ? -1 : 1))
        .map(([file, threads]): NotesFileGroupElement => ({
          kind: "fileGroup",
          file,
          threads: [...threads].sort(
            (a, b) => a.note.currentStartLine - b.note.currentStartLine,
          ),
        }));
    }
    if (element.kind === "fileGroup") {
      return element.threads.map((thread): NoteRowElement => ({
        kind: "note",
        thread,
      }));
    }
    return [];
  }

  getTreeItem(element: NotesTreeElement): vscode.TreeItem {
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
    const item = new vscode.TreeItem(
      noteLabel(thread),
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `note:${thread.note.id}`;
    item.iconPath = noteIcon(thread.status);
    const descriptionParts = [`:${thread.note.currentStartLine}`];
    if (thread.note.side === "base") {
      descriptionParts.push("base");
    }
    if (thread.note.outdated) {
      descriptionParts.push("⚠");
    }
    item.description = descriptionParts.join(" ");
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(thread.turns[0]?.text ?? "");
    tooltip.appendMarkdown(`\n\nStatus: ${thread.status}`);
    if (thread.note.outdated) {
      tooltip.appendMarkdown(
        "\n\n⚠ Outdated — the noted lines changed since the note was written",
      );
    }
    item.tooltip = tooltip;
    item.contextValue = `noteRow-${thread.status}`;
    item.command = {
      command: "deltaReview.openNoteInDiff",
      title: "Open Note in Diff",
      arguments: [thread],
    };
    return item;
  }
}
