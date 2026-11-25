import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import * as vscode from "vscode";
import { createReviewBaseUri, REVIEW_BASE_SCHEME } from "./contentProvider";
import {
  canonicalDir,
  documentNotePath,
  documentNoteRefFor,
  ReviewDocuments,
} from "./documents";
import { Git } from "./git";
import { ReviewModel } from "./model";
import { FileNote, isFileNote, Note, NoteDocument, NoteSide } from "./notes";
import {
  clampNoteRange,
  fileNoteTargetFor,
  NoteLineSource,
  NoteTarget,
  noteAnchorLines,
  noteTargetFor,
} from "./noteTarget";
import {
  AnyNoteThread,
  NoteThread,
  ThreadStatus,
  deriveThreadStatus,
} from "./noteThreads";
import {
  appendReviewerTurn,
  createNote,
  deleteNote,
  deleteReviewerTurn,
  editReviewerTurn,
  setResolved,
} from "./notesStore";
import {
  agentLineNoteLabel,
  type AgentLineNoteEntry,
  type ProvenanceEntry,
} from "./provenance";
import {
  canReplyFor,
  sameCommentDisplays,
  shouldRecreateThread,
} from "./threadRender";
import type { CommentDisplay } from "./threadRender";

// Inline review notes in the diff editor, built on the VS Code Comments API:
// the `+` commenting gutter on both diff sides, the add-note flow persisting
// through the notes store, rendering of existing threads with status labels,
// and the thread actions (edit/delete turns, delete thread, resolve/
// unresolve, reply-to-reopen). Model/git access is injected as callbacks so
// the controller always sees the extension's current state.

const statusLabels: Record<ThreadStatus, string> = {
  open: "Open",
  addressed: "Addressed",
  pending: "Pending",
  resolved: "Resolved",
};

const statusContextValues: Record<ThreadStatus, string> = {
  open: "openNote",
  addressed: "addressedNote",
  pending: "pendingNote",
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
  // The raw turn text: `body` holds the rendered markdown (possibly carrying
  // the outdated snapshot block), so edit mode swaps this in instead
  turnText: string;
}

// A rendered provenance thread as an inspection-only value: the scripted
// extension-host check in the repo's test runner reads these, since a live
// CommentThread cannot leave the extension host. Nothing in the extension
// itself consumes it.
export interface ProvenanceThreadSnapshot {
  path: string;
  uri: string;
  // undefined is the file-level placement — a line range would mean the
  // thread had been pinned to a line like a note
  range: undefined | { startLine: number; endLine: number };
  canReply: boolean;
  contextValue: string | undefined;
  body: string;
}

// A rendered agent line thread, inspection-only like ProvenanceThreadSnapshot.
// Lines are the rendered 0-based range, after any clamp.
export interface AgentLineThreadSnapshot {
  path: string;
  uri: string;
  startLine: number;
  endLine: number;
  label: string | undefined;
  canReply: boolean;
  contextValue: string | undefined;
  body: string;
}

// A note thread that renders as a comment thread: line notes at their range,
// file notes as range-less whole-file threads
export type RenderedNoteThread = NoteThread<Note | FileNote>;

// A rendered note thread, inspection-only like ProvenanceThreadSnapshot.
// range is the rendered 0-based [startLine, endLine]; null is file-level.
export interface NoteThreadSnapshot {
  noteId: string;
  uri: string;
  range: null | [number, number];
  label: string | undefined;
  contextValue: string | undefined;
}

export interface NoteCommentController extends vscode.Disposable {
  // Reconciles rendered comment threads with the given display threads
  renderThreads: (threads: RenderedNoteThread[]) => void;
  // Inspection accessor for the scripted extension-host check
  noteThreadSnapshots: () => NoteThreadSnapshot[];
  // Opens an empty whole-file draft thread on uri; Add Note saves it as a
  // file note with the given id
  startFileNoteDraft: (uri: vscode.Uri, path: string, noteId: string) => void;
  // Handler for the deltaReview.cancelNoteDraft thread action
  cancelNoteDraft: (thread: vscode.CommentThread) => void;
  // Reconciles the read-only file-level provenance threads with the given
  // entries. Independent of renderThreads: provenance comes from the review
  // model, not the notes file, so a broken notes file leaves it standing.
  renderProvenanceThreads: (entries: ProvenanceEntry[]) => void;
  // Inspection accessor for the scripted extension-host check
  provenanceThreads: () => ProvenanceThreadSnapshot[];
  // Reconciles the read-only agent line-range threads with the given
  // entries; model-driven and independent of renderThreads, like provenance
  renderAgentLineThreads: (entries: AgentLineNoteEntry[]) => void;
  // Inspection accessor for the scripted extension-host check
  agentLineThreads: () => AgentLineThreadSnapshot[];
  // Inspection accessor for the scripted extension-host check: URIs of the
  // open text documents that currently offer the note gutter
  commentableDocuments: () => string[];
  // Expands a note's rendered thread — the reveal approximation for
  // click-to-navigate (VS Code 1.90 has no stable thread.reveal())
  expandThread: (noteId: string) => void;
  // Re-clamps the ranges of the cached threads attached to a document that
  // just opened — the clamp needs a line count, which only exists once the
  // document is open. Range only: no dispose, no create, no git, no store.
  reclampThreadsFor: (document: vscode.TextDocument) => void;
  // Re-styles every cached thread from its own cached display thread (read
  // state changed). Style only: no dispose, no create, no ranges.
  restyleThreads: () => void;
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
  markNoteRead: (target: vscode.CommentThread) => void;
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
  pendingRead: {
    isUnread: (thread: AnyNoteThread) => boolean;
    markRead: (thread: AnyNoteThread) => void;
  },
  getReviewDocuments: () => ReviewDocuments | undefined,
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

  // Checked before repoRelativePath: with the git common dir inside the repo,
  // a review document would otherwise read as a `.git/...` repo path.
  // Directories compare by real path (symlinks, macOS /var vs /private/var)
  // and through Uri.file so a drive-letter case difference matches.
  const documentNoteRef = (
    uri: vscode.Uri,
  ): { document: NoteDocument; file: string } | undefined => {
    const documents = getReviewDocuments();
    if (documents === undefined || uri.scheme !== "file") {
      return undefined;
    }
    return documentNoteRefFor(
      uri.fsPath,
      documents,
      (path) => vscode.Uri.file(canonicalDir(path)).fsPath,
    );
  };

  const commentingRangesFor = (
    document: vscode.TextDocument,
  ): vscode.Range[] => {
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
      if (documentNoteRef(document.uri) !== undefined) {
        return fullDocument;
      }
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
  };

  controller.commentingRangeProvider = {
    provideCommentingRanges: commentingRangesFor,
  };

  const commentableDocuments = (): string[] =>
    vscode.workspace.textDocuments
      .filter((document) => commentingRangesFor(document).length > 0)
      .map((document) => document.uri.toString());

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

  const commentsFor = (thread: RenderedNoteThread): NoteComment[] => {
    let reviewerTurnIndex = 0;
    const note = thread.note;
    return thread.turns.map((turn, index) => {
      const body = new vscode.MarkdownString();
      body.appendMarkdown(turn.text);
      if (index === 0 && note.outdated && !isFileNote(note)) {
        // Mock 4: a dimmed one-liner with the first anchored line's original
        // text (italic is the closest to dimmed a MarkdownString gets)
        body.appendMarkdown(
          `\n\n*line was: ${inlineCode(note.snapshot[0] ?? "")}*`,
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

  const displayFor = (comment: NoteComment): CommentDisplay => ({
    authorName: comment.author.name,
    bodyText:
      typeof comment.body === "string" ? comment.body : comment.body.value,
    bodyIsMarkdown: typeof comment.body !== "string",
    mode: comment.mode,
    timestampMs: comment.timestamp?.getTime(),
    contextValue: comment.contextValue,
    noteId: comment.noteId,
    turnAt: comment.turnAt,
    turnText: comment.turnText,
    reviewerTurnIndex: comment.reviewerTurnIndex,
  });

  // Applies a display thread to a rendered thread, writing only the fields
  // that actually changed: the ext-host setters always emit an update, and an
  // update landing on a reply form that is still initializing is what
  // duplicates its reply button. canReply is exempt (the ext host dedupes it)
  // — see restyle for the invariant that keeps it from flipping false→true.
  const styleThread = (
    commentThread: vscode.CommentThread,
    thread: RenderedNoteThread,
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
    // Snapshot what VS Code was last sent before the carry-over below remaps
    // reviewerTurnIndex on the very objects the current array holds
    const previousDisplays = commentThread.comments.map((existing) =>
      displayFor(existing as NoteComment),
    );
    const comments = commentsFor(thread).map((comment) => {
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
    if (!sameCommentDisplays(previousDisplays, comments.map(displayFor))) {
      commentThread.comments = comments;
    }
    const unread = pendingRead.isUnread(thread);
    const outdatedText = isFileNote(thread.note)
      ? " • file left the diff"
      : " • Outdated";
    const label =
      statusLabels[thread.status] +
      (unread ? " • Unread" : "") +
      (isFileNote(thread.note) ? " • whole file" : "") +
      (thread.note.outdated ? outdatedText : "");
    if (commentThread.label !== label) {
      commentThread.label = label;
    }
    const contextValue = unread
      ? "pendingNoteUnread"
      : statusContextValues[thread.status];
    if (commentThread.contextValue !== contextValue) {
      commentThread.contextValue = contextValue;
    }
    const state =
      thread.status === "resolved"
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
    if (commentThread.state !== state) {
      commentThread.state = state;
    }
    // Invariant: this never flips a live thread false→true — VS Code would
    // then build a second reply button. The reply box appears only on a
    // freshly created thread (see restyle); here it only ever goes true→false
    // as a replyable (addressed or pending) note reopens or resolves.
    commentThread.canReply = canReplyFor(thread.status);
  };

  // A CommentThread renders only on an exactly matching URI. The decision of
  // which document a note lives on is `src/noteTarget.ts` — shared with the
  // REVIEW NOTES click, so both always land on the same document.
  const threadTargetFor = (
    git: Git,
    model: ReviewModel | undefined,
    note: Note,
  ): NoteTarget => {
    if (note.document !== undefined) {
      const documents = getReviewDocuments();
      return noteTargetFor(
        model,
        note,
        documents !== undefined &&
          existsSync(documentNotePath(documents, note.document, note.file)),
      );
    }
    return noteTargetFor(
      model,
      note,
      // Only a working-side note consults it, so a base-side note costs no
      // stat at all
      note.side === "working" && existsSync(join(git.repoRoot, note.file)),
    );
  };

  const uriForTarget = (git: Git, target: NoteTarget): vscode.Uri => {
    switch (target.kind) {
      case "working":
        return vscode.Uri.file(join(git.repoRoot, target.path));
      case "base":
        return createReviewBaseUri(target.path, target.sha);
      case "document": {
        // threadTargetFor yields a document target only with documents loaded
        const documents = getReviewDocuments();
        return vscode.Uri.file(
          documents === undefined
            ? target.file
            : documentNotePath(documents, target.document, target.file),
        );
      }
    }
  };

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

  // undefined is the file-level placement of a whole-file thread
  const rangeForThread = (
    noteThread: RenderedNoteThread,
    lines: ThreadLines,
    document: vscode.TextDocument | undefined,
  ): vscode.Range | undefined => {
    const note = noteThread.note;
    return isFileNote(note) || lines === "file"
      ? undefined
      : rangeFor(note, lines, document);
  };

  // The typings demand a range at creation; clearing it afterwards is what
  // pins a whole-file thread above line 1
  const createThread = (
    uri: vscode.Uri,
    range: vscode.Range | undefined,
    comments: vscode.Comment[],
  ): vscode.CommentThread => {
    const created = controller.createCommentThread(
      uri,
      range ?? new vscode.Range(0, 0, 0, 0),
      comments,
    );
    if (range === undefined) {
      created.range = undefined;
    }
    return created;
  };

  // Rendered threads by note id; uriKey detects base-sha changes (thread
  // URIs are immutable, so those need dispose + recreate). noteThread is the
  // last rendered display thread — action handlers restyle from it eagerly
  // before the authoritative refresh re-render lands. lines is the target's
  // coordinate choice, cached so a re-clamp needs no model or fs access;
  // "file" marks a whole-file thread, which never gets a range.
  type ThreadLines = NoteLineSource | "file";
  interface ThreadEntry {
    thread: vscode.CommentThread;
    uriKey: string;
    noteThread: RenderedNoteThread;
    lines: ThreadLines;
  }
  const threadCache = new Map<string, ThreadEntry>();
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

  // Swaps a cached entry's rendered thread for a fresh one at the given
  // uri/range, created with its comments so VS Code builds the widget's reply
  // form once, at display. The entry object is mutated in place, never
  // replaced: saveNoteTurn captures it before its await and restyles it
  // after, so a swapped-out entry would leave it styling a disposed thread.
  const replaceThread = (
    entry: ThreadEntry,
    noteId: string,
    uri: vscode.Uri,
    range: vscode.Range | undefined,
    comments: NoteComment[],
  ): void => {
    const collapsibleState = entry.thread.collapsibleState;
    threadNoteIds.delete(entry.thread);
    entry.thread.dispose();
    const created = createThread(uri, range, comments);
    created.collapsibleState = collapsibleState;
    entry.thread = created;
    entry.uriKey = uri.toString();
    // Thread-menu commands look their note up by the live CommentThread
    threadNoteIds.set(created, noteId);
  };

  // The single restyle entry point for a cached thread: a reply box may only
  // appear on a newly created thread, so a not-yet-replyable thread going
  // replyable (addressed or pending) is recreated rather than flipped in
  // place. The recreate drops an in-progress turn edit on that thread (the
  // typed text lives in the disposed widget either way). It never recurses — the fresh thread is replyable.
  const restyle = (
    entry: ThreadEntry,
    noteThread: RenderedNoteThread,
  ): void => {
    if (
      shouldRecreateThread(entry.thread.canReply !== false, noteThread.status)
    ) {
      const uri = entry.thread.uri;
      const range =
        entry.thread.range ??
        rangeForThread(entry.noteThread, entry.lines, openDocumentFor(uri));
      replaceThread(
        entry,
        noteThread.note.id,
        uri,
        range,
        commentsFor(noteThread),
      );
    }
    styleThread(entry.thread, noteThread);
  };

  // The merged-turns index of the reviewer turn with the given note.turns
  // index (the stable merge keeps reviewer turns in file order)
  const mergedReviewerTurnIndex = (
    noteThread: RenderedNoteThread,
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

  // Provenance threads by repo-relative path. Deliberately a second cache
  // rather than a flag on ThreadEntry: these threads are not notes, so no
  // note-side code path — sweep, restyle, re-clamp, threadNoteIds lookup —
  // may ever reach one. uriKey detects a file becoming deleted, which moves
  // its thread onto the empty base document; body detects contract edits.
  interface ProvenanceThreadEntry {
    thread: vscode.CommentThread;
    uriKey: string;
    body: string;
  }
  const provenanceCache = new Map<string, ProvenanceThreadEntry>();

  const provenanceCommentsFor = (body: string): vscode.Comment[] => [
    // No contextValue: the comment menus key on "reviewerTurn" and would
    // otherwise hang edit/delete actions off a thread nobody can edit
    {
      body: new vscode.MarkdownString(body),
      mode: vscode.CommentMode.Preview,
      author: { name: "Delta Review" },
    },
  ];

  // Mirrors openDiff's right-side choice, so the thread lands on the document
  // the diff actually shows: the working file, or the empty base document
  // standing in for a deleted file's missing right side
  const provenanceUri = (
    git: Git,
    entry: Pick<ProvenanceEntry, "path" | "deleted">,
  ): vscode.Uri =>
    entry.deleted
      ? createReviewBaseUri(entry.path, undefined)
      : vscode.Uri.file(join(git.repoRoot, entry.path));

  const clearProvenanceThreads = (): void => {
    for (const entry of provenanceCache.values()) {
      entry.thread.dispose();
    }
    provenanceCache.clear();
  };

  // Agent line threads by `<path>\n<index>`: a third cache for the same
  // reason provenance has its own — they are not notes. startLine/endLine
  // keep the contract's 1-based span so a re-clamp on open starts from it.
  interface AgentLineThreadEntry {
    thread: vscode.CommentThread;
    uriKey: string;
    body: string;
    startLine: number;
    endLine: number;
  }
  const agentLineCache = new Map<string, AgentLineThreadEntry>();

  const agentLineCommentsFor = (body: string): vscode.Comment[] => [
    {
      body: new vscode.MarkdownString(body),
      mode: vscode.CommentMode.Preview,
      author: { name: "Claude" },
    },
  ];

  const agentLineRange = (
    startLine: number,
    endLine: number,
    document: vscode.TextDocument | undefined,
  ): vscode.Range => {
    const { start, end } =
      document === undefined
        ? { start: startLine - 1, end: endLine - 1 }
        : clampNoteRange(startLine, endLine, document.lineCount);
    return new vscode.Range(start, 0, end, 0);
  };

  const clearAgentLineThreads = (): void => {
    for (const entry of agentLineCache.values()) {
      entry.thread.dispose();
    }
    agentLineCache.clear();
  };

  const renderAgentLineThreads = (entries: AgentLineNoteEntry[]): void => {
    const git = getGit();
    if (git === undefined) {
      clearAgentLineThreads();
      return;
    }
    const rendered = new Set<string>();
    const indexByPath = new Map<string, number>();
    for (const entry of entries) {
      const index = indexByPath.get(entry.path) ?? 0;
      indexByPath.set(entry.path, index + 1);
      const key = `${entry.path}\n${index}`;
      rendered.add(key);
      const uri = provenanceUri(git, entry);
      const uriKey = uri.toString();
      const range = agentLineRange(
        entry.startLine,
        entry.endLine,
        openDocumentFor(uri),
      );
      const label = agentLineNoteLabel(entry.startLine, entry.endLine);
      const cached = agentLineCache.get(key);
      if (cached === undefined || cached.uriKey !== uriKey) {
        cached?.thread.dispose();
        const thread = controller.createCommentThread(
          uri,
          range,
          agentLineCommentsFor(entry.body),
        );
        thread.label = label;
        thread.canReply = false;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        agentLineCache.set(key, {
          thread,
          uriKey,
          body: entry.body,
          startLine: entry.startLine,
          endLine: entry.endLine,
        });
        continue;
      }
      if (cached.body !== entry.body) {
        cached.thread.comments = agentLineCommentsFor(entry.body);
        cached.body = entry.body;
      }
      if (
        cached.startLine !== entry.startLine ||
        cached.endLine !== entry.endLine
      ) {
        cached.thread.label = label;
        cached.startLine = entry.startLine;
        cached.endLine = entry.endLine;
      }
      if (!cached.thread.range?.isEqual(range)) {
        cached.thread.range = range;
      }
    }
    for (const [key, entry] of agentLineCache) {
      if (!rendered.has(key)) {
        entry.thread.dispose();
        agentLineCache.delete(key);
      }
    }
  };

  const agentLineThreads = (): AgentLineThreadSnapshot[] =>
    [...agentLineCache].map(([key, entry]) => {
      const body = entry.thread.comments[0]?.body ?? "";
      return {
        path: key.slice(0, key.lastIndexOf("\n")),
        uri: entry.thread.uri.toString(),
        startLine: entry.thread.range?.start.line ?? 0,
        endLine: entry.thread.range?.end.line ?? 0,
        label: entry.thread.label,
        canReply: entry.thread.canReply !== false,
        contextValue: entry.thread.contextValue,
        body: typeof body === "string" ? body : body.value,
      };
    });

  const renderProvenanceThreads = (entries: ProvenanceEntry[]): void => {
    const git = getGit();
    if (git === undefined) {
      clearProvenanceThreads();
      return;
    }
    const rendered = new Set<string>();
    for (const entry of entries) {
      rendered.add(entry.path);
      const uri = provenanceUri(git, entry);
      const uriKey = uri.toString();
      const cached = provenanceCache.get(entry.path);
      // Thread URIs are immutable, so a relocated thread is disposed and
      // rebuilt rather than moved
      if (cached === undefined || cached.uriKey !== uriKey) {
        cached?.thread.dispose();
        const thread = controller.createCommentThread(
          uri,
          // The typings demand a range at creation; clearing it afterwards is
          // what pins the thread above line 1 as a file-level thread
          new vscode.Range(0, 0, 0, 0),
          provenanceCommentsFor(entry.body),
        );
        thread.range = undefined;
        // The API default is true, and the controller-wide placeholder would
        // otherwise offer a reply box on a thread that takes no replies
        thread.canReply = false;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        provenanceCache.set(entry.path, { thread, uriKey, body: entry.body });
        continue;
      }
      if (cached.body !== entry.body) {
        cached.thread.comments = provenanceCommentsFor(entry.body);
        cached.body = entry.body;
      }
    }
    for (const [path, entry] of provenanceCache) {
      if (!rendered.has(path)) {
        entry.thread.dispose();
        provenanceCache.delete(path);
      }
    }
  };

  const provenanceThreads = (): ProvenanceThreadSnapshot[] =>
    [...provenanceCache].map(([path, entry]) => {
      const range = entry.thread.range;
      const body = entry.thread.comments[0]?.body ?? "";
      return {
        path,
        uri: entry.thread.uri.toString(),
        range:
          range === undefined
            ? undefined
            : { startLine: range.start.line, endLine: range.end.line },
        // The typings widened canReply to boolean | CommentAuthorInformation;
        // anything but an explicit false means the thread takes replies
        canReply: entry.thread.canReply !== false,
        contextValue: entry.thread.contextValue,
        body: typeof body === "string" ? body : body.value,
      };
    });

  // The rendered placement of a thread: its document, its range (undefined
  // for a whole-file thread) and the lines marker cached on its entry
  const placementFor = (
    git: Git,
    model: ReviewModel | undefined,
    thread: RenderedNoteThread,
  ): {
    uri: vscode.Uri;
    range: vscode.Range | undefined;
    lines: ThreadLines;
  } => {
    const note = thread.note;
    if (isFileNote(note)) {
      const target = fileNoteTargetFor(
        model,
        note,
        existsSync(join(git.repoRoot, note.file)),
      );
      return {
        uri:
          target.kind === "working"
            ? vscode.Uri.file(join(git.repoRoot, target.path))
            : createReviewBaseUri(target.path, target.sha),
        range: undefined,
        lines: "file",
      };
    }
    const target = threadTargetFor(git, model, note);
    const uri = uriForTarget(git, target);
    return {
      uri,
      range: rangeFor(note, target.lines, openDocumentFor(uri)),
      lines: target.lines,
    };
  };

  const renderThreads = (threads: RenderedNoteThread[]): void => {
    const git = getGit();
    if (git === undefined) {
      for (const entry of threadCache.values()) {
        entry.thread.dispose();
      }
      threadCache.clear();
      threadNoteIds.clear();
      // No repo means no paths to resolve provenance URIs against, so those
      // and agent line threads go with the notes
      clearProvenanceThreads();
      clearAgentLineThreads();
      return;
    }
    const model = getModel();
    const rendered = new Set<string>();
    for (const thread of threads) {
      rendered.add(thread.note.id);
      const { uri, range, lines } = placementFor(git, model, thread);
      const uriKey = uri.toString();
      const entry = threadCache.get(thread.note.id);
      if (entry === undefined) {
        const created = createThread(uri, range, commentsFor(thread));
        created.collapsibleState =
          vscode.CommentThreadCollapsibleState.Expanded;
        const fresh: ThreadEntry = {
          thread: created,
          uriKey,
          noteThread: thread,
          lines,
        };
        threadCache.set(thread.note.id, fresh);
        threadNoteIds.set(created, thread.note.id);
        styleThread(created, thread);
        continue;
      }
      entry.noteThread = thread;
      entry.lines = lines;
      // Thread URIs are immutable: relocation (anchor application, base-sha
      // progression) means dispose + recreate, keeping the collapse state
      if (entry.uriKey !== uriKey) {
        replaceThread(entry, thread.note.id, uri, range, commentsFor(thread));
        styleThread(entry.thread, thread);
        continue;
      }
      // Before the range write: restyle may dispose this thread, and a range
      // written to a disposed thread is wasted
      restyle(entry, thread);
      if (range !== undefined) {
        entry.thread.range = range;
      }
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
      const range = rangeForThread(entry.noteThread, entry.lines, document);
      if (entry.uriKey === uriKey && range !== undefined) {
        entry.thread.range = range;
      }
    }
    for (const entry of agentLineCache.values()) {
      if (entry.uriKey === uriKey) {
        entry.thread.range = agentLineRange(
          entry.startLine,
          entry.endLine,
          document,
        );
      }
    }
  };

  const noteThreadSnapshots = (): NoteThreadSnapshot[] =>
    [...threadCache].map(([noteId, entry]) => {
      const range = entry.thread.range;
      return {
        noteId,
        uri: entry.thread.uri.toString(),
        range: range === undefined ? null : [range.start.line, range.end.line],
        label: entry.thread.label,
        contextValue: entry.thread.contextValue,
      };
    });

  const restyleThreads = (): void => {
    for (const entry of threadCache.values()) {
      styleThread(entry.thread, entry.noteThread);
    }
  };

  const markNoteRead = (target: vscode.CommentThread): void => {
    const noteId = threadNoteIds.get(target);
    const entry = noteId === undefined ? undefined : threadCache.get(noteId);
    if (entry !== undefined) {
      pendingRead.markRead(entry.noteThread);
    }
  };

  // Drafts opened by startFileNoteDraft, until Add Note adopts or Cancel
  // disposes them
  const fileNoteDrafts = new Map<
    vscode.CommentThread,
    { path: string; noteId: string }
  >();

  const startFileNoteDraft = (
    uri: vscode.Uri,
    path: string,
    noteId: string,
  ): void => {
    const draft = createThread(uri, undefined, []);
    draft.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    draft.canReply = true;
    draft.contextValue = "fileNoteDraft";
    draft.label = `File note · ${path}`;
    fileNoteDrafts.set(draft, { path, noteId });
  };

  const cancelNoteDraft = (thread: vscode.CommentThread): void => {
    fileNoteDrafts.delete(thread);
    thread.dispose();
  };

  const addFileNote = async (
    reply: vscode.CommentReply,
    draft: { path: string; noteId: string },
  ): Promise<void> => {
    const context = activeContext();
    if (context === undefined) {
      showFailure("save note", "no active review");
      return;
    }
    const pending = reply.thread;
    try {
      const content =
        openDocumentFor(pending.uri)?.getText() ??
        new TextDecoder().decode(
          await vscode.workspace.fs.readFile(pending.uri),
        );
      const note = await createNote(context.git, context.model.branch, {
        scope: "file",
        file: draft.path,
        content,
        text: reply.text,
        id: draft.noteId,
      });
      if (!isFileNote(note)) {
        throw new Error("store returned a non-file note");
      }
      const noteThread: RenderedNoteThread = {
        note,
        turns: [{ author: "reviewer", text: reply.text, at: note.createdAt }],
        status: "open",
      };
      threadCache.set(note.id, {
        thread: pending,
        uriKey: pending.uri.toString(),
        noteThread,
        lines: "file",
      });
      threadNoteIds.set(pending, note.id);
      fileNoteDrafts.delete(pending);
      styleThread(pending, noteThread);
      onDidChangeNotes();
    } catch (error) {
      // The draft stays alive so the typed text is not lost
      showFailure("save note", errorText(error));
    }
  };

  const addNote = async (reply: vscode.CommentReply): Promise<void> => {
    const draft = fileNoteDrafts.get(reply.thread);
    if (draft !== undefined) {
      await addFileNote(reply, draft);
      return;
    }
    const context = activeContext();
    const pending = reply.thread;
    const uri = pending.uri;
    if (context === undefined) {
      showFailure("save note", "no active review");
      return;
    }
    let side: NoteSide;
    let path: string | undefined;
    const ref = documentNoteRef(uri);
    if (ref !== undefined) {
      side = "working";
      path = ref.file;
    } else if (uri.scheme === REVIEW_BASE_SCHEME) {
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
        ...(ref === undefined ? {} : { document: ref.document }),
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
    // The editor must open on the raw turn text, not the rendered display
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
      restyle(entry, entry.noteThread);
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
    restyle(entry, entry.noteThread);
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
          entry.noteThread.status = deriveThreadStatus(
            remaining.status,
            entry.noteThread.turns,
          );
          entry.noteThread.note.status = remaining.status;
          restyle(entry, entry.noteThread);
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
        entry.noteThread.status = deriveThreadStatus(
          note.status,
          entry.noteThread.turns,
        );
        entry.noteThread.note.status = note.status;
        restyle(entry, entry.noteThread);
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
        entry.noteThread.status = deriveThreadStatus(
          note.status,
          entry.noteThread.turns,
        );
        entry.noteThread.note.status = note.status;
        restyle(entry, entry.noteThread);
      }
      onDidChangeNotes();
    } catch (error) {
      showFailure("save reply", errorText(error));
    }
  };

  return {
    renderThreads,
    noteThreadSnapshots,
    startFileNoteDraft,
    cancelNoteDraft,
    renderProvenanceThreads,
    provenanceThreads,
    renderAgentLineThreads,
    agentLineThreads,
    commentableDocuments,
    expandThread,
    reclampThreadsFor,
    restyleThreads,
    addNote,
    editNoteTurn,
    saveNoteTurn,
    cancelNoteTurn,
    deleteNoteTurn,
    deleteNoteThread,
    resolveNote: (target) => setNoteResolved(target, true),
    unresolveNote: (target) => setNoteResolved(target, false),
    replyReopen,
    markNoteRead,
    dispose: (): void => {
      // Disposing the controller disposes its threads
      threadCache.clear();
      threadNoteIds.clear();
      fileNoteDrafts.clear();
      clearProvenanceThreads();
      clearAgentLineThreads();
      controller.dispose();
    },
  };
};
