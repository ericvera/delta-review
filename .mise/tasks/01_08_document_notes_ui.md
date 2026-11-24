# 01_08 Review notes on cluster notes documents in the editor and REVIEW NOTES

## Goal

The reviewer opens a cluster notes document from its row, selects lines, and adds a review note exactly as on code; the thread renders on the document, agent replies merge in, REVIEW NOTES lists it under `<cluster label> — notes`, and clicking that row opens the document at the note.

## Files to modify/create

- `src/commentController.ts`
- `src/notesTreeProvider.ts`
- `src/extension.ts`
- `DEVELOPMENT.md`

## Background

- Task 01_07: `Note.document?: "clusterNotes"` with `file` = document file name; `NoteDraft.document?`; `noteTargetFor` returns `{ kind: "document"; file; lines: "current" }` when its third argument (document exists) is true, else a base fallback. `CLUSTER_NOTES_FILE_PATTERN` and `clusterSlug` live in `src/documents.ts` (task 01_05). `reviewDocuments.clusterNotesDir` (absolute) is kept in `src/extension.ts` (task 01_06).
- Comment controller (`src/commentController.ts`): factory signature `createNoteCommentController(getGit, getModel, onDidChangeNotes, pendingRead)` (`:106-111`), constructed at `src/extension.ts:303-308`; `repoRelativePath` (`:121-131`); `commentingRangeProvider` (`:133-171`); `threadTargetFor` (`:340-351`) and `uriForTarget` (`:353-356`); `addNote` (`:648+`) derives side/path from the URI.
- REVIEW NOTES tree (`src/notesTreeProvider.ts`): groups by `thread.note.file` (`getChildren`, ~`:94-115`), group item label `basename(file)`, description `<dir> · <n>`, id `notesFile:<file>`, collapse key `notesCollapseKeyFor` = `notes:<file>`; constructed at `src/extension.ts:200-203`; collapse handlers at `:253-264`.
- REVIEW NOTES click: `deltaReview.openNoteInDiff` (`src/extension.ts:1480-1535`) looks the note's `file` up in `model.files` first.
- Design decisions:
  - Controller gains a fifth parameter `getClusterNotesDir: () => string | undefined`.
  - A `file:` document is a cluster notes document when `dirname(uri.fsPath) === getClusterNotesDir()` and `basename` matches `CLUSTER_NOTES_FILE_PATTERN`. Such a document gets full-document commenting ranges; `addNote` on it creates a note with `side: "working"`, `file: basename`, `document: "clusterNotes"`. This check runs before `repoRelativePath`: with the common dir inside the repo, `repoRelativePath` would return a `.git/...` path.
  - `threadTargetFor`: for a document note, existence is `existsSync(join(dir, note.file))` (false when the dir is unknown); `uriForTarget` maps `document` to `vscode.Uri.file(join(dir, file))`.
  - REVIEW NOTES groups by `(document, file)`. Document groups sort before code groups; label `documentLabel(file)` from a constructor resolver — `<cluster label> — notes` for the first contract cluster whose `clusterSlug(label) + ".md"` equals `file`, else the file name; description `cluster notes · <n>`; id `notesFile:clusterNotes:<file>`; collapse key `notes:clusterNotes:<file>`. Code groups unchanged.
  - Click on a document note: resolve `noteTargetFor` with document existence, open the target (`document` → file URI, `base` → `createReviewBaseUri(path, sha)`) at the anchor line, expand the thread; no diff, no `model.files` lookup, no DELTA REVIEW reveal.
  - The branch document takes no review notes.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

1. `src/commentController.ts`: the new parameter; a `clusterNotesFileName(uri)` helper returning the file name or undefined; use it in `provideCommentingRanges` (file scheme) and `addNote` before the repo-relative path; thread target/URI changes above.
2. `src/notesTreeProvider.ts`: `NotesFileGroupElement` gains `document?: "clusterNotes"`; group by a `(document ?? "") + "\0" + file` key; constructor parameter `documentLabel: (file: string) => string`; update `notesCollapseKeyFor` and item rendering for document groups.
3. `src/extension.ts`: pass `() => reviewDocuments?.clusterNotesDir` to the controller and a `documentLabel` resolver over the current cluster model labels (fall back to the file name with no cluster model) to `NotesTreeProvider`; document branch at the top of `deltaReview.openNoteInDiff`.
4. `DEVELOPMENT.md` "Review notes": a short "Notes on cluster notes documents" subsection (document key, version rule, where the thread lives, anchors ignored, REVIEW NOTES grouping); add the document case to "Where a note's thread lives"; manual steps (add a note on lines of a notes document, agent reply via responses file renders, REVIEW NOTES group label and click, notes file shows `"version": 2` and `"document": "clusterNotes"`, deleting the note writes `"version": 1` again).

## Gotchas

- `onDidOpenTextDocument` re-clamp already covers the `file` scheme; nothing to add.
- Existing notes collapse keys `notes:<path>` must keep working for code groups.
- Never resolve a document note through `model.files`: a repo-root file can share its name.
- Do not offer commenting ranges on the branch document or on files elsewhere in the delta-review dir.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- If grouping/sorting logic grows beyond trivial, extract it as a pure function (no `vscode`) beside its consumer and unit-test it; otherwise the existing pure tests from 01_07 cover the data path.
- Scripted extension-host check (`DEVELOPMENT.md`, "Scripted extension-host checks"; `env -u ELECTRON_RUN_AS_NODE`, short `--user-data-dir`, throwaway repo, `DELTA_REVIEW_TEST=1`): with a contract and a cluster notes document, open the document, create a note through the comment API path (`deltaReview.addNote` with a `CommentReply` on a thread created over lines 2-3 of the document, as an existing harness does for code), then assert `notes-<branch>.json` has `"version": 2`, a note with `"document": "clusterNotes"`, `file` = the document's file name, `side: "working"`; append a response for it and assert the note's status becomes `addressed`; delete it and assert `"version": 1`. Harness in the session scratchpad.
