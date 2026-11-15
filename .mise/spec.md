# Spec: moved files inherit review across split/overwritten origins; combined cluster diff

## What

1. A declared (or detected) whole-file repo move inherits its old path's reviewed snapshot in two cases that are blocked today:
   - Extraction entries (`fromLines` set) naming the same `from` no longer make the origin "shared". Only whole-file moves (`fromLines === undefined`) count toward the shared-origin rule.
   - The origin may be its own row in the review set when that row is only its deletion (the path is in the review set and absent from the working tree). A `from` that is its own row and still exists on disk (including a case-only rename seen through a case-insensitive filesystem) still blocks inheritance.
   - Marking the origin's deletion row reviewed does not cancel the inheritance: the moved file keeps diffing against the snapshot it inherited and still reads Needs Review; the deletion row reads Reviewed on its own (goals Decision 1).
   - Unmarking a moved file that inherits still drops the origin's key, so an origin deletion row is unmarked with it (goals Decision 2, accepted).
2. A new cluster-row command **Open Cluster Changes** (`$(diff-multiple)`) opens every file of the cluster that needs review in VS Code's multi-diff editor (`vscode.changes`), each against its own base (reviewed snapshot where one exists, otherwise the base the single-file diff uses), titled `Cluster Changes: <label>`. It shows on any cluster row with at least one needs-review file (real clusters, Unclustered, Auto), first inline and first in the context menu. If nothing needs review at click time, an info message reads `No files in '<label>' need review.`
   - The combined diff's editor title bar offers **Mark Cluster Reviewed** (`$(check-all)`, first), which marks every needs-review file of that cluster (same as the sidebar's cluster Mark Reviewed). The tab stays open.
   - While the combined diff is the active tab, moving the cursor into a file's text on either side (click or keyboard) selects that file's row in the Delta Review pane without taking focus; nothing happens when the pane is hidden/collapsed, or when the row is already selected. Ordinary editors and single-file diffs do not move the selection.

## Design

### Task 1: inheritance rules (`src/model.ts`)

- `fromCounts` in `computeReviewModel` counts only moves with `fromLines === undefined`. `originShared` keeps its meaning: "more than one whole-file move resolved for the review set has this `from`".
- `selectReviewSnapshot` input `reviewPaths: ReadonlySet<string>` is replaced by `liveReviewPaths: ReadonlySet<string>`: review-set paths present in the working tree (the keys of `currentShaByPath`). The condition `!input.reviewPaths.has(move.from)` becomes `!input.liveReviewPaths.has(move.from)`. The `originDeleted` pre-check in `computeReviewModel` uses the same set. `isAbsentAtExactCase` stays in the pre-check unchanged. Case-only-rename guard: on a case-insensitive filesystem a case-renamed `from` that is its own row passes `existsSync`, is hashed into `currentShaByPath`, is therefore live, and is rejected.

### Task 1: pre-deletion snapshots (Decision 1)

- New sibling ref `refs/review-predeletion/<branch>`. Its tree maps path to the snapshot blob that path held in `refs/review/<branch>` just before its deletion was marked reviewed (the moment the sentinel overwrote it). It uses the same tree format as the review ref (`100644 <sha> 0\t<path>`, commit chain with parents).
- `src/reviewState.ts`:
  - Generalize the existing read/write into ref-parameterized helpers (`readSnapshotTree(git, ref)`, `writeSnapshotTree(git, ref, map)`). `readReviewState` / `writeReviewState` become thin wrappers. Add `preDeletionRefForBranch(branch)` and `readPreDeletionState(git, branch)`.
  - `markReviewed`: for each deleted path P being marked, when the review state's prior value for P is defined and is not the sentinel, record `pre[P] = prior`. When the prior value is already the sentinel, leave `pre[P]` as it is. For each existing path being marked, delete `pre[path]`. Write the pre-deletion ref only when the map changed.
  - `unmarkReviewed`: also delete `pre[path]` for every unmarked path, and write only when changed.
  - `clearAllReviewSnapshots`: also writes an empty pre-deletion tree when it is non-empty.
- `src/model.ts`: new exported pure helper `originSnapshotSha(from, reviewState, preDeletionState, sentinelSha)`. It returns `reviewState.get(from)`, except that when that value is the sentinel it returns `preDeletionState.get(from)` (possibly undefined). `selectReviewSnapshot` gains input `preDeletionState: ReadonlyMap<string, string>` and computes `inheritedSha` with the helper. The `!== sentinelSha` check stays as a guard. `computeReviewModel` reads `readPreDeletionState` and uses the helper for `oldSha` in the `originDeleted` pre-check. The deletion row's own status is unchanged (own === sentinel === currentSha means Reviewed).
- `src/extension.ts` `deltaReview.clearReviewState` also deletes `refs/review-predeletion/<branch>` (like `deleteSliceRef`).
- The resulting behavior: marking deletion row P writes the sentinel to P and saves X to `pre[P]`, and moved file F keeps inheriting X. Unmarking F drops F, P and `pre[P]` (Decision 2). Unmarking P drops P and `pre[P]`, so F stops inheriting. That coupling already existed before this change. An older sentinel with no snapshot behind it still blocks inheritance.

### Task 2: combined cluster diff

- New VS Code-free module `src/clusterChanges.ts` (+ `src/clusterChanges.test.ts`):
  - `clusterLabelForKey(model: ClusterModel, clusterKey): string` returns `"Unclustered"`, `"Auto"`, or the bucket label (`""` when unknown).
  - `clusterChangesFiles(files: readonly ReviewFile[]): ReviewFile[]` returns the needs-review files in the given (path) order.
  - `clusterChangesTitle(label): string` returns `` `Cluster Changes: ${label}` ``.
  - `nothingToReviewMessage(label): string` returns `` `No files in '${label}' need review.` ``.
  - `fileForDiffDocument(files, doc: { scheme: "file" | "base"; path: string; query?: string }): ReviewFile | undefined` resolves an editor document to the file whose diff shows it. `"file"` with a repo-relative path matches `file.path` (non-deleted files). `"base"` with path and query matches either `diffBasePath === path && (diffBaseSha ?? "empty") === query`, or a deleted file's right side (`path === file.path && query === "empty"`). The first match in list order wins.
- `src/extension.ts`:
  - Extract `diffUris(file): { left: vscode.Uri; right: vscode.Uri }` from `openDiff`; `openDiff` uses it.
  - `deltaReview.openClusterChanges(element: cluster)` resolves the files with `clusterFilesForKey` and `clusterChangesFiles`. When none are left it shows the info message. Otherwise it records `title -> { clusterKey, paths }` in an in-memory `clusterChangesTabs` map and runs `vscode.changes(title, files.map(f => [Uri.file(abs f.path), left, right]))`.
  - Active-tab tracking: a helper `activeClusterChanges()` reads `window.tabGroups.activeTabGroup.activeTab`. It matches when the tab's `input` is not one of the known stable input classes (`TabInputText`, `TabInputTextDiff`, `TabInputCustom`, `TabInputWebview`, `TabInputNotebook`, `TabInputNotebookDiff`, `TabInputTerminal`) and its `label` is a key of `clusterChangesTabs`; it then returns the entry. On `tabGroups.onDidChangeTabs` and `onDidChangeTabGroups`, `setContext("deltaReview.clusterChangesActive", activeClusterChanges() !== undefined)`.
  - `deltaReview.markClusterChangesReviewed` (editor title, `when: activeEditor == 'multiDiffEditor' && deltaReview.clusterChangesActive`, group `navigation@0`) resolves the active entry's `clusterKey` and marks that cluster's current needs-review files the same way `markClusterReviewed` does (shared helper).
  - Click-to-select: `window.onDidChangeActiveTextEditor`. When `activeClusterChanges()` is defined and `treeView.visible`, it maps `editor.document.uri` (scheme `file` under the repo root to a relative path; scheme `REVIEW_BASE_SCHEME` to `{path without leading "/", query}`) through `fileForDiffDocument` over the model files whose paths are in the entry's `paths`. It skips when `treeView.selection` already holds a file element with that path, otherwise calls the existing `revealFileRow(file)`.
- `package.json`: declare both commands. Add `openClusterChanges` to `view/item/context` (`viewItem =~ /^clusterNeedsReview/`, `inline@1` and `navigation@0`) and `markClusterChangesReviewed` to a new `editor/title` menu. Hide both in `commandPalette` (`when: false`).
- Nothing is removed.

## Hard-to-undo

- New ref writes: `markReviewed`, `unmarkReviewed` and `clearAllReviewSnapshots` write commits to the new `refs/review-predeletion/<branch>` in users' repos.
- New ref delete: Clear Review State runs `git update-ref -d refs/review-predeletion/<branch>`.
- Data delete (Decision 2, accepted): unmarking a moved file that inherits from an origin that is its own deletion row deletes that origin row's snapshot key (and its pre-deletion entry) from `refs/review/<branch>`; the row's mark is lost (the ref history keeps the old commit).

## Task index

| Task file | What it does | Files |
| --- | --- | --- |
| `01_01_inherit-rules.md` | Count only whole-file moves for shared origins; allow inheriting from an origin that is only a deletion row | `src/model.ts`, `DEVELOPMENT.md` (+ `src/model.test.ts`) |
| `01_02_predeletion-snapshots.md` | Keep the inherited snapshot when the origin's deletion row is marked, via `refs/review-predeletion/<branch>` | `src/reviewState.ts`, `src/model.ts`, `src/extension.ts`, `DEVELOPMENT.md` (+ `src/reviewState.test.ts`, `src/model.test.ts`) |
| `02_01_cluster-changes-logic.md` | Pure helpers for the combined cluster diff (file selection, title, message, document-to-file lookup) | `src/clusterChanges.ts` (+ `src/clusterChanges.test.ts`) |
| `02_02_open-cluster-changes.md` | "Open Cluster Changes" cluster command opening the multi-diff editor | `src/extension.ts`, `package.json`, `DEVELOPMENT.md`, `README.md` |
| `02_03_mark-from-combined-diff.md` | Track the active combined-diff tab and add the "Mark Cluster Reviewed" editor-title button | `src/extension.ts`, `package.json`, `DEVELOPMENT.md` |
| `02_04_click-to-select.md` | Clicking into a file in the combined diff selects its row in the pane | `src/extension.ts`, `DEVELOPMENT.md` |
