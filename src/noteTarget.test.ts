import { describe, expect, it } from "vitest";
import { FileReviewStatus, ReviewFile, ReviewModel } from "./model";
import type { Note } from "./notes";
import {
  clampNoteRange,
  noteAnchorLines,
  noteTargetFor,
  reviewDiffIsEmpty,
} from "./noteTarget";

const file = (
  overrides: Partial<ReviewFile> & { path: string },
): ReviewFile => ({
  status: FileReviewStatus.NeedsReview,
  deleted: false,
  existsInMergeBase: true,
  diffBaseIsReviewedSnapshot: false,
  hasReviewSnapshot: false,
  diffBaseSha: undefined,
  diffBasePath: overrides.path,
  movedFrom: undefined,
  moveOrigin: undefined,
  donor: undefined,
  moveNote: undefined,
  moveClassification: undefined,
  originContentUnavailable: false,
  triage: "normal",
  ...overrides,
});

const model = (files: ReviewFile[]): ReviewModel => ({
  branch: "fix/deleted-file-notes",
  mergeBase: "abc123",
  files,
});

const note = (overrides: Partial<Note> = {}): Note => ({
  id: "n1",
  file: "src/app.ts",
  side: "working",
  startLine: 3,
  endLine: 4,
  snapshot: ["const x = 1;", "use(x);"],
  contentBlob: "blob-at-creation",
  turns: [{ text: "Handle this", at: "2026-08-01T10:00:00Z" }],
  status: "open",
  outdated: false,
  currentStartLine: 9,
  currentEndLine: 10,
  createdAt: "2026-08-01T10:00:00Z",
  ...overrides,
});

describe("noteTargetFor", () => {
  it("targets the working file for a note on a live review file", () => {
    const target = noteTargetFor(
      model([file({ path: "src/app.ts", diffBaseSha: "aaa" })]),
      note(),
      true,
    );
    expect(target).toEqual({
      kind: "working",
      path: "src/app.ts",
      lines: "current",
    });
  });

  it("targets the working file for a live review file missing from disk", () => {
    // The model, not the filesystem, decides for a file still in the review
    // set — reordering the resolver's checks would silently break this
    const target = noteTargetFor(
      model([file({ path: "src/app.ts", diffBaseSha: "aaa" })]),
      note(),
      false,
    );
    expect(target).toEqual({
      kind: "working",
      path: "src/app.ts",
      lines: "current",
    });
  });

  it("targets a deleted file's base document, not the empty document", () => {
    const target = noteTargetFor(
      model([file({ path: "src/app.ts", deleted: true, diffBaseSha: "aaa" })]),
      note(),
      false,
    );
    expect(target).toEqual({
      kind: "base",
      path: "src/app.ts",
      sha: "aaa",
      lines: "current",
    });
  });

  it("keys a deleted repo-move origin on the base document's own path", () => {
    const target = noteTargetFor(
      model([
        file({
          path: "src/new/config.ts",
          deleted: true,
          diffBasePath: "src/old/config.ts",
          diffBaseSha: "ccc",
        }),
      ]),
      note({ file: "src/new/config.ts" }),
      false,
    );
    expect(target).toEqual({
      kind: "base",
      path: "src/old/config.ts",
      sha: "ccc",
      lines: "current",
    });
  });

  it("falls back to the creation blob when a deleted file has no base blob", () => {
    const target = noteTargetFor(
      model([file({ path: "src/app.ts", deleted: true })]),
      note(),
      false,
    );
    expect(target).toEqual({
      kind: "base",
      path: "src/app.ts",
      sha: "blob-at-creation",
      lines: "current",
    });
  });

  it("still targets the working file when it left the review set but is on disk", () => {
    const target = noteTargetFor(model([]), note(), true);
    expect(target).toEqual({
      kind: "working",
      path: "src/app.ts",
      lines: "current",
    });
  });

  it("targets the creation blob when the file is gone from the model and disk", () => {
    const target = noteTargetFor(model([]), note(), false);
    expect(target).toEqual({
      kind: "base",
      path: "src/app.ts",
      sha: "blob-at-creation",
      lines: "creation",
    });
  });

  it("targets the creation blob with no model at all and no working file", () => {
    expect(noteTargetFor(undefined, note(), false)).toEqual({
      kind: "base",
      path: "src/app.ts",
      sha: "blob-at-creation",
      lines: "creation",
    });
  });

  it("resolves a base-side note through the currently displayed base", () => {
    const target = noteTargetFor(
      model([file({ path: "src/app.ts", diffBaseSha: "aaa" })]),
      note({ side: "base" }),
      true,
    );
    expect(target).toEqual({
      kind: "base",
      path: "src/app.ts",
      sha: "aaa",
      lines: "current",
    });
  });

  it("follows a base that advanced past the note's creation blob", () => {
    const advanced = model([
      file({
        path: "src/app.ts",
        status: FileReviewStatus.Reviewed,
        diffBaseIsReviewedSnapshot: true,
        hasReviewSnapshot: true,
        diffBaseSha: "newer",
      }),
    ]);
    expect(noteTargetFor(advanced, note({ side: "base" }), true)).toEqual({
      kind: "base",
      path: "src/app.ts",
      sha: "newer",
      lines: "current",
    });
  });

  it("falls back to the creation blob for a base-side note out of the review set", () => {
    expect(noteTargetFor(model([]), note({ side: "base" }), false)).toEqual({
      kind: "base",
      path: "src/app.ts",
      sha: "blob-at-creation",
      lines: "current",
    });
  });
});

describe("reviewDiffIsEmpty", () => {
  it("reports a deleted file with no base blob", () => {
    expect(reviewDiffIsEmpty(file({ path: "src/app.ts", deleted: true }))).toBe(
      true,
    );
  });

  it("does not report a deleted file that still has a base blob", () => {
    expect(
      reviewDiffIsEmpty(
        file({ path: "src/app.ts", deleted: true, diffBaseSha: "aaa" }),
      ),
    ).toBe(false);
  });

  it("does not report a live file with no base blob", () => {
    expect(reviewDiffIsEmpty(file({ path: "src/app.ts" }))).toBe(false);
  });
});

describe("noteAnchorLines", () => {
  it("uses the current pair for a drifted document", () => {
    expect(noteAnchorLines(note(), "current")).toEqual({
      startLine: 9,
      endLine: 10,
    });
  });

  it("uses the creation pair for the note's own creation blob", () => {
    expect(noteAnchorLines(note(), "creation")).toEqual({
      startLine: 3,
      endLine: 4,
    });
  });
});

describe("clampNoteRange", () => {
  it("leaves an in-range anchor alone", () => {
    expect(clampNoteRange(3, 4, 20)).toEqual({ start: 2, end: 3 });
  });

  it("clamps an anchor past the end to the last line", () => {
    expect(clampNoteRange(40, 41, 10)).toEqual({ start: 9, end: 9 });
  });

  it("lands on line 0 in a one-line document", () => {
    expect(clampNoteRange(12, 12, 1)).toEqual({ start: 0, end: 0 });
  });

  it("lands on line 0 in a document with no lines", () => {
    expect(clampNoteRange(1, 1, 0)).toEqual({ start: 0, end: 0 });
  });

  it("never returns a negative line", () => {
    expect(clampNoteRange(0, 0, 5)).toEqual({ start: 0, end: 0 });
  });
});
