# 01_08 Review notes on cluster notes documents in the editor and REVIEW NOTES

## Goal

A note target resolves document notes to their document, and every `NoteTarget` consumer handles it in this same task. The reviewer opens a cluster notes document from its row, selects lines, and adds a review note exactly as on code; the thread renders on the document, agent replies merge in, REVIEW NOTES lists it under `<cluster label> — notes`, and clicking that row opens the document at the note.

## Files to modify/create

- `src/noteTarget.ts`
- `src/commentController.ts`
- `src/notesTreeProvider.ts`
- `src/notesGrouping.ts` (new; pure, no `vscode`)
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
3. `src/notesGrouping.ts` (new, no `vscode` import; may import `clusterSlug` from `src/documents.ts`, which is vscode-free):
   - `groupNoteThreads(threads: NoteThread[]): NoteGroup[]` with `NoteGroup = { document?: "clusterNotes"; file: string; threads: NoteThread[] }` — groups by a `(document ?? "") + "\0" + file` key, so a code note and a document note with the same `file` land in separate groups; document groups first, then code groups, each ordered by `file` as today (`src/notesTreeProvider.ts:104`); threads within a group sorted by `note.currentStartLine`.
   - `clusterNotesDocumentLabel(file: string, clusterLabels: readonly string[]): string` — `<label> — notes` for the first label whose `clusterSlug(label)` is non-empty and `clusterSlug(label) + ".md" === file`, else `file`.
   - `notesGroupCollapseKey(group: { document?: "clusterNotes"; file: string }): string` — `notes:clusterNotes:<file>` for document groups, `notes:<file>` for code groups.
4. `src/notesTreeProvider.ts`: `NotesFileGroupElement` gains `document?: "clusterNotes"`; `getChildren` root builds its groups from `groupNoteThreads`; `notesCollapseKeyFor` delegates to `notesGroupCollapseKey`; constructor parameter `documentLabel: (file: string) => string`; item rendering for document groups (label, description, id as in Background).
5. `src/extension.ts`: pass `() => reviewDocuments?.clusterNotesDir` to the controller and a `documentLabel` resolver `(file) => clusterNotesDocumentLabel(file, <current cluster model labels, or [] with no cluster model>)` to `NotesTreeProvider`; document branch at the top of `deltaReview.openNoteInDiff` (and the existing code-note path's `target.kind` ternary at `:1523-1527` must still type-check against the widened union).
6. `DEVELOPMENT.md` "Review notes": a short "Notes on cluster notes documents" subsection (document key, version rule, where the thread lives, anchors ignored, REVIEW NOTES grouping, and the missing-document fallback to the `contentBlob` snapshot when the agent renames or deletes the document); add the document case to "Where a note's thread lives"; manual steps (add a note on lines of a notes document, agent reply via responses file renders, REVIEW NOTES group label and click, notes file shows `"version": 2` and `"document": "clusterNotes"`, deleting the document note (not the document file) writes `"version": 1` again once no document note remains).

## Gotchas

- `onDidOpenTextDocument` re-clamp already covers the `file` scheme; nothing to add.
- Existing notes collapse keys `notes:<path>` must keep working for code groups.
- Never resolve a document note through `model.files`: a repo-root file can share its name.
- Do not offer commenting ranges on the branch document or on files elsewhere in the delta-review dir.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Write in `src/noteTarget.test.ts`: document note with existing document → `document` target; missing → base fallback at `contentBlob` with `creation` lines; a repo file with the same name in `model.files` is not consulted.
- Write `src/notesGrouping.test.ts` (each case fails without the change): `groupNoteThreads` puts document groups before code groups regardless of file-name order; a code note and a document note with the same `file` produce two separate groups; threads within a group are sorted by `currentStartLine`; `clusterNotesDocumentLabel` returns `<label> — notes` for a matching label, the first match when two labels share a slug, and falls back to the file name when no label matches (including an empty label list); `notesGroupCollapseKey` returns `notes:<file>` for a code group and `notes:clusterNotes:<file>` for a document group.
- Scripted extension-host check (`DEVELOPMENT.md`, "Scripted extension-host checks"; `env -u ELECTRON_RUN_AS_NODE`, short `--user-data-dir`, throwaway repo, `DELTA_REVIEW_TEST=1`): with a contract and a cluster notes document, open the document, create notes through the comment API path: no committed harness exists (harnesses are throwaway, `DEVELOPMENT.md` "Scripted extension-host checks"), so the implementer builds the comment-thread setup in the scratch harness — e.g. its own `vscode.comments.createCommentController(...)`, `createCommentThread(documentUri, new vscode.Range(1, 0, 2, 0), [])`, then `deltaReview.addNote` with a `CommentReply` `{ thread, text }` (`addNote`, `src/commentController.ts:670`, reads `reply.thread.uri`, requires the document open in `vscode.workspace.textDocuments`, and adopts `reply.thread` into `threadNoteIds`). Steps, in this order: (1) add note A; assert `notes-<branch>.json` has `"version": 2`, a note with `"document": "clusterNotes"`, `file` = the document's file name, `side: "working"`; (2) append a response for A and assert its status becomes `addressed`; (3) delete A with `deltaReview.deleteNoteThread` passing A's adopted harness thread (no confirm; `src/commentController.ts:864`), before any rename, and assert the notes file is written back with `"version": 1` since no document note remains — do not use `deltaReview.deleteNoteRow`, which opens a modal confirm (`src/extension.ts:1567`), and do not delete after the rename, because `renderThreads` replaces the thread on URI change (`src/commentController.ts:615-617`) and the harness's handle goes stale; (4) add note B on the same document, rename the document file, and assert, after the watcher refresh, the notes file marks B `"outdated": true` (`__inspect` exposes no note-thread snapshot; the snapshot placement is covered by the `noteTargetFor` unit test). Harness in the session scratchpad.
