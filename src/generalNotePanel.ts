import { randomBytes, randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  generalNoteTitle,
  plainTextHtml,
  renderGeneralNoteHtml,
  sameNotesKey,
} from "./generalNoteHtml";
import type { GeneralNoteMessageType, NotesKey } from "./generalNoteHtml";
import { createGit } from "./git";
import { isGeneralNote } from "./notes";
import type { GeneralNote } from "./notes";
import { isGeneralThread } from "./noteThreads";
import type { AnyNoteThread, NoteThread } from "./noteThreads";
import {
  appendReviewerTurn,
  createNote,
  deleteNote,
  setResolved,
} from "./notesStore";

// One editor tab per general note: renders the conversation, routes the
// webview's buttons to the notes store of the repo and branch the tab was
// opened on, and closes the tab once its note disappears.

export interface GeneralNoteContext {
  repoRoot: string;
  // Raw branch for store calls
  storeBranch: string;
  // Matches the extension's notesKey (tag-shadow prefix stripped)
  key: NotesKey;
}

export interface GeneralNotePanelDeps {
  markdownToHtml: (text: string) => Promise<string>;
  isUnread: (thread: AnyNoteThread) => boolean;
  markRead: (thread: AnyNoteThread) => void;
  onDidChangeNotes: () => void;
}

export interface GeneralNotePanels {
  open: (thread: NoteThread<GeneralNote>, ctx: GeneralNoteContext) => void;
  openDraft: (ctx: GeneralNoteContext) => void;
  update: (threads: readonly AnyNoteThread[], key: NotesKey) => void;
  list: () => { noteId: string; mode: "note" | "draft"; title: string }[];
}

interface PanelEntry {
  noteId: string;
  panel: vscode.WebviewPanel;
  ctx: GeneralNoteContext;
  mode: "note" | "draft";
  thread?: NoteThread<GeneralNote>;
  signature?: string;
  // Set by Add Note: a refresh that started before the create can land
  // after it and must not close the tab of a note it has not seen yet
  awaitingFirstLoad: boolean;
  busy: boolean;
  renderToken: number;
}

const DRAFT_TITLE = "New General note";

const messageTypes = new Set<GeneralNoteMessageType>([
  "reply",
  "resolve",
  "unresolve",
  "delete",
  "markRead",
  "add",
  "cancel",
]);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const renderMarkdown = async (text: string): Promise<string> => {
  try {
    const html = await vscode.commands.executeCommand<unknown>(
      "markdown.api.render",
      text,
    );
    return typeof html === "string" ? html : plainTextHtml(text);
  } catch {
    return plainTextHtml(text);
  }
};

const threadTitle = (thread: NoteThread<GeneralNote>): string =>
  generalNoteTitle(thread.turns[0]?.text ?? "");

const signatureFor = (
  thread: NoteThread<GeneralNote>,
  unread: boolean,
): string =>
  [
    thread.turns.length,
    thread.turns[thread.turns.length - 1]?.at ?? "",
    thread.status,
    unread,
  ].join("|");

const threadFromNote = (note: GeneralNote): NoteThread<GeneralNote> => ({
  note,
  turns: note.turns.map((turn) => ({
    author: "reviewer",
    text: turn.text,
    at: turn.at,
  })),
  status: "open",
});

export const createGeneralNotePanels = (
  deps: GeneralNotePanelDeps,
): GeneralNotePanels & vscode.Disposable => {
  const panels = new Map<string, PanelEntry>();

  const render = async (entry: PanelEntry): Promise<void> => {
    const token = ++entry.renderToken;
    const thread = entry.mode === "note" ? entry.thread : undefined;
    const unread = thread !== undefined && deps.isUnread(thread);
    if (thread !== undefined) {
      entry.signature = signatureFor(thread, unread);
    }
    const bodiesHtml =
      thread === undefined
        ? []
        : await Promise.all(
            thread.turns.map((turn) => deps.markdownToHtml(turn.text)),
          );
    // A newer render or a dispose overtook this one while markdown rendered
    if (token !== entry.renderToken || panels.get(entry.noteId) !== entry) {
      return;
    }
    entry.panel.title =
      thread === undefined ? DRAFT_TITLE : threadTitle(thread);
    entry.panel.webview.html = renderGeneralNoteHtml({
      mode: entry.mode,
      thread,
      unread,
      branch: entry.ctx.key.branch,
      bodiesHtml,
      nonce: randomBytes(16).toString("base64"),
      cspSource: entry.panel.webview.cspSource,
      now: new Date(),
    });
  };

  const run = async (
    action: string,
    work: () => Promise<void>,
  ): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Delta Review: failed to ${action} (${errorText(error)})`,
      );
      return false;
    }
  };

  const handleMessage = async (
    entry: PanelEntry,
    type: GeneralNoteMessageType,
    text: string | undefined,
  ): Promise<void> => {
    const git = createGit(entry.ctx.repoRoot);
    const branch = entry.ctx.storeBranch;
    const thread = entry.thread;
    switch (type) {
      case "cancel":
        entry.panel.dispose();
        return;
      case "add": {
        if (entry.mode !== "draft" || text === undefined) {
          return;
        }
        let created: GeneralNote | undefined;
        const ok = await run("add note", async () => {
          const note = await createNote(git, branch, {
            scope: "general",
            text,
            id: entry.noteId,
          });
          if (isGeneralNote(note)) {
            created = note;
          }
        });
        if (!ok || created === undefined) {
          return;
        }
        void entry.panel.webview.postMessage({ type: "sent" });
        entry.mode = "note";
        entry.thread = threadFromNote(created);
        entry.awaitingFirstLoad = true;
        void render(entry);
        deps.onDidChangeNotes();
        return;
      }
      case "reply":
        if (thread === undefined || text === undefined) {
          return;
        }
        if (
          await run("reply", async () => {
            await appendReviewerTurn(git, branch, thread.note.id, text);
          })
        ) {
          void entry.panel.webview.postMessage({ type: "sent" });
          deps.onDidChangeNotes();
        }
        return;
      case "resolve":
      case "unresolve": {
        if (thread === undefined) {
          return;
        }
        const resolved = type === "resolve";
        if (
          await run(`${type} note`, async () => {
            await setResolved(git, branch, thread.note.id, resolved);
          })
        ) {
          deps.onDidChangeNotes();
        }
        return;
      }
      case "delete": {
        if (thread === undefined) {
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          "Delete this review note and all its replies?",
          { modal: true },
          "Delete",
        );
        if (choice !== "Delete") {
          return;
        }
        if (
          await run("delete note", async () => {
            await deleteNote(git, branch, thread.note.id);
          })
        ) {
          entry.panel.dispose();
          deps.onDidChangeNotes();
        }
        return;
      }
      case "markRead":
        if (thread === undefined) {
          return;
        }
        deps.markRead(thread);
        void render(entry);
        return;
    }
  };

  const createPanel = (
    noteId: string,
    ctx: GeneralNoteContext,
    mode: "note" | "draft",
    thread?: NoteThread<GeneralNote>,
  ): void => {
    const panel = vscode.window.createWebviewPanel(
      "deltaReview.generalNote",
      thread === undefined ? DRAFT_TITLE : threadTitle(thread),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    panel.iconPath = new vscode.ThemeIcon("comment-discussion");
    const entry: PanelEntry = {
      noteId,
      panel,
      ctx,
      mode,
      thread,
      awaitingFirstLoad: false,
      busy: false,
      renderToken: 0,
    };
    panels.set(noteId, entry);
    panel.onDidDispose(() => {
      if (panels.get(noteId) === entry) {
        panels.delete(noteId);
      }
    });
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (typeof message !== "object" || message === null) {
        return;
      }
      const { type, text } = message as { type?: unknown; text?: unknown };
      if (
        typeof type !== "string" ||
        !messageTypes.has(type as GeneralNoteMessageType)
      ) {
        return;
      }
      const trimmed = typeof text === "string" ? text.trim() : undefined;
      if ((type === "reply" || type === "add") && !trimmed) {
        return;
      }
      if (entry.busy) {
        return;
      }
      entry.busy = true;
      try {
        await handleMessage(entry, type as GeneralNoteMessageType, trimmed);
      } finally {
        entry.busy = false;
      }
    });
    void render(entry);
  };

  return {
    open: (thread, ctx) => {
      const existing = panels.get(thread.note.id);
      if (existing !== undefined) {
        existing.panel.reveal();
        return;
      }
      createPanel(thread.note.id, ctx, "note", thread);
    },
    openDraft: (ctx) => {
      createPanel(randomUUID(), ctx, "draft");
    },
    update: (threads, key) => {
      for (const entry of [...panels.values()]) {
        if (entry.mode === "draft" || !sameNotesKey(entry.ctx.key, key)) {
          continue;
        }
        const thread = threads.find(
          (candidate) => candidate.note.id === entry.noteId,
        );
        if (thread === undefined || !isGeneralThread(thread)) {
          if (!entry.awaitingFirstLoad) {
            entry.panel.dispose();
          }
          continue;
        }
        entry.awaitingFirstLoad = false;
        entry.thread = thread;
        if (signatureFor(thread, deps.isUnread(thread)) !== entry.signature) {
          void render(entry);
        }
      }
    },
    list: () =>
      [...panels.values()].map((entry) => ({
        noteId: entry.noteId,
        mode: entry.mode,
        title: entry.panel.title,
      })),
    dispose: () => {
      for (const entry of [...panels.values()]) {
        entry.panel.dispose();
      }
    },
  };
};
