# 02_02 "Open Cluster Changes" cluster command

## Goal

Add a cluster-row command, **Open Cluster Changes** (`$(diff-multiple)`), to the Delta Review sidebar. It opens every file of that cluster that still needs review in VS Code's multi-diff editor (`vscode.changes`). Each file diffs against its own base: its reviewed snapshot where one exists, otherwise exactly the base its single-file diff uses. The tab is titled `Cluster Changes: <label>` (with a ` (<n>)` index suffix when the label collides with another bucket's). The button is the first inline action on, and first context-menu entry of, any cluster row (real clusters, Unclustered, Auto) with at least one needs-review file. If nothing needs review at click time, an info message reads `No files in '<label>' need review.`

## Files to modify/create

- `src/extension.ts`
- `package.json`
- `DEVELOPMENT.md`
- `README.md`

## Background

- Task 02_01 added `src/clusterChanges.ts`: `clusterLabelForKey(model, key)`, `clusterChangesFiles(files)`, `clusterChangesTitle(model, clusterKey)` (unique per model: adds a ` (<n>)` suffix on label collisions, skipping any `n` whose title is already taken), `nothingToReviewMessage(label)` (plus helpers used by later tasks).
- `openDiff` (`src/extension.ts:697-734`) builds `leftUri = createReviewBaseUri(file.diffBasePath, file.diffBaseSha)`. `rightUri` is `createReviewBaseUri(file.path, undefined)` for a deleted file and `vscode.Uri.file(join(git.repoRoot, file.path))` otherwise. A changed-then-deleted file therefore shows the snapshot on the left and an empty right side, as wanted.
- Cluster command pattern: `deltaReview.markClusterReviewed` (`src/extension.ts:1152-1175`). It takes `element?: ReviewTreeElement`, guards `git`/`model`/`clusterModel`/`element?.kind === "cluster"`, then `clusterFilesForKey(clusterModel, element.clusterKey)`.
- Cluster rows get `contextValue` from `clusterContextValue` (`src/clusters.ts:141-153`): `clusterNeedsReview`, `clusterNeedsReviewSnapshot`, `clusterReviewed`, `clusterEmpty`. The synthetic Unclustered/Auto buckets are cluster rows too (`src/treeProvider.ts:585-618`).
- `package.json`: command declarations are at `:130-140` (`markClusterReviewed` shape: `command`, `title`, `icon`, `category`). Cluster menu entries are at `:326-345` (mark is `inline@2`, unmark `inline@3`, both also plain `"navigation"`). VS Code sorts menu items by group, then order (missing = 0), then title, so a new `navigation@0` would not sort before them. `commandPalette` hides at `:478-482` (`"when": "false"`).
- `vscode.changes` signature: `executeCommand("vscode.changes", title: string, resources: [labelUri: Uri, original: Uri, modified: Uri][])`. The engine is `^1.140.0` (`package.json:9`), which supports it. Nothing in `src/` uses it yet.
- Design decisions (spec): the button appears whenever the cluster has a needs-review file (Decision 3), so it shows on fresh, never-reviewed clusters too. Per-file buttons inside the multi-diff are out of scope (proposed API only). Task 02_03 uses a `title -> { clusterKey, label, paths, leftSides, repoRoot, branch }` map to track tabs and to refuse marking a cluster that changed since its tab opened, so introduce that map here (recorded on every open) to keep 02_03 small. `vscode.changes` creates a new tab on every call, even with an identical title (goals.md Investigation 12), and reopening is the documented workflow, so a map keyed by title is only sound if at most one combined-diff tab carries each title. Rule: before calling `vscode.changes`, close every open combined-diff tab carrying that title.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Extract `const diffUris = (activeGit: Git, file: ReviewFile): { left: vscode.Uri; right: vscode.Uri }` (or a closure over `git`) from `openDiff`, keeping its comment about repo-relative base paths. `openDiff` uses it; its behavior is unchanged.
2. Add `type ClusterChangesEntry = { clusterKey: string; label: string; paths: string[]; leftSides: { path: string; basePath: string; baseQuery: string }[]; repoRoot: string; branch: string }` (`leftSides`: one item per shown file, its `path` plus the identity of the left URI it was opened with, `basePath = left.path.replace(/^\//, "")` and `baseQuery = left.query`; the tab's left documents keep that sha even after the file is marked or re-snapshotted from the sidebar and the model's `diffBaseSha` moves on, so 02_04 matches left-side clicks against these, not the current model; `repoRoot`/`branch`: the repo and branch the tab was opened from; 02_03 refuses to mark and 02_04 refuses to select when either differs from `git.repoRoot` / `model.branch` at use time, since the active SCM repo or the checked-out branch can change while the tab stays open) and `const clusterChangesTabs = new Map<string, ClusterChangesEntry>()` near `openDiff`, with a one-line comment (title of the one open combined diff -> what it shows).
2a. Add `clusterChangesTabsFor(title: string): vscode.Tab[]`: every tab in `vscode.window.tabGroups.all.flatMap(g => g.tabs)` whose `label === title` and whose `input` is not `instanceof` any of `vscode.TabInputText`, `TabInputTextDiff`, `TabInputCustom`, `TabInputWebview`, `TabInputNotebook`, `TabInputNotebookDiff`, `TabInputTerminal` (the stable API has no multi-diff input class, so a multi-diff tab is one whose input matches none of these). Task 02_03 reuses it.
3. Register `deltaReview.openClusterChanges(element?: ReviewTreeElement)`:
   - Apply the same guards as `markClusterReviewed`.
   - Compute `label = clusterLabelForKey(clusterModel, element.clusterKey)` and `files = clusterChangesFiles(clusterFilesForKey(clusterModel, element.clusterKey))`.
   - When `files` is empty, run `void vscode.window.showInformationMessage(nothingToReviewMessage(label))` and return.
   - Otherwise set `title = clusterChangesTitle(clusterModel, element.clusterKey)`. Set `stale = clusterChangesTabsFor(title)`; when it is non-empty, `if (!(await vscode.window.tabGroups.close(stale))) return;` (do not open a second tab beside one that would not close).
   - Compute `resources = files.map(f => ({ file: f, ...diffUris(git, f) }))` once, and build both the entry's `leftSides` and the `vscode.changes` tuples from it, so the recorded left identities are exactly the URIs opened.
   - Only after the close resolves, `clusterChangesTabs.set(title, { clusterKey: element.clusterKey, label, paths: files.map(f => f.path), leftSides: resources.map(r => ({ path: r.file.path, basePath: r.left.path.replace(/^\//, ""), baseQuery: r.left.query })), repoRoot: git.repoRoot, branch: model.branch })` (capture `git` and `model` into locals at the top of the handler, after the guards, and use those same locals here and for `diffUris`, so the entry names the repo and branch the files came from even if a refresh lands during the `await`), then run `await vscode.commands.executeCommand("vscode.changes", title, resources.map(r => [vscode.Uri.file(join(git.repoRoot, r.file.path)), r.left, r.right]))`.
4. `package.json`:
   - Declare `{ "command": "deltaReview.openClusterChanges", "title": "Open Cluster Changes", "icon": "$(diff-multiple)", "category": "Delta Review" }` next to the cluster commands.
   - In `view/item/context`, add two entries with `"when": "view == deltaReview && viewItem =~ /^clusterNeedsReview/"`: one with `"group": "inline@1"` and one with `"group": "navigation@1"`, placed before the existing cluster entries.
   - Change the existing `deltaReview.markClusterReviewed` `"group": "navigation"` entry to `"navigation@2"` and the existing `deltaReview.unmarkClusterReviewed` `"group": "navigation"` entry to `"navigation@3"`. Leave their `inline@2`/`inline@3` entries and every non-cluster entry alone.
   - In `commandPalette`, add `{ "command": "deltaReview.openClusterChanges", "when": "false" }`.
5. `README.md`: one bullet in the clusters section (near `:68`) saying a cluster row's `$(diff-multiple)` action opens all its needs-review files in one combined diff, each against its own base.
6. `DEVELOPMENT.md`: add manual steps after step 31, as `31a.`/`31b.` (no renumbering):
   - Mark a 3-file cluster reviewed, edit two of its files, and press the cluster's `Open Cluster Changes` → a `Cluster Changes: <label>` tab lists exactly those two files, each `last reviewed ↔ working tree`.
   - On a fresh cluster, every needs-review file is listed against the merge base (or move origin). A file changed since review and then deleted shows an empty right side. Unclustered and Auto rows offer the button too. A fully reviewed cluster shows no button. Invoking the command on such a cluster (e.g. via a stale row) shows `No files in '<label>' need review.`
   - Edit another file of the cluster and press `Open Cluster Changes` again → the old tab closes and one tab lists the current files.
   - Two clusters with the same label open as `Cluster Changes: <label> (<n>)` tabs with distinct `n`. The cluster row's context menu lists `Open Cluster Changes` first, then `Mark Reviewed` / `Unmark Reviewed`.

## Gotchas

- `vscode.changes` takes the title first and the resource tuples second. Do not pass `TextDocumentShowOptions`.
- The label URI (first tuple element) must be a `file:` URI for the file's own path even when the file is deleted. It is only used for the header label.
- Do not change `markClusterReviewed`'s behavior.
- Record the map entry after `tabGroups.close` resolves, not before: 02_03 prunes an entry when a tab with its label closes and no such tab remains, so recording first would let the close event delete the fresh entry.
- `tabGroups.close` takes a `Tab[]` and resolves a boolean. Never close tabs that are not combined diffs (a text editor tab can share no label with `Cluster Changes: …` in practice, but the input-class filter is what guarantees it).
- The extension-host test hook `deltaReview.__inspect` (`src/extension.ts:1344-1371`) may be extended for verification only if needed (it is gated on `DELTA_REVIEW_TEST=1`).
- No foreground extension-host launches beyond one batched scripted check (they steal focus).
- Run `yarn format` before finishing.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`. There is no new pure logic here; 02_01's tests cover the helpers.
- Scripted extension-host check (recipe: DEVELOPMENT.md "Scripted extension-host checks"; harness in the session scratchpad, not committed; launch with `env -u ELECTRON_RUN_AS_NODE` and a short `--user-data-dir`). Build a temp repo with a branch, a v3 contract with one cluster of 2 changed files, then:
  - Run `deltaReview.openClusterChanges` with `{ kind: "cluster", clusterKey: "c0" }` and assert that `vscode.window.tabGroups.all` has a tab labeled `Cluster Changes: <label>`.
  - Run it a second time with a file edited: exactly one tab labeled `Cluster Changes: <label>` exists afterwards (the first was closed).
  - Mark both files reviewed and run it again: no new tab opens (the info message path).
- Confirm in `package.json` that the menu entries (with orders `navigation@1`/`@2`/`@3` on the cluster entries) and the palette hide exist (the `yarn build` typecheck does not cover `package.json`).
