# 01_02 Make the Branch overview commentable and route document notes by kind

## Goal

In the source (text) editor, the Branch overview document offers the review-note `+` gutter. Notes created there are saved as `document: "branch"` (verified by the scripted check driving `deltaReview.addNote`), render back on that document, re-anchor against it, and open from REVIEW NOTES at the note. Cluster notes documents keep working the same way.

## Files to modify/create

- `src/noteTarget.ts`
- `src/notesStore.ts`
- `src/commentController.ts`
- `src/extension.ts`

## Background

- Task 01_01 added to `src/documents.ts`: `isDocumentNoteFileName(document, file)`, `DocumentNoteLocations`, `documentNotePath(locations, document, file)`, `documentNoteRefFor(fsPath, locations, normalizeDir)`, and the `ReviewDocuments` fields `deltaReviewDir` and `branchDocumentFileName`. `NoteDocument` in `src/notes.ts` is now `"clusterNotes" | "branch"`.
- Task 01_01 also added `canonicalDir(path)` (realpath with fallback to the input) to `src/documents.ts`; `documentNoteRefFor` skips the normalizer for file names that cannot be document notes.
- Today the comment controller only knows the cluster notes dir: factory parameter `getClusterNotesDir` (`src/commentController.ts:172`), detection `clusterNotesFileName` (`:197-208`, exact `dirname` equality, which fails when the document's path and the git common dir's path are different spellings of one directory, e.g. symlinks or macOS `/var` vs `/private/var`), `CLUSTER_NOTES_FILE_PATTERN` imported only for it (`:5`), used in `provideCommentingRanges` (`:227`), `threadTargetFor` (`:387-393`), `uriForTarget` (`:410-412`) and `addNote` (`:870`, `:899-901`, which hard-codes `document: "clusterNotes"`).
- `src/noteTarget.ts:35-39` `DocumentNoteTarget { kind: "document"; file; lines: "current" }`; `noteTargetFor` builds it at `:67-75`.
- `src/notesStore.ts:641` `RefreshOptions.readDocumentContent?: (fileName) => ...`, called at `:738-739`.
- `src/extension.ts`: controller created at `:328-334` with `() => reviewDocuments?.clusterNotesDir`; `readDocumentContent` at `:612-628`; `noteTargetUri` `:1292-1303`; `openDocumentNote` `:1307-1330` (existence check under `clusterNotesDir`); `__inspect` at `:2196-2221` (registered only with `DELTA_REVIEW_TEST=1`); its `collectTreeRows` (`:2171-2194`) builds each row from `treeProvider.getTreeItem`. Document rows (`src/treeProvider.ts:650-689`) carry `item.command.arguments = [vscode.Uri.file(path)]`. `repoRoot` comes from the git API's `rootUri.fsPath` (`src/extension.ts:907`, `:2239`) or the workspace folder (`:2278`).
- Design decisions: only the current branch's Branch overview is commentable; detection compares real paths on both sides (fixing cluster notes documents that fail to take notes when path spellings differ); comment threads keep attaching to the `documentNotePath` URI, the path the tree opens; the built-in markdown preview is untouched.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

- `src/noteTarget.ts`: `DocumentNoteTarget` gains `document: NoteDocument`; `noteTargetFor` sets `document: note.document`. Update the module/fn comments that say "cluster notes document" to cover both kinds.
- `src/notesStore.ts`: `readDocumentContent?: (document: NoteDocument, fileName: string) => Promise<string | undefined>`; call `options.readDocumentContent?.(note.document, note.file)`. Update its comment.
- `src/commentController.ts`:
  - Replace parameter `getClusterNotesDir` with `getReviewDocuments: () => ReviewDocuments | undefined`.
  - Replace `clusterNotesFileName` with `documentNoteRef(uri)`: `undefined` unless `uri.scheme === "file"` and documents are loaded; else `documentNoteRefFor(uri.fsPath, documents, (path) => vscode.Uri.file(canonicalDir(path)).fsPath)`. Keep the comment explaining why it is checked before `repoRelativePath`; replace the drive-letter comment with one covering realpath plus drive-letter case.
  - Remove the now-unused `CLUSTER_NOTES_FILE_PATTERN` import (`:5`).
  - `provideCommentingRanges`, `addNote` (`side = "working"`, `path = ref.file`, spread `{ document: ref.document }` when a ref exists), `threadTargetFor` (exists = documents loaded && `existsSync(documentNotePath(documents, note.document, note.file))`), `uriForTarget` (`documentNotePath(documents, target.document, target.file)`).
  - Add to `NoteCommentController` an inspection accessor `commentableDocuments: () => string[]` returning `uri.toString()` of each `vscode.workspace.textDocuments` entry for which the commenting range provider returns a non-empty array (extract the provider body into a local function so both call it).
- `src/extension.ts`:
  - Pass `() => reviewDocuments` to `createNoteCommentController`.
  - `readDocumentContent(document, fileName)`: return `undefined` unless documents are loaded and `isDocumentNoteFileName(document, fileName)`; read `documentNotePath(reviewDocuments, document, fileName)`. Drop the now-unused `CLUSTER_NOTES_FILE_PATTERN` import if nothing else uses it.
  - `noteTargetUri` document case and `openDocumentNote` existence check use `documentNotePath` with the note's/target's `document`.
  - `__inspect` result gains `commentableDocuments: commentController.commentableDocuments()`.
  - Each `collectTreeRows` entry gains `commandUri`: `item.command?.arguments?.[0]` `.toString()` when it is a `vscode.Uri` (`instanceof vscode.Uri`), else `undefined`.

## Gotchas

- `vscode` cannot be imported under Vitest; keep all new logic that needs tests in the pure modules (`documents.ts`, `noteTarget.ts`, `notesStore.ts`).
- Narrow `note.document` before passing it (it is optional on `Note`); TypeScript will flag missed call sites once the signatures change.
- `addNote` must store the document's file name, never a `.git/...` repo-relative path — the ref check stays before `repoRelativePath`.
- `provideCommentingRanges` runs for every open document; the realpath call must stay behind `documentNoteRefFor`'s file-name and parent-leaf filter (task 01_01), never on every file.
- A document opened under a non-tree spelling gets the gutter and saves notes correctly, but threads render on the tree-path URI; this is by design, do not chase it.
- Extension-host launches steal focus: run the scripted check once, batched, at the end.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Update `src/noteTarget.test.ts` "document notes" (`:205-230`): the document target carries `document: "clusterNotes"`; add a `"branch"` note case (exists → `{ kind: "document", document: "branch", file, lines: "current" }`; missing → creation-blob base target).
- Update `src/notesStore.test.ts` readDocumentContent tests (`:1382-1460`) to the two-argument signature, and add one asserting a `document: "branch"` note shifts through `readDocumentContent` and receives `"branch"` as its first argument.
- Scripted extension-host check (`DEVELOPMENT.md`, "Scripted extension-host checks"; harness in the session scratchpad, launched with `env -u ELECTRON_RUN_AS_NODE`, `DELTA_REVIEW_TEST=1`). Create the temp git repo under `fs.mkdtempSync(path.join(os.tmpdir(), ...))` WITHOUT realpath, and open it as the workspace folder by that path, so on macOS the workspace path (`/var/...`) and the real path (`/private/var/...`) differ. On a feature branch with one change, write `.git/delta-review/branch-<branch>.md`, a valid clusters contract with one cluster, and `.git/delta-review/cluster-notes-<branch>/<slug>.md`; refresh. Then:
  - Take the `Branch overview` and `Cluster notes` rows from `__inspect().treeRows`, run `deltaReview.openDocument` with `vscode.Uri.parse(row.commandUri)` for each (the tree's own path), and assert `__inspect().commentableDocuments` contains both URIs.
  - Open each document again under the other spelling (`fs.realpathSync` of the tree path if it differs, else the `os.tmpdir()`-based spelling) via `vscode.workspace.openTextDocument` + `showTextDocument`, and assert those URIs are commentable too. Log both spellings; if they are identical on the test machine, add a `fs.symlinkSync` alias of the repo dir and open through that instead.
  - Write `branch-other.md` beside the branch document, open it the same way, and assert it is not commentable.
  - Exercise the controller's create path: with the tree-path Branch overview open, the harness creates its own controller (`vscode.comments.createCommentController("harness", "harness")`), a thread on the document's URI with `new vscode.Range(1, 0, 2, 0)` and no comments, and runs `vscode.commands.executeCommand("deltaReview.addNote", { thread, text: "branch note" })`. Then read `.git/delta-review/notes-<branch>.json` and assert `"version": 2` and one note with `"document": "branch"`, `"file": "branch-<sanitized branch>.md"`, `"side": "working"`, `startLine` 2, `endLine` 3. Repeat on the cluster notes document and assert that note has `"document": "clusterNotes"` and `file` = `<slug>.md`. Assert `__inspect().notesBadge` counts both.
  - Run `deltaReview.refresh` and assert `__inspect().notesBadge` still counts both (the written file round-trips through `parseNotesFile`).
