import { baseBlobForNote } from "./baseDocument";
import type { ReviewFile, ReviewModel } from "./model";
import type { Note } from "./notes";

// Where a note's document lives, and how its anchor maps into that document.
// Both the rendered comment thread and the REVIEW NOTES click resolve through
// here, so the document the click opens is always the document the thread
// attaches to. Pure — no vscode, no fs: whether the working file exists is
// runtime knowledge injected by the caller.

// Which of a note's two line pairs the target document is expressed in:
// `current` = the working-tree-drifted currentStartLine/currentEndLine,
// `creation` = startLine/endLine, the coordinates of the content the note was
// originally written against
export type NoteLineSource = "current" | "creation";

export interface WorkingNoteTarget {
  kind: "working";
  // Repo-relative, '/'-separated
  path: string;
  lines: NoteLineSource;
}

export interface BaseNoteTarget {
  kind: "base";
  // Repo-relative, '/'-separated — the base document's path identity
  path: string;
  // Always a blob sha, never undefined: an undefined sha reads as the empty
  // document, which is exactly what makes a thread unrenderable
  sha: string;
  lines: NoteLineSource;
}

export type NoteTarget = WorkingNoteTarget | BaseNoteTarget;

// The document a note belongs to.
//
// - working side, file in the review set and not deleted → the working file;
// - working side, file in the review set and deleted → that file's base
//   document, where the noted content still exists (the working side of a
//   deleted file's diff is empty);
// - working side, file gone from the review set but still on disk → the
//   working file (a real, editable file beats a historical snapshot);
// - working side, file gone from both → the note's creation blob, the content
//   it was written against, so it is still readable and closable;
// - base side → the *currently displayed* base blob, so a thread does not
//   vanish when mark-reviewed advances the diff's base, falling back to the
//   creation blob once the file leaves the review set.
export const noteTargetFor = (
  model: ReviewModel | undefined,
  note: Note,
  workingFileExists: boolean,
): NoteTarget => {
  if (note.side === "base") {
    const currentBase =
      model === undefined
        ? undefined
        : baseBlobForNote(model, note.file, note.contentBlob);
    return {
      kind: "base",
      path: note.file,
      sha: currentBase ?? note.contentBlob,
      lines: "current",
    };
  }
  const file = model?.files.find((entry) => entry.path === note.file);
  if (file?.deleted === true) {
    return {
      kind: "base",
      path: file.diffBasePath,
      // A file added on the branch, or one whose external origin was pruned,
      // has no base blob at all — the creation blob is what keeps that note
      // off the empty document
      sha: file.diffBaseSha ?? note.contentBlob,
      lines: "current",
    };
  }
  if (file === undefined && !workingFileExists) {
    return {
      kind: "base",
      path: note.file,
      sha: note.contentBlob,
      lines: "creation",
    };
  }
  return { kind: "working", path: note.file, lines: "current" };
};

// Whether this file's review diff is the empty document on both sides: a
// deleted file's right side is always empty, and with no base blob (a file
// added on the branch, or one whose move origin was pruned) the left side is
// the very same empty document. Such a diff can hold no note, so the REVIEW
// NOTES click opens the note's target document instead.
export const reviewDiffIsEmpty = (file: ReviewFile): boolean =>
  file.deleted && file.diffBaseSha === undefined;

// The note's 1-based anchor in its target document's coordinates.
export const noteAnchorLines = (
  note: Note,
  lines: NoteLineSource,
): { startLine: number; endLine: number } =>
  lines === "creation"
    ? { startLine: note.startLine, endLine: note.endLine }
    : { startLine: note.currentStartLine, endLine: note.currentEndLine };

// 1-based anchor -> 0-based document lines, clamped into the document. A
// document with no lines (and a one-line document) yields line 0.
export const clampNoteRange = (
  startLine: number,
  endLine: number,
  lineCount: number,
): { start: number; end: number } => {
  const lastLine = Math.max(lineCount - 1, 0);
  const clamp = (line: number): number =>
    Math.min(Math.max(line - 1, 0), lastLine);
  return { start: clamp(startLine), end: clamp(endLine) };
};
