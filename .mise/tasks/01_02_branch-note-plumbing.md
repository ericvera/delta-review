# 01_02 Make the Branch overview commentable and route document notes by kind

## Goal

In the source (text) editor, the Branch overview document offers the review-note `+` gutter. Notes created there are saved as `document: "branch"`, render back on that document, re-anchor against it, and open from REVIEW NOTES at the note. Cluster notes documents keep working the same way.

## Files to modify/create

- `src/noteTarget.ts`
- `src/notesStore.ts`
- `src/commentController.ts`
- `src/extension.ts`

## Background

- Task 01_01 added to `src/documents.ts`: `isDocumentNoteFileName(document, file)`, `DocumentNoteLocations`, `documentNotePath(locations, document, file)`, `documentNoteRefFor(fsPath, locations, normalizeDir)`, and the `ReviewDocuments` fields `deltaReviewDir` and `branchDocumentFileName`. `NoteDocument` in `src/notes.ts` is now `"clusterNotes" | "branch"`.
- Today the comment controller only knows the cluster notes dir: factory parameter `getClusterNotesDir` (`src/commentController.ts:172`), detection `clusterNotesFileName` (`:197-208`), used in `provideCommentingRanges` (`:227`), `threadTargetFor` (`:387-393`), `uriForTarget` (`:410-412`) and `addNote` (`:870`, `:899-901`, which hard-codes `document: "clusterNotes"`).
- `src/noteTarget.ts:35-39` `DocumentNoteTarget { kind: "document"; file; lines: "current" }`; `noteTargetFor` builds it at `:67-75`.
- `src/notesStore.ts:641` `RefreshOptions.readDocumentContent?: (fileName) => ...`, called at `:738-739`.
- `src/extension.ts`: controller created at `:328-334` with `() => reviewDocuments?.clusterNotesDir`; `readDocumentContent` at `:612-628`; `noteTargetUri` `:1292-1303`; `openDocumentNote` `:1307-1330` (existence check under `clusterNotesDir`); `__inspect` at `:2196-2221` (registered only with `DELTA_REVIEW_TEST=1`).
- Design decisions: only the current branch's Branch overview is commentable; no realpath canonicalisation (the tree opens documents with the same path string the controller compares); the built-in markdown preview is untouched.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

- `src/noteTarget.ts`: `DocumentNoteTarget` gains `document: NoteDocument`; `noteTargetFor` sets `document: note.document`. Update the module/fn comments that say "cluster notes document" to cover both kinds.
- `src/notesStore.ts`: `readDocumentContent?: (document: NoteDocument, fileName: string) => Promise<string | undefined>`; call `options.readDocumentContent?.(note.document, note.file)`. Update its comment.
- `src/commentController.ts`:
  - Replace parameter `getClusterNotesDir` with `getReviewDocuments: () => ReviewDocuments | undefined`.
  - Replace `clusterNotesFileName` with `documentNoteRef(uri)`: `undefined` unless `uri.scheme === "file"` and documents are loaded; else `documentNoteRefFor(uri.fsPath, documents, (path) => vscode.Uri.file(path).fsPath)`. Keep the comment explaining why it is checked before `repoRelativePath`.
  - `provideCommentingRanges`, `addNote` (`side = "working"`, `path = ref.file`, spread `{ document: ref.document }` when a ref exists), `threadTargetFor` (exists = documents loaded && `existsSync(documentNotePath(documents, note.document, note.file))`), `uriForTarget` (`documentNotePath(documents, target.document, target.file)`).
  - Add to `NoteCommentController` an inspection accessor `commentableDocuments: () => string[]` returning `uri.toString()` of each `vscode.workspace.textDocuments` entry for which the commenting range provider returns a non-empty array (extract the provider body into a local function so both call it).
- `src/extension.ts`:
  - Pass `() => reviewDocuments` to `createNoteCommentController`.
  - `readDocumentContent(document, fileName)`: return `undefined` unless documents are loaded and `isDocumentNoteFileName(document, fileName)`; read `documentNotePath(reviewDocuments, document, fileName)`. Drop the now-unused `CLUSTER_NOTES_FILE_PATTERN` import if nothing else uses it.
  - `noteTargetUri` document case and `openDocumentNote` existence check use `documentNotePath` with the note's/target's `document`.
  - `__inspect` result gains `commentableDocuments: commentController.commentableDocuments()`.

## Gotchas

- `vscode` cannot be imported under Vitest; keep all new logic that needs tests in the pure modules (`documents.ts`, `noteTarget.ts`, `notesStore.ts`).
- Narrow `note.document` before passing it (it is optional on `Note`); TypeScript will flag missed call sites once the signatures change.
- `addNote` must store the document's file name, never a `.git/...` repo-relative path — the ref check stays before `repoRelativePath`.
- Extension-host launches steal focus: run the scripted check once, batched, at the end.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Update `src/noteTarget.test.ts` "document notes" (`:205-230`): the document target carries `document: "clusterNotes"`; add a `"branch"` note case (exists → `{ kind: "document", document: "branch", file, lines: "current" }`; missing → creation-blob base target).
- Update `src/notesStore.test.ts` readDocumentContent tests (`:1382-1460`) to the two-argument signature, and add one asserting a `document: "branch"` note shifts through `readDocumentContent` and receives `"branch"` as its first argument.
- Scripted extension-host check (`DEVELOPMENT.md`, "Scripted extension-host checks"; harness in the session scratchpad, launched with `env -u ELECTRON_RUN_AS_NODE`, `DELTA_REVIEW_TEST=1`): in a temp git repo on a feature branch with one change, write `.git/delta-review/branch-<branch>.md`, a valid clusters contract with one cluster, and `.git/delta-review/cluster-notes-<branch>/<slug>.md`; refresh; run `deltaReview.openDocument` with `vscode.Uri.file(<each path>)`; assert `__inspect().commentableDocuments` contains both URIs, and does not contain a `branch-other.md` written beside them and opened the same way. Then hand-write a notes file `.git/delta-review/notes-<branch>.json` (`"version": 2`) holding a `document: "branch"` note, refresh, and assert the REVIEW NOTES badge counts it. If the cluster notes document is not commentable, report it in the task outcome.
