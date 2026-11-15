# 02_02 "Open Cluster Changes" cluster command

## Goal

Add a cluster-row command, **Open Cluster Changes** (`$(diff-multiple)`), to the Delta Review sidebar. It opens every file of that cluster that still needs review in VS Code's multi-diff editor (`vscode.changes`). Each file diffs against its own base: its reviewed snapshot where one exists, otherwise exactly the base its single-file diff uses. The tab is titled `Cluster Changes: <label>`. The button is the first inline action on, and first context-menu entry of, any cluster row (real clusters, Unclustered, Auto) with at least one needs-review file. If nothing needs review at click time, an info message reads `No files in '<label>' need review.`

## Files to modify/create

- `src/extension.ts`
- `package.json`
- `DEVELOPMENT.md`
- `README.md`

## Background

- Task 02_01 added `src/clusterChanges.ts`: `clusterLabelForKey(model, key)`, `clusterChangesFiles(files)`, `clusterChangesTitle(label)`, `nothingToReviewMessage(label)` (plus helpers used by later tasks).
- `openDiff` (`src/extension.ts:697-734`) builds `leftUri = createReviewBaseUri(file.diffBasePath, file.diffBaseSha)`. `rightUri` is `createReviewBaseUri(file.path, undefined)` for a deleted file and `vscode.Uri.file(join(git.repoRoot, file.path))` otherwise. A changed-then-deleted file therefore shows the snapshot on the left and an empty right side, as wanted.
- Cluster command pattern: `deltaReview.markClusterReviewed` (`src/extension.ts:1152-1175`). It takes `element?: ReviewTreeElement`, guards `git`/`model`/`clusterModel`/`element?.kind === "cluster"`, then `clusterFilesForKey(clusterModel, element.clusterKey)`.
- Cluster rows get `contextValue` from `clusterContextValue` (`src/clusters.ts:141-153`): `clusterNeedsReview`, `clusterNeedsReviewSnapshot`, `clusterReviewed`, `clusterEmpty`. The synthetic Unclustered/Auto buckets are cluster rows too (`src/treeProvider.ts:585-618`).
- `package.json`: command declarations are at `:130-140` (`markClusterReviewed` shape: `command`, `title`, `icon`, `category`). Cluster menu entries are at `:326-345` (mark is `inline@2`, unmark `inline@3`, both also `navigation`). `commandPalette` hides at `:478-482` (`"when": "false"`).
- `vscode.changes` signature: `executeCommand("vscode.changes", title: string, resources: [labelUri: Uri, original: Uri, modified: Uri][])`. The engine is `^1.140.0` (`package.json:9`), which supports it. Nothing in `src/` uses it yet.
- Design decisions (spec): the button appears whenever the cluster has a needs-review file (Decision 3), so it shows on fresh, never-reviewed clusters too. Per-file buttons inside the multi-diff are out of scope (proposed API only). Task 02_03 adds a `title -> { clusterKey, paths }` map for tab tracking, so introduce that map here (recorded on every open) to keep 02_03 small.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Extract `const diffUris = (activeGit: Git, file: ReviewFile): { left: vscode.Uri; right: vscode.Uri }` (or a closure over `git`) from `openDiff`, keeping its comment about repo-relative base paths. `openDiff` uses it; its behavior is unchanged.
2. Add `const clusterChangesTabs = new Map<string, { clusterKey: string; paths: string[] }>()` near `openDiff`, with a one-line comment (title of an open combined diff -> what it shows).
3. Register `deltaReview.openClusterChanges(element?: ReviewTreeElement)`:
   - Apply the same guards as `markClusterReviewed`.
   - Compute `label = clusterLabelForKey(clusterModel, element.clusterKey)` and `files = clusterChangesFiles(clusterFilesForKey(clusterModel, element.clusterKey))`.
   - When `files` is empty, run `void vscode.window.showInformationMessage(nothingToReviewMessage(label))` and return.
   - Otherwise set `title = clusterChangesTitle(label)` and `clusterChangesTabs.set(title, { clusterKey: element.clusterKey, paths: files.map(f => f.path) })`, then run `await vscode.commands.executeCommand("vscode.changes", title, files.map(f => { const { left, right } = diffUris(git, f); return [vscode.Uri.file(join(git.repoRoot, f.path)), left, right]; }))`.
4. `package.json`:
   - Declare `{ "command": "deltaReview.openClusterChanges", "title": "Open Cluster Changes", "icon": "$(diff-multiple)", "category": "Delta Review" }` next to the cluster commands.
   - In `view/item/context`, add two entries with `"when": "view == deltaReview && viewItem =~ /^clusterNeedsReview/"`: one with `"group": "inline@1"` and one with `"group": "navigation@0"`, placed before the existing cluster entries.
   - In `commandPalette`, add `{ "command": "deltaReview.openClusterChanges", "when": "false" }`.
5. `README.md`: one bullet in the clusters section (near `:68`) saying a cluster row's `$(diff-multiple)` action opens all its needs-review files in one combined diff, each against its own base.
6. `DEVELOPMENT.md`: add manual steps after step 31, as `31a.`/`31b.` (no renumbering):
   - Mark a 3-file cluster reviewed, edit two of its files, and press the cluster's `Open Cluster Changes` → a `Cluster Changes: <label>` tab lists exactly those two files, each `last reviewed ↔ working tree`.
   - On a fresh cluster, every needs-review file is listed against the merge base (or move origin). A file changed since review and then deleted shows an empty right side. Unclustered and Auto rows offer the button too. A fully reviewed cluster shows no button. Invoking the command on such a cluster (e.g. via a stale row) shows `No files in '<label>' need review.`

## Gotchas

- `vscode.changes` takes the title first and the resource tuples second. Do not pass `TextDocumentShowOptions`.
- The label URI (first tuple element) must be a `file:` URI for the file's own path even when the file is deleted. It is only used for the header label.
- Do not change `markClusterReviewed`'s behavior.
- The extension-host test hook `deltaReview.__inspect` (`src/extension.ts:1344-1371`) may be extended for verification only if needed (it is gated on `DELTA_REVIEW_TEST=1`).
- No foreground extension-host launches beyond one batched scripted check (they steal focus).
- Run `yarn format` before finishing.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`. There is no new pure logic here; 02_01's tests cover the helpers.
- Scripted extension-host check (recipe: DEVELOPMENT.md "Scripted extension-host checks"; harness in the session scratchpad, not committed; launch with `env -u ELECTRON_RUN_AS_NODE` and a short `--user-data-dir`). Build a temp repo with a branch, a v3 contract with one cluster of 2 changed files, then:
  - Run `deltaReview.openClusterChanges` with `{ kind: "cluster", clusterKey: "c0" }` and assert that `vscode.window.tabGroups.all` has a tab labeled `Cluster Changes: <label>`.
  - Mark both files reviewed and run it again: no new tab opens (the info message path).
- Confirm in `package.json` that the menu entries and the palette hide exist (the `yarn build` typecheck does not cover `package.json`).
