import type { NoteStatus } from "./notes";

// Rendering decisions for inline note threads, kept free of the vscode API so
// they stay unit-testable: when the VS Code thread has to be recreated rather
// than restyled, and whether a rendered comment list actually changed.

// The reply box doubles as the reopen affordance and only exists on addressed
// threads: on open threads the reviewer edits their own turns instead, and
// resolved threads must be unresolved first.
export const canReplyFor = (status: NoteStatus): boolean =>
  status === "addressed";

// VS Code duplicates a thread's reply button when `canReply` flips false→true
// on a live thread: the lazily built reply form's async initialization and the
// thread update that accompanies the flip both create one. A thread created
// with `canReply` already true builds its form once, so the reply box may only
// ever appear via dispose + recreate.
export const shouldRecreateThread = (
  currentCanReply: boolean,
  nextStatus: NoteStatus,
): boolean => !currentCanReply && canReplyFor(nextStatus);

// A rendered comment reduced to the fields VS Code is sent. `bodyIsMarkdown`
// distinguishes a MarkdownString body from a raw string one: handlers mutate
// comment objects in place, and the raw string an edit leaves behind is the
// only marker that the display body is owed a re-send.
export interface CommentDisplay {
  authorName: string;
  bodyText: string;
  bodyIsMarkdown: boolean;
  mode: number;
  timestampMs: number | undefined;
  contextValue: string | undefined;
  noteId: string;
  turnAt: string;
  turnText: string;
  reviewerTurnIndex: number | undefined;
}

const sameCommentDisplay = (a: CommentDisplay, b: CommentDisplay): boolean =>
  a.authorName === b.authorName &&
  a.bodyText === b.bodyText &&
  a.bodyIsMarkdown === b.bodyIsMarkdown &&
  a.mode === b.mode &&
  a.timestampMs === b.timestampMs &&
  a.contextValue === b.contextValue &&
  a.noteId === b.noteId &&
  a.turnAt === b.turnAt &&
  a.turnText === b.turnText &&
  a.reviewerTurnIndex === b.reviewerTurnIndex;

// Structural equality of two rendered comment lists — order matters, since
// order is what VS Code renders.
export const sameCommentDisplays = (
  previous: readonly CommentDisplay[],
  next: readonly CommentDisplay[],
): boolean =>
  previous.length === next.length &&
  previous.every((display, index) => {
    const other = next[index];
    return other !== undefined && sameCommentDisplay(display, other);
  });
