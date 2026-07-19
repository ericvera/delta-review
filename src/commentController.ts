import { isAbsolute, join, relative, sep } from "node:path";
import * as vscode from "vscode";
import { createReviewBaseUri, REVIEW_BASE_SCHEME } from "./contentProvider";
import { Git } from "./git";
import { ReviewFile, ReviewModel } from "./model";
import { Note, NoteSide, NoteStatus } from "./notes";
import { NoteThread } from "./noteThreads";
import { createNote } from "./notesStore";

// Inline review notes in the diff editor, built on the VS Code Comments API:
// the `+` commenting gutter on both diff sides, the add-note flow persisting
// through the notes store, and rendering of existing threads with status
// labels. Model/git access is injected as callbacks so the controller always
// sees the extension's current state.

// The path shown on the left (base) side of a review file's diff — for a
// move diffed against the merge base the base blob came from the old path
// (mirrors openDiff's leftPath).
export const reviewBasePathFor = (file: ReviewFile): string =>
  file.diffBaseIsReviewedSnapshot ? file.path : (file.movedFrom ?? file.path);

// The blob currently displayed as the base document for a given base-side
// path; undefined when no review-set file shows that path on its left side.
export const baseBlobForPath = (
  model: ReviewModel,
  path: string,
): string | undefined =>
  model.files.find((file) => reviewBasePathFor(file) === path)?.diffBaseSha;

const statusLabels: Record<NoteStatus, string> = {
  open: "Open",
  addressed: "Addressed",
  resolved: "Resolved",
};

const statusContextValues: Record<NoteStatus, string> = {
  open: "openNote",
  addressed: "addressedNote",
  resolved: "resolvedNote",
};

export interface NoteCommentController extends vscode.Disposable {
  // Reconciles rendered comment threads with the given display threads
  renderThreads: (threads: NoteThread[]) => void;
  // Handler for the deltaReview.addNote comment-input command
  addNote: (reply: vscode.CommentReply) => Promise<void>;
}

export const createNoteCommentController = (
  getGit: () => Git | undefined,
  getModel: () => ReviewModel | undefined,
  onDidChangeNotes: () => void,
): NoteCommentController => {
  const controller = vscode.comments.createCommentController(
    "deltaReview.notes",
    "Delta Review Notes",
  );
  controller.options = { placeHolder: "Add a review note…" };

  // Repo-relative `/`-separated path for a file: uri inside the repo;
  // undefined for anything outside it
  const repoRelativePath = (git: Git, uri: vscode.Uri): string | undefined => {
    const relativePath = relative(git.repoRoot, uri.fsPath);
    if (
      relativePath === "" ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    ) {
      return undefined;
    }
    return relativePath.split(sep).join("/");
  };

  controller.commentingRangeProvider = {
    provideCommentingRanges: (document) => {
      // Runs for every open document — return fast for foreign schemes
      const scheme = document.uri.scheme;
      if (scheme !== "file" && scheme !== REVIEW_BASE_SCHEME) {
        return [];
      }
      const git = getGit();
      const model = getModel();
      if (git === undefined || model === undefined) {
        return [];
      }
      // The provider offers the whole document; a multi-line selection then
      // drives the range of a created note
      const fullDocument = [
        new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0),
      ];
      if (scheme === "file") {
        const path = repoRelativePath(git, document.uri);
        return path !== undefined &&
          model.files.some((file) => file.path === path && !file.deleted)
          ? fullDocument
          : [];
      }
      // Base documents are commentable only while they are the diff's
      // current base — stale snapshot docs get no new commenting ranges
      if (document.uri.query === "empty") {
        return [];
      }
      const path = document.uri.path.slice(1);
      return model.files.some(
        (file) =>
          reviewBasePathFor(file) === path &&
          file.diffBaseSha === document.uri.query,
      )
        ? fullDocument
        : [];
    },
  };

  const commentsFor = (thread: NoteThread): vscode.Comment[] =>
    thread.turns.map((turn, index) => {
      const body = new vscode.MarkdownString();
      body.appendText(turn.text);
      if (index === 0 && thread.note.outdated) {
        body.appendMarkdown("\n\n*Line was:*\n");
        body.appendCodeblock(thread.note.snapshot.join("\n"));
      }
      return {
        body,
        mode: vscode.CommentMode.Preview,
        author: { name: turn.author === "reviewer" ? "You" : "Claude" },
        timestamp: new Date(turn.at),
      };
    });

  const styleThread = (
    commentThread: vscode.CommentThread,
    thread: NoteThread,
  ): void => {
    commentThread.comments = commentsFor(thread);
    commentThread.label =
      statusLabels[thread.status] + (thread.note.outdated ? " • Outdated" : "");
    commentThread.contextValue = statusContextValues[thread.status];
    commentThread.state =
      thread.status === "resolved"
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
    // Replying goes through addNote on empty pending threads only for now
    commentThread.canReply = false;
  };

  // A CommentThread renders only on an exactly matching URI. Base-side
  // threads attach to the *currently displayed* base document (the model's
  // diffBaseSha travels in the uri query), not the creation blob — otherwise
  // the thread would vanish the moment mark-reviewed advances the base.
  const threadUriFor = (
    git: Git,
    model: ReviewModel | undefined,
    note: Note,
  ): vscode.Uri => {
    if (note.side === "working") {
      const file = model?.files.find((entry) => entry.path === note.file);
      // A deleted file's diff shows the empty base uri on the right — the
      // thread must attach there or it could never render in that diff
      return file?.deleted === true
        ? createReviewBaseUri(note.file, undefined)
        : vscode.Uri.file(join(git.repoRoot, note.file));
    }
    const currentBase =
      model === undefined ? undefined : baseBlobForPath(model, note.file);
    // No current base (file left the review set): fall back to the creation
    // blob so the thread still has a stable home
    return createReviewBaseUri(note.file, currentBase ?? note.contentBlob);
  };

  // Rendered threads by note id; uriKey detects base-sha changes (thread
  // URIs are immutable, so those need dispose + recreate)
  const threadCache = new Map<
    string,
    { thread: vscode.CommentThread; uriKey: string }
  >();

  const renderThreads = (threads: NoteThread[]): void => {
    const git = getGit();
    if (git === undefined) {
      for (const entry of threadCache.values()) {
        entry.thread.dispose();
      }
      threadCache.clear();
      return;
    }
    const model = getModel();
    const rendered = new Set<string>();
    for (const thread of threads) {
      rendered.add(thread.note.id);
      const uri = threadUriFor(git, model, thread.note);
      const uriKey = uri.toString();
      const range = new vscode.Range(
        thread.note.currentStartLine - 1,
        0,
        thread.note.currentEndLine - 1,
        0,
      );
      let entry = threadCache.get(thread.note.id);
      if (entry !== undefined && entry.uriKey !== uriKey) {
        entry.thread.dispose();
        entry = undefined;
      }
      if (entry === undefined) {
        const created = controller.createCommentThread(uri, range, []);
        created.collapsibleState =
          vscode.CommentThreadCollapsibleState.Expanded;
        entry = { thread: created, uriKey };
        threadCache.set(thread.note.id, entry);
      } else {
        entry.thread.range = range;
      }
      styleThread(entry.thread, thread);
    }
    for (const [noteId, entry] of threadCache) {
      if (!rendered.has(noteId)) {
        entry.thread.dispose();
        threadCache.delete(noteId);
      }
    }
  };

  const addNote = async (reply: vscode.CommentReply): Promise<void> => {
    const git = getGit();
    const model = getModel();
    const pending = reply.thread;
    const uri = pending.uri;
    if (git === undefined || model === undefined) {
      void vscode.window.showErrorMessage(
        "Delta Review: failed to save note (no active review)",
      );
      return;
    }
    let side: NoteSide;
    let path: string | undefined;
    if (uri.scheme === REVIEW_BASE_SCHEME) {
      side = "base";
      path = uri.path.slice(1);
    } else {
      side = "working";
      path = repoRelativePath(git, uri);
    }
    const document = vscode.workspace.textDocuments.find(
      (entry) => entry.uri.toString() === uri.toString(),
    );
    if (path === undefined || document === undefined) {
      void vscode.window.showErrorMessage(
        "Delta Review: failed to save note (document is not part of the review)",
      );
      return;
    }
    const range = pending.range ?? new vscode.Range(0, 0, 0, 0);
    const startLine = Math.min(range.start.line, document.lineCount - 1);
    const endLine = Math.min(range.end.line, document.lineCount - 1);
    const snapshot: string[] = [];
    for (let line = startLine; line <= endLine; line++) {
      snapshot.push(document.lineAt(line).text);
    }
    try {
      const note = await createNote(git, model.branch, {
        file: path,
        side,
        startLine: startLine + 1,
        endLine: endLine + 1,
        snapshot,
        content: document.getText(),
        text: reply.text,
      });
      // Adopt the pending thread as the note's rendered thread (disposing +
      // recreating would make the input UX flicker)
      threadCache.set(note.id, { thread: pending, uriKey: uri.toString() });
      pending.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      styleThread(pending, {
        note,
        turns: [{ author: "reviewer", text: reply.text, at: note.createdAt }],
        status: "open",
      });
      onDidChangeNotes();
    } catch (error) {
      // The pending thread stays alive so the typed text is not lost
      void vscode.window.showErrorMessage(
        `Delta Review: failed to save note (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };

  return {
    renderThreads,
    addNote,
    dispose: (): void => {
      // Disposing the controller disposes its threads
      threadCache.clear();
      controller.dispose();
    },
  };
};
