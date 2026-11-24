# 01_08 Review notes on cluster notes documents in the editor and REVIEW NOTES

## Goal

A note target resolves document notes to their document, and every `NoteTarget` consumer handles it in this same task. The reviewer opens a cluster notes document from its row, selects lines, and adds a review note exactly as on code; the thread renders on the document, agent replies merge in, REVIEW NOTES lists it under `<cluster label> — notes`, and clicking that row opens the document at the note.

## Files to modify/create

- `src/noteTarget.ts`
- `src/commentController.ts`
- `src/notesTreeProvider.ts`
- `src/extension.ts`
- `DEVELOPMENT.md`

## Background

- Task 01_07: `Note.document?: "clusterNotes"` with `file` = document file name; `NoteDraft.document?` copied by `createNote` (`src/notesStore.ts`), whose `content` is hashed into `contentBlob` and anchored on `refs/review-notes/<branch>`; `RefreshOptions.readDocumentContent` re-anchors document notes and marks them outdated (last position kept) when the document is missing; response anchors never apply to them. 01_07 left `src/noteTarget.ts` untouched.
- Target (`src/noteTarget.ts`): `NoteTarget` union (`:17-34`), `noteTargetFor(model, note, workingFileExists)` (`:51+`). Its only consumers: `threadTargetFor`/`uriForTarget` (`src/commentController.ts:340-356`) and `deltaReview.openNoteInDiff` (`src/extension.ts:1519-1527`). Adding a union member breaks both `target.path`/`target.sha` uses, so all three change in this task. `CLUSTER_NOTES_FILE_PATTERN` and `clusterSlug` live in `src/documents.ts` (task 01_05). `reviewDocuments.clusterNotesDir` (absolute) is kept in `src/extension.ts` (task 01_06).
- Comment controller (`src/commentController.ts`): factory signature `createNoteCommentController(getGit, getModel, onDidChangeNotes, pendingRead)` (`:141-148`), constructed at `src/extension.ts:303-308`; `repoRelativePath` (`:158-168`); `commentingRangeProvider` (`:170-206`); `threadTargetFor` (`:340-351`) and `uriForTarget` (`:353-356`); `addNote` (`:670`) derives side/path from the URI.
- REVIEW NOTES tree (`src/notesTreeProvider.ts`): groups by `thread.note.file` (`getChildren`, ~`:94-115`), group item label `basename(file)`, description `<dir> · <n>`, id `notesFile:<file>`, collapse key `notesCollapseKeyFor` = `notes:<file>`; constructed at `src/extension.ts:200-203`; collapse handlers at `:253-264`.
- REVIEW NOTES click: `deltaReview.openNoteInDiff` (`src/extension.ts:1480-1535`) looks the note's `file` up in `model.files` first.
- Design decisions:
  - Target: `DocumentNoteTarget { kind: "document"; file: string; lines: "current" }` for a document note whose document exists. A missing document (renamed or deleted) falls back to `{ kind: "base", path: note.file, sha: note.contentBlob, lines: "creation" }`: the thread renders on the creation-time snapshot through the existing base content provider, where the reviewer can still read and close it. The third parameter of `noteTargetFor` becomes "the note's working document exists" (the working file, or the document for a document note). The document branch runs first and never consults `model.files`.
  - Controller gains a fifth parameter `getClusterNotesDir: () => string | undefined`.
  - A `file:` document is a cluster notes document when `dirname(uri.fsPath) === vscode.Uri.file(dir).fsPath` (with `dir = getClusterNotesDir()`; both sides normalized through `vscode.Uri.file(...).fsPath` so a Windows drive-letter case difference still matches) and `basename` matches `CLUSTER_NOTES_FILE_PATTERN`. Such a document gets full-document commenting ranges; `addNote` on it creates a note with `side: "working"`, `file: basename`, `document: "clusterNotes"`, and `content` = the document's full text (so `contentBlob` is the snapshot the missing-document fallback shows). This check runs before `repoRelativePath`: with the common dir inside the repo, `repoRelativePath` would return a `.git/...` path.
  - `threadTargetFor`: for a document note, existence is `existsSync(join(dir, note.file))` (false when the dir is unknown); `uriForTarget` maps `document` to `vscode.Uri.file(join(dir, file))`.
  - REVIEW NOTES groups by `(document, file)`. Document groups sort before code groups; label `documentLabel(file)` from a constructor resolver — `<cluster label> — notes` for the first contract cluster whose `clusterSlug(label) + ".md"` equals `file`, else the file name; description `cluster notes · <n>`; id `notesFile:clusterNotes:<file>`; collapse key `notes:clusterNotes:<file>`. Code groups unchanged.
  - Click on a document note: resolve `noteTargetFor` with document existence, open the target (`document` → file URI, `base` → `createReviewBaseUri(path, sha)`) at the anchor line, expand the thread; no diff, no `model.files` lookup, no DELTA REVIEW reveal.
  - The branch document takes no review notes.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

1. `src/noteTarget.ts`: new target kind and branch at the top of `noteTargetFor`; update the module comment's case list.
2. `src/commentController.ts`: the new parameter; a `clusterNotesFileName(uri)` helper returning the file name or undefined; use it in `provideCommentingRanges` (file scheme) and `addNote` before the repo-relative path; thread target/URI changes above.
3. `src/notesTreeProvider.ts`: `NotesFileGroupElement` gains `document?: "clusterNotes"`; group by a `(document ?? "") + "\0" + file` key; constructor parameter `documentLabel: (file: string) => string`; update `notesCollapseKeyFor` and item rendering for document groups.
4. `src/extension.ts`: pass `() => reviewDocuments?.clusterNotesDir` to the controller and a `documentLabel` resolver over the current cluster model labels (fall back to the file name with no cluster model) to `NotesTreeProvider`; document branch at the top of `deltaReview.openNoteInDiff` (and the existing code-note path's `target.kind` ternary at `:1523-1527` must still type-check against the widened union).
5. `DEVELOPMENT.md` "Review notes": a short "Notes on cluster notes documents" subsection (document key, version rule, where the thread lives, anchors ignored, REVIEW NOTES grouping, and the missing-document fallback to the `contentBlob` snapshot when the agent renames or deletes the document); add the document case to "Where a note's thread lives"; manual steps (add a note on lines of a notes document, agent reply via responses file renders, REVIEW NOTES group label and click, notes file shows `"version": 2` and `"document": "clusterNotes"`, deleting the note writes `"version": 1` again).

## Gotchas

- `onDidOpenTextDocument` re-clamp already covers the `file` scheme; nothing to add.
- Existing notes collapse keys `notes:<path>` must keep working for code groups.
- Never resolve a document note through `model.files`: a repo-root file can share its name.
- Do not offer commenting ranges on the branch document or on files elsewhere in the delta-review dir.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Write in `src/noteTarget.test.ts`: document note with existing document → `document` target; missing → base fallback at `contentBlob` with `creation` lines; a repo file with the same name in `model.files` is not consulted.
- If grouping/sorting logic grows beyond trivial, extract it as a pure function (no `vscode`) beside its consumer and unit-test it; otherwise the existing pure tests from 01_07 cover the data path.
- Scripted extension-host check (`DEVELOPMENT.md`, "Scripted extension-host checks"; `env -u ELECTRON_RUN_AS_NODE`, short `--user-data-dir`, throwaway repo, `DELTA_REVIEW_TEST=1`): with a contract and a cluster notes document, open the document, create a note through the comment API path (`deltaReview.addNote` with a `CommentReply` on a thread created over lines 2-3 of the document, as an existing harness does for code), then assert `notes-<branch>.json` has `"version": 2`, a note with `"document": "clusterNotes"`, `file` = the document's file name, `side: "working"`; append a response for it and assert the note's status becomes `addressed`; rename the document file and assert, after the watcher refresh, the notes file marks the note `"outdated": true` (`__inspect` exposes no note-thread snapshot; the snapshot placement is covered by the `noteTargetFor` unit test); delete it and assert `"version": 1`. Harness in the session scratchpad.
