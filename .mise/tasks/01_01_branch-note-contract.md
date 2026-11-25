# 01_01 Branch-document note contract and document helpers

## Goal

Let the notes parser accept notes anchored to the Branch overview document (`"document": "branch"`), and add pure helpers that locate and detect document-note files by kind, so later tasks can route both cluster notes and branch documents.

## Files to modify/create

- `src/notes.ts`
- `src/documents.ts`

## Background

- Delta Review is a VS Code extension. Review notes live in a versioned JSON notes file; `src/notes.ts` is the pure parse/validate layer. A note with a `document` key (version 2 only) is anchored to a markdown document under `<git common dir>/delta-review/` rather than a repo file. Today the only value is `"clusterNotes"` (`src/notes.ts:17`), validated at `src/notes.ts:155-166` with `CLUSTER_NOTES_FILE_PATTERN` from `src/documents.ts:17`.
- The Branch overview document is `<common dir>/delta-review/branch-<sanitized branch>.md` (`branchDocumentFileName`, `src/documents.ts:22-23`); `sanitizeBranchForFilename` (`src/clusters.ts:234`) maps `[^A-Za-z0-9._-]` to `-`.
- `loadReviewDocuments(dir, branch, labels)` (`src/documents.ts:48-71`) returns `ReviewDocuments { clusterNotesDir, branchDocument?, clusterNotes }`.
- Design decisions: the new value does NOT bump the notes file version (stays 2; `notesFileVersion` at `src/notes.ts:368` is unchanged). Branch notes are always `side: "working"`. Only the current branch's document is commentable (detection compares against `branchDocumentFileName`), but the parser validates the file name by pattern only (it has no branch).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

In `src/documents.ts`:

- `export const BRANCH_DOCUMENT_FILE_PATTERN = /^branch-[A-Za-z0-9._-]+\.md$/;`
- `import type { NoteDocument } from "./notes";` (type-only; notes.ts already imports values from documents.ts).
- `export const isDocumentNoteFileName = (document: NoteDocument, file: string): boolean` — cluster pattern for `"clusterNotes"`, branch pattern for `"branch"`.
- `ReviewDocuments` gains `deltaReviewDir: string` (the `dir` argument) and `branchDocumentFileName: string` (`branchDocumentFileName(branch)`, set whether or not the file exists). `loadReviewDocuments` fills both.
- `export type DocumentNoteLocations = Pick<ReviewDocuments, "deltaReviewDir" | "clusterNotesDir" | "branchDocumentFileName">;`
- `export const documentNotePath = (locations: DocumentNoteLocations, document: NoteDocument, file: string): string` — `join(clusterNotesDir, file)` for `"clusterNotes"`, `join(deltaReviewDir, file)` for `"branch"`.
- `export const documentNoteRefFor = (fsPath: string, locations: DocumentNoteLocations, normalizeDir: (path: string) => string): { document: NoteDocument; file: string } | undefined`:
  - `dir = normalizeDir(dirname(fsPath))`, `name = basename(fsPath)`.
  - `dir === normalizeDir(locations.clusterNotesDir)` and `CLUSTER_NOTES_FILE_PATTERN.test(name)` → `{ document: "clusterNotes", file: name }`.
  - `dir === normalizeDir(locations.deltaReviewDir)` and `name === locations.branchDocumentFileName` → `{ document: "branch", file: name }`.
  - else `undefined`.
  - Comment why `normalizeDir` is injected (the caller normalizes drive-letter case via `vscode.Uri.file`, keeping this module vscode-free).

In `src/notes.ts`:

- `export type NoteDocument = "clusterNotes" | "branch";`
- Update the `Note.file` / `Note.document` comments to cover both document kinds.
- In `parseNote`: unknown value → `` `${where2}: "document" must be "clusterNotes" or "branch"` ``. File check via `isDocumentNoteFileName(document, value.file)`; on failure keep the existing message for `"clusterNotes"` and use `` `${where2}: a branch document note's "file" must be a branch document file name` `` for `"branch"`. Side check unchanged.

## Gotchas

- `branch-main.md` also matches `CLUSTER_NOTES_FILE_PATTERN`; the two kinds are told apart by `document` and directory, never by name alone.
- Keep the type-only import (`import type`) to avoid a runtime import cycle.
- Existing tests assert the old `"document" must be "clusterNotes"` message (`src/notes.test.ts:113-118`); update them to the new message.
- Any existing test constructing a `ReviewDocuments` literal must gain the two new fields (grep `clusterNotesDir:` in `src/*.test.ts`).

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Write in `src/notes.test.ts` (describe "parseNotesFile document notes"): parses a version 2 `document: "branch"` note with `file: "branch-feat-x.md"`; rejects a branch note whose file is a cluster-style or traversal name (`"notes.md"`, `"../branch-x.md"`, `"branch-a/b.md"`) with the branch message; rejects a base-side branch note; unknown `document` value yields the new message; `notesFileVersion` is 2 for a file holding only a branch note.
- Write in `src/documents.test.ts`: `BRANCH_DOCUMENT_FILE_PATTERN` accepts `branch-feat-x.md`, `branch-Release_1.2.md`, rejects `branch-.md`, `branch-a/b.md`, `branch-x.txt`; `isDocumentNoteFileName` per kind; `documentNotePath` per kind; `documentNoteRefFor` returns the cluster ref, the branch ref, `undefined` for another branch's document, `undefined` for a cluster-pattern file directly in the delta-review dir, and uses `normalizeDir` (e.g. a lowercasing normalizer matches differently-cased dirs); `loadReviewDocuments` returns `deltaReviewDir` and `branchDocumentFileName` (also when the branch document is missing).
