import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import * as vscode from "vscode";
import { createReviewBaseUri, REVIEW_BASE_SCHEME } from "./contentProvider";
import { Git } from "./git";
import { escapeMarkdownText } from "./markdown";
import { ReviewModel } from "./model";
import { Note, NoteSide, NoteStatus } from "./notes";
import {
  clampNoteRange,
  NoteLineSource,
  NoteTarget,
  noteAnchorLines,
  noteTargetFor,
} from "./noteTarget";
import { NoteThread } from "./noteThreads";
import {
  appendReviewerTurn,
  createNote,
  deleteNote,
  deleteReviewerTurn,
  editReviewerTurn,
  setResolved,
} from "./notesStore";

// Inline review notes in the diff editor, built on the VS Code Comments API:
// the `+` commenting gutter on both diff sides, the add-note flow persisting
// through the notes store, rendering of existing threads with status labels,
// and the thread actions (edit/delete turns, delete thread, resolve/
// unresolve, reply-to-reopen). Model/git access is injected as callbacks so
// the controller always sees the extension's current state.

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

// A rendered comment carrying the store coordinates the comment-level
// commands need. reviewerTurnIndex indexes into note.turns (the stable merge
// keeps reviewer turns in file order) and exists on reviewer turns only —
// agent turns also get no contextValue, so no edit/delete affordance ever
// appears on Claude's replies.
interface NoteComment extends vscode.Comment {
  noteId: string;
  reviewerTurnIndex?: number;
  // The turn's `at` timestamp — stable identity for edits (indices shift
  // when another turn is deleted, `at` never changes)
  turnAt: string;
  // The raw turn text: `body` holds display markdown (escaped, and possibly
  // carrying the outdated snapshot block), so edit mode swaps this in instead
  turnText: string;
}

export interface NoteCommentController extends vscode.Disposable {
  // Reconciles rendered comment threads with the given display threads
  renderThreads: (threads: NoteThread[]) => void;
  // Expands a note's rendered thread — the reveal approximation for
  // click-to-navigate (VS Code 1.90 has no stable thread.reveal())
  expandThread: (noteId: string) => void;
  // Re-clamps the ranges of the cached threads attached to a document that
  // just opened — the clamp needs a line count, which only exists once the
  // document is open. Range only: no dispose, no create, no git, no store.
  reclampThreadsFor: (document: vscode.TextDocument) => void;
  // Handler for the deltaReview.addNote comment-input command
  addNote: (reply: vscode.CommentReply) => Promise<void>;
  // Comment-level actions on reviewer turns
  editNoteTurn: (comment: vscode.Comment) => void;
  saveNoteTurn: (comment: vscode.Comment) => Promise<void>;
  cancelNoteTurn: (comment: vscode.Comment) => void;
  deleteNoteTurn: (comment: vscode.Comment) => Promise<void>;
  // Thread-level actions (title menu passes the thread, the reply row a
  // CommentReply)
  deleteNoteThread: (thread: vscode.CommentThread) => Promise<void>;
  resolveNote: (
    target: vscode.CommentThread | vscode.CommentReply,
  ) => Promise<void>;
  unresolveNote: (
    target: vscode.CommentThread | vscode.CommentReply,
  ) => Promise<void>;
  replyReopen: (reply: vscode.CommentReply) => Promise<void>;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Markdown inline-code span safe for arbitrary text: the backtick fence is
// longer than any backtick run inside, space-padded per CommonMark
const inlineCode = (text: string): string => {
  const longestRun =
    text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${text} ${fence}`;
};

// Thread-menu commands receive the CommentThread itself; reply-row commands
// receive a CommentReply wrapping it
const threadOf = (
  target: vscode.CommentThread | vscode.CommentReply,
): vscode.CommentThread => ("thread" in target ? target.thread : target);

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
          file.diffBasePath === path && file.diffBaseSha === document.uri.query,
      )
        ? fullDocument
        : [];
    },
  };

  const activeContext = (): { git: Git; model: ReviewModel } | undefined => {
    const git = getGit();
    const model = getModel();
    return git === undefined || model === undefined
      ? undefined
      : { git, model };
  };

  const showFailure = (action: string, detail: string): void => {
    void vscode.window.showErrorMessage(
      `Delta Review: failed to ${action} (${detail})`,
    );
  };

  const commentsFor = (thread: NoteThread): NoteComment[] => {
    let reviewerTurnIndex = 0;
    return thread.turns.map((turn, index) => {
      const body = new vscode.MarkdownString();
      body.appendMarkdown(escapeMarkdownText(turn.text));
      if (index === 0 && thread.note.outdated) {
        // Mock 4: a dimmed one-liner with the first anchored line's original
        // text (italic is the closest to dimmed a MarkdownString gets)
        body.appendMarkdown(
          `\n\n*line was: ${inlineCode(thread.note.snapshot[0] ?? "")}*`,
        );
      }
      const comment: NoteComment = {
        body,
        mode: vscode.CommentMode.Preview,
        author: { name: turn.author === "reviewer" ? "You" : "Claude" },
        timestamp: new Date(turn.at),
        noteId: thread.note.id,
        turnAt: turn.at,
        turnText: turn.text,
      };
      if (turn.author === "reviewer") {
        comment.contextValue = "reviewerTurn";
        comment.reviewerTurnIndex = reviewerTurnIndex++;
      }
      return comment;
    });
  };

  const styleThread = (
    commentThread: vscode.CommentThread,
    thread: NoteThread,
  ): void => {
    // A background re-render must not blow away an in-progress edit:
    // comments left in Editing mode are carried over by turn timestamp —
    // stable identity, so a concurrent turn delete can never retarget the
    // edit onto a different turn (an edit whose turn was deleted just drops)
    const editing = new Map<string, NoteComment>();
    for (const existing of commentThread.comments) {
      const noteComment = existing as NoteComment;
      if (
        existing.mode === vscode.CommentMode.Editing &&
        noteComment.reviewerTurnIndex !== undefined
      ) {
        editing.set(noteComment.turnAt, noteComment);
      }
    }
    commentThread.comments = commentsFor(thread).map((comment) => {
      const carried =
        comment.reviewerTurnIndex === undefined
          ? undefined
          : editing.get(comment.turnAt);
      if (carried === undefined) {
        return comment;
      }
      // Remap the carried comment's positional index to the fresh render
      carried.reviewerTurnIndex = comment.reviewerTurnIndex;
      return carried;
    });
    commentThread.label =
      statusLabels[thread.status] + (thread.note.outdated ? " • Outdated" : "");
    commentThread.contextValue = statusContextValues[thread.status];
    commentThread.state =
      thread.status === "resolved"
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
    // The reply box doubles as the reopen affordance and only exists on
    // addressed threads: on open threads the reviewer edits their own turns
    // instead, and resolved threads must be unresolved first
    commentThread.canReply = thread.status === "addressed";
  };

  // A CommentThread renders only on an exactly matching URI. The decision of
  // which document a note lives on is `src/noteTarget.ts` — shared with the
  // REVIEW NOTES click, so both always land on the same document.
  const threadTargetFor = (
    git: Git,
    model: ReviewModel | undefined,
    note: Note,
  ): NoteTarget =>
    noteTargetFor(
      model,
      note,
      // Only a working-side note consults it, so a base-side note costs no
      // stat at all
      note.side === "working" && existsSync(join(git.repoRoot, note.file)),
    );

  const uriForTarget = (git: Git, target: NoteTarget): vscode.Uri =>
    target.kind === "working"
      ? vscode.Uri.file(join(git.repoRoot, target.path))
      : createReviewBaseUri(target.path, target.sha);

  const openDocumentFor = (uri: vscode.Uri): vscode.TextDocument | undefined =>
    vscode.workspace.textDocuments.find(
      (entry) => entry.uri.toString() === uri.toString(),
    );

  // The anchor a thread renders at, clamped into its document. An unopened
  // document has no line count to clamp against, so the unclamped range
  // stands until reclampThreadsFor runs on open.
  const rangeFor = (
    note: Note,
    lines: NoteLineSource,
    document: vscode.TextDocument | undefined,
  ): vscode.Range => {
    const { startLine, endLine } = noteAnchorLines(note, lines);
    const { start, end } =
      document === undefined
        ? { start: startLine - 1, end: endLine - 1 }
        : clampNoteRange(startLine, endLine, document.lineCount);
    return new vscode.Range(start, 0, end, 0);
  };

  // Rendered threads by note id; uriKey detects base-sha changes (thread
  // URIs are immutable, so those need dispose + recreate). noteThread is the
  // last rendered display thread — action handlers restyle from it eagerly
  // before the authoritative refresh re-render lands. lines is the target's
  // coordinate choice, cached so a re-clamp needs no model or fs access.
  const threadCache = new Map<
    string,
    {
      thread: vscode.CommentThread;
      uriKey: string;
      noteThread: NoteThread;
      lines: NoteLineSource;
    }
  >();
  // Reverse lookup for the thread-level handlers, which receive a
  // CommentThread and must find its note id
  const threadNoteIds = new Map<vscode.CommentThread, string>();

  const dropThread = (noteId: string): void => {
    const entry = threadCache.get(noteId);
    if (entry === undefined) {
      return;
    }
    threadNoteIds.delete(entry.thread);
    entry.thread.dispose();
    threadCache.delete(noteId);
  };

  // The merged-turns index of the reviewer turn with the given note.turns
  // index (the stable merge keeps reviewer turns in file order)
  const mergedReviewerTurnIndex = (
    noteThread: NoteThread,
    reviewerTurnIndex: number,
  ): number => {
    let count = 0;
    for (let index = 0; index < noteThread.turns.length; index++) {
      if (noteThread.turns[index]?.author === "reviewer") {
        if (count === reviewerTurnIndex) {
          return index;
        }
        count++;
      }
    }
    return -1;
  };

  const renderThreads = (threads: NoteThread[]): void => {
    const git = getGit();
    if (git === undefined) {
      for (const entry of threadCache.values()) {
        entry.thread.dispose();
      }
      threadCache.clear();
      threadNoteIds.clear();
      return;
    }
    const model = getModel();
    const rendered = new Set<string>();
    for (const thread of threads) {
      rendered.add(thread.note.id);
      const target = threadTargetFor(git, model, thread.note);
      const uri = uriForTarget(git, target);
      const uriKey = uri.toString();
      const range = rangeFor(thread.note, target.lines, openDocumentFor(uri));
      let entry = threadCache.get(thread.note.id);
      // Thread URIs are immutable: relocation (anchor application, base-sha
      // progression) means dispose + recreate, keeping the collapse state
      let carriedCollapsibleState:
        vscode.CommentThreadCollapsibleState | undefined;
      if (entry !== undefined && entry.uriKey !== uriKey) {
        carriedCollapsibleState = entry.thread.collapsibleState;
        threadNoteIds.delete(entry.thread);
        entry.thread.dispose();
        entry = undefined;
      }
      if (entry === undefined) {
        const created = controller.createCommentThread(uri, range, []);
        created.collapsibleState =
          carriedCollapsibleState ??
          vscode.CommentThreadCollapsibleState.Expanded;
        entry = {
          thread: created,
          uriKey,
          noteThread: thread,
          lines: target.lines,
        };
        threadCache.set(thread.note.id, entry);
        threadNoteIds.set(created, thread.note.id);
      } else {
        entry.thread.range = range;
        entry.noteThread = thread;
        entry.lines = target.lines;
      }
      styleThread(entry.thread, thread);
    }
    for (const noteId of threadCache.keys()) {
      if (!rendered.has(noteId)) {
        dropThread(noteId);
      }
    }
  };

  const expandThread = (noteId: string): void => {
    const entry = threadCache.get(noteId);
    if (entry !== undefined) {
      entry.thread.collapsibleState =
        vscode.CommentThreadCollapsibleState.Expanded;
    }
  };

  // A note anchored past the end of its document would have nowhere to
  // render; the range is only clampable once the document exists, so the
  // extension calls this on every document open.
  const reclampThreadsFor = (document: vscode.TextDocument): void => {
    const uriKey = document.uri.toString();
    for (const entry of threadCache.values()) {
      if (entry.uriKey === uriKey) {
        entry.thread.range = rangeFor(
          entry.noteThread.note,
          entry.lines,
          document,
        );
      }
    }
  };

  const addNote = async (reply: vscode.CommentReply): Promise<void> => {
    const context = activeContext();
    const pending = reply.thread;
    const uri = pending.uri;
    if (context === undefined) {
      showFailure("save note", "no active review");
      return;
    }
    let side: NoteSide;
    let path: string | undefined;
    if (uri.scheme === REVIEW_BASE_SCHEME) {
      side = "base";
      path = uri.path.slice(1);
    } else {
      side = "working";
      path = repoRelativePath(context.git, uri);
    }
    const document = vscode.workspace.textDocuments.find(
      (entry) => entry.uri.toString() === uri.toString(),
    );
    if (path === undefined || document === undefined) {
      showFailure("save note", "document is not part of the review");
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
      const note = await createNote(context.git, context.model.branch, {
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
      const noteThread: NoteThread = {
        note,
        turns: [{ author: "reviewer", text: reply.text, at: note.createdAt }],
        status: "open",
      };
      threadCache.set(note.id, {
        thread: pending,
        uriKey: uri.toString(),
        noteThread,
        // A note is always created on the document the reviewer is looking
        // at, so its anchor is already that document's current coordinates
        lines: "current",
      });
      threadNoteIds.set(pending, note.id);
      pending.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      styleThread(pending, noteThread);
      onDidChangeNotes();
    } catch (error) {
      // The pending thread stays alive so the typed text is not lost
      showFailure("save note", errorText(error));
    }
  };

  const editNoteTurn = (comment: vscode.Comment): void => {
    const noteComment = comment as NoteComment;
    const entry = threadCache.get(noteComment.noteId);
    if (entry === undefined || noteComment.reviewerTurnIndex === undefined) {
      return;
    }
    // The editor must open on the raw turn text, not the escaped display
    // markdown (nor an outdated first turn's appended snapshot block)
    noteComment.body = noteComment.turnText;
    noteComment.mode = vscode.CommentMode.Editing;
    // The API only notices reassignment, never in-place mutation
    entry.thread.comments = [...entry.thread.comments];
  };

  const saveNoteTurn = async (comment: vscode.Comment): Promise<void> => {
    const noteComment = comment as NoteComment;
    const entry = threadCache.get(noteComment.noteId);
    if (entry === undefined || noteComment.reviewerTurnIndex === undefined) {
      return;
    }
    const context = activeContext();
    if (context === undefined) {
      showFailure("save note edit", "no active review");
      return;
    }
    // VS Code writes the edited value into `body` before invoking the command
    const text =
      typeof noteComment.body === "string"
        ? noteComment.body
        : noteComment.body.value;
    if (text.trim() === "") {
      // A turn is never persisted empty: saving an emptied body cancels the
      // edit back to the original text
      cancelNoteTurn(comment);
      return;
    }
    try {
      // The turn is addressed by `at`, not index — a concurrent delete of
      // another turn shifts indices but cannot retarget this edit
      await editReviewerTurn(
        context.git,
        context.model.branch,
        noteComment.noteId,
        noteComment.turnAt,
        text,
      );
      // Eager restyle so edit mode closes immediately (a comment still in
      // Editing mode would survive the re-render by design); the refresh
      // then re-renders authoritatively. Editing never changes status.
      noteComment.mode = vscode.CommentMode.Preview;
      const storedTurn = entry.noteThread.note.turns.find(
        (turn) => turn.at === noteComment.turnAt,
      );
      if (storedTurn !== undefined) {
        storedTurn.text = text;
      }
      const mergedTurn = entry.noteThread.turns.find(
        (turn) => turn.author === "reviewer" && turn.at === noteComment.turnAt,
      );
      if (mergedTurn !== undefined) {
        mergedTurn.text = text;
      }
      styleThread(entry.thread, entry.noteThread);
      onDidChangeNotes();
    } catch (error) {
      // Stay in Editing mode so the typed text is not lost
      showFailure("save note edit", errorText(error));
    }
  };

  const cancelNoteTurn = (comment: vscode.Comment): void => {
    const noteComment = comment as NoteComment;
    const entry = threadCache.get(noteComment.noteId);
    if (entry === undefined) {
      return;
    }
    // Leave Editing mode before restyling — styleThread deliberately carries
    // Editing comments over, and this one is being discarded
    noteComment.mode = vscode.CommentMode.Preview;
    styleThread(entry.thread, entry.noteThread);
  };

  const deleteNoteTurn = async (comment: vscode.Comment): Promise<void> => {
    const noteComment = comment as NoteComment;
    const turnIndex = noteComment.reviewerTurnIndex;
    if (turnIndex === undefined) {
      return;
    }
    const context = activeContext();
    if (context === undefined) {
      showFailure("delete note comment", "no active review");
      return;
    }
    try {
      const remaining = await deleteReviewerTurn(
        context.git,
        context.model.branch,
        noteComment.noteId,
        turnIndex,
      );
      if (remaining === undefined) {
        // Deleting the only reviewer turn deleted the whole note
        dropThread(noteComment.noteId);
      } else {
        const entry = threadCache.get(noteComment.noteId);
        if (entry !== undefined) {
          const mergedIndex = mergedReviewerTurnIndex(
            entry.noteThread,
            turnIndex,
          );
          if (mergedIndex >= 0) {
            entry.noteThread.turns.splice(mergedIndex, 1);
          }
          entry.noteThread.note.turns.splice(turnIndex, 1);
          entry.noteThread.status = remaining.status;
          entry.noteThread.note.status = remaining.status;
          styleThread(entry.thread, entry.noteThread);
        }
      }
      onDidChangeNotes();
    } catch (error) {
      showFailure("delete note comment", errorText(error));
    }
  };

  const deleteNoteThread = async (
    thread: vscode.CommentThread,
  ): Promise<void> => {
    const noteId = threadNoteIds.get(thread);
    if (noteId === undefined) {
      return;
    }
    const context = activeContext();
    if (context === undefined) {
      showFailure("delete note", "no active review");
      return;
    }
    try {
      await deleteNote(context.git, context.model.branch, noteId);
      dropThread(noteId);
      onDidChangeNotes();
    } catch (error) {
      showFailure("delete note", errorText(error));
    }
  };

  const setNoteResolved = async (
    target: vscode.CommentThread | vscode.CommentReply,
    resolved: boolean,
  ): Promise<void> => {
    const noteId = threadNoteIds.get(threadOf(target));
    const action = resolved ? "resolve note" : "unresolve note";
    if (noteId === undefined) {
      return;
    }
    const context = activeContext();
    if (context === undefined) {
      showFailure(action, "no active review");
      return;
    }
    try {
      // Unresolve re-derives the status from the last speaker (the store
      // recomputes it against the responses file)
      const note = await setResolved(
        context.git,
        context.model.branch,
        noteId,
        resolved,
      );
      const entry = threadCache.get(noteId);
      if (entry !== undefined) {
        entry.noteThread.status = note.status;
        entry.noteThread.note.status = note.status;
        styleThread(entry.thread, entry.noteThread);
      }
      onDidChangeNotes();
    } catch (error) {
      showFailure(action, errorText(error));
    }
  };

  const replyReopen = async (reply: vscode.CommentReply): Promise<void> => {
    // An empty reply must not reopen the note — no-op, leaving the typed
    // whitespace in the input box
    if (reply.text.trim() === "") {
      return;
    }
    const noteId = threadNoteIds.get(reply.thread);
    if (noteId === undefined) {
      return;
    }
    const context = activeContext();
    if (context === undefined) {
      showFailure("save reply", "no active review");
      return;
    }
    try {
      const note = await appendReviewerTurn(
        context.git,
        context.model.branch,
        noteId,
        reply.text,
      );
      const entry = threadCache.get(noteId);
      if (entry !== undefined) {
        const appended = note.turns[note.turns.length - 1];
        const at = appended?.at ?? new Date().toISOString();
        entry.noteThread.note.turns.push({ text: reply.text, at });
        entry.noteThread.turns.push({
          author: "reviewer",
          text: reply.text,
          at,
        });
        entry.noteThread.status = note.status;
        entry.noteThread.note.status = note.status;
        styleThread(entry.thread, entry.noteThread);
      }
      onDidChangeNotes();
    } catch (error) {
      showFailure("save reply", errorText(error));
    }
  };

  return {
    renderThreads,
    expandThread,
    reclampThreadsFor,
    addNote,
    editNoteTurn,
    saveNoteTurn,
    cancelNoteTurn,
    deleteNoteTurn,
    deleteNoteThread,
    resolveNote: (target) => setNoteResolved(target, true),
    unresolveNote: (target) => setNoteResolved(target, false),
    replyReopen,
    dispose: (): void => {
      // Disposing the controller disposes its threads
      threadCache.clear();
      threadNoteIds.clear();
      controller.dispose();
    },
  };
};
