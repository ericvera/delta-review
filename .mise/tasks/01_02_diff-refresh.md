# 01_02 Combined diff tab stays current

## Goal

The combined "Cluster Changes: <label>" multi-diff tab is rebuilt whenever its cluster's needs-review files or any shown file's diff base change. That covers review marks of every kind, auto-review, edits that move files into or out of needs-review, and agent edits to the clusters contract.

- Only the active tab of the active editor group rebuilds immediately. A background tab rebuilds when it becomes active.
- When nothing is left to review, the tab stays open and empty.
- Release versions are bumped.

## Files to modify/create

- src/clusterChanges.ts
- src/extension.ts
- DEVELOPMENT.md
- package.json
- plugin/.claude-plugin/plugin.json
- Tests: src/clusterChanges.test.ts

## Background

- Delta Review is a VS Code SCM-sidebar extension that reviews a branch file by file. The "Open Cluster Changes" command opens one multi-diff tab per cluster.
- `deltaReview.openClusterChanges` (src/extension.ts:1330-1385):
  - It computes needs-review files with `clusterChangesFiles` (src/clusterChanges.ts:24-26).
  - On zero files, it shows `nothingToReviewMessage` and returns.
  - It closes any existing tab with the same title (1354-1357) and records a `ClusterChangesEntry` in `clusterChangesTabs` (types at 733-742, set at 1362-1373).
  - It calls `vscode.changes(title, [[resourceUri, left, right], ...])` (1374-1382).
  - Nothing updates the tab afterwards. That is the bug-shaped gap this task closes.
- Tab helpers:
  - `isClusterChangesLabel` (746-750) accepts `title` or `title (N files)`.
  - `isStableTabInput` (754-761) and `clusterChangesTabsFor(title)` (762-769) find the tabs.
  - `clusterChangesTitlesForTab` (773-779) and `activeClusterChanges()` (784-791) use `tabGroups.activeTabGroup.activeTab`.
  - The `onDidChangeTabs` handler (800-816) drops an entry once no tab carries its title.
- `diffUris(activeGit, file)` (718-731) builds the left and right URIs. `left` is `createReviewBaseUri(file.diffBasePath, file.diffBaseSha)`, with path `/${path}` and query `sha ?? "empty"` (src/baseDocument.ts:39-45).
- `refresh()` assigns `clusterModel` and `model` and calls `treeProvider.setModel(model)` at extension.ts:449-462, guarded by `generation !== refreshGeneration` checks (pattern at 350, 443, 504). Every review mark goes through `applyReviewStateChange` (605-621), which calls `refresh()`. File and contract watchers call `scheduleRefresh` (632-694). So hooking the end of a successful `refresh()` covers every trigger.
- Title-bar `deltaReview.markClusterChangesReviewed` (1392-1457) uses `clusterChangesMarkPaths` (clusterChanges.ts:91-115). It refuses with `changedClusterMessage` when the source, title, or label differ.
- Selection sync (extension.ts:867-920) reads `entry.leftSides`, so keep that field.
- `createSerialQueue` is in src/serialQueue.ts.
- Design decisions:
  - Rebuild trigger: any change to the ordered list of (path, diffBasePath, diffBaseSha, deleted) for the cluster's needs-review files. The right side is the live file, so plain edits that keep needs-review status need no rebuild.
  - Only the active tab of the active group rebuilds. Background tabs are never rebuilt (no focus steal, no tab moving). Each is checked when it becomes active, via tab and tab-group change events.
  - Last needs-review file gone: the tab is NOT closed. It is rebuilt with zero resources (VS Code's empty multi-diff state).
  - Renamed, reordered, or removed cluster, or a different repo or branch: no rebuild, and today's `changedClusterMessage` behavior stays.
  - Versions: package.json 0.12.0 to 0.13.0, plugin/.claude-plugin/plugin.json 0.7.1 to 0.8.0. The plugin bump covers the cluster skill's `wait` key added by task 01_01.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. src/clusterChanges.ts (pure, no `vscode` import):
   - `export const clusterChangesSignature = (files: readonly ReviewFile[]): string[]` maps each file to `` [file.path, file.diffBasePath, file.diffBaseSha ?? "empty", file.deleted ? "D" : ""].join("\0") ``.
   - `export const clusterChangesRebuild = (entry: ClusterChangesSource & { title; label; signature: readonly string[] }, current: ClusterChangesSource & { title; label }, clusterFiles: readonly ReviewFile[])` returns one of:
     - `{ kind: "changed-cluster" }` when the source, title, or label differ. Factor the comparison already in `clusterChangesMarkPaths` into a shared private helper and use it in both.
     - `{ kind: "unchanged" }` when the signature of `clusterChangesFiles(clusterFiles)` equals `entry.signature` element-wise.
     - `{ kind: "rebuild"; files: ReviewFile[] }` otherwise. `files` may be empty.
   - Add `export const emptyClusterChangesMessage = (label: string) => `Nothing to review in '${label}'. Files reappear here if they change.``. It is used only by the fallback in step 2.
2. src/extension.ts:
   - Add `signature: string[]` to `ClusterChangesEntry`.
   - Extract from `openClusterChanges` a helper `showClusterChanges(activeGit, branch, title, clusterKey, label, files)`. It builds the resources and the entry (incl. `signature: clusterChangesSignature(files)`), calls `clusterChangesTabs.set`, and calls `vscode.changes` with zero or more resources. `openClusterChanges` keeps its zero-files message and its close-stale-then-open behavior, and calls the helper.
   - Add `rebuildClusterChanges(title, entry, files)`:
     1. `const before = new Set(clusterChangesTabsFor(title))`, with the previous entry saved.
     2. `rebuildingClusterChanges = true`.
     3. Call `showClusterChanges(...)`.
     4. `const opened = clusterChangesTabsFor(title).filter((tab) => !before.has(tab))`.
     5. If `opened.length > 0`, close the still-open members of `before` with `vscode.window.tabGroups.close([...])`.
     6. Otherwise, restore the previous entry. If `files.length === 0`, show `emptyClusterChangesMessage(label)` as an information message.
     7. In `finally`, reset the flag and call `updateClusterChangesContext()`.
   - Opening first means the new tab lands beside the active old one, and the old position survives the close. The title's tab count never hits zero, so the closed handler keeps the entry.
   - Add `const clusterChangesQueue = createSerialQueue()` and `syncActiveClusterChanges = () => clusterChangesQueue.run(async () => { ... })`. Inside, return early unless all of these hold:
     - `git`, `model`, and `clusterModel` are defined
     - `clusterChangesTitlesForTab(activeTabGroup.activeTab)` has exactly one title
     - `clusterChangesTabsFor(title).length === 1`
   - It then calls `clusterChangesRebuild(entry, { title: clusterChangesTitle(clusterModel, entry.clusterKey), label: clusterLabelForKey(clusterModel, entry.clusterKey), repoRoot: git.repoRoot, branch: model.branch }, clusterFilesForKey(clusterModel, entry.clusterKey))`. Only `kind === "rebuild"` acts, by calling `rebuildClusterChanges`. Catch and `console.warn` errors so a failed rebuild never breaks refresh.
   - Call `void syncActiveClusterChanges()` in `refresh()` right after `treeProvider.setModel(model)` and the provenance render (around extension.ts:458-462), inside the generation-guarded success path.
   - Call it from the existing `onDidChangeTabs` handler and the `onDidChangeTabGroups` subscription (800-817) when `!rebuildingClusterChanges`. That is how a background tab rebuilds on switch-back.
   - Leave `markClusterChangesReviewed` logic unchanged. An empty rebuilt tab has `entry.paths = []`, so it reports `nothingToReviewMessage`.
3. DEVELOPMENT.md:
   - Rewrite manual-test step 31c (line 261). Pressing `Mark Cluster Reviewed` marks the listed needs-review files, and the tab stays open and rebuilds in place without them, keeping its title and position. Keep the rename/reorder sentence (`changedClusterMessage`, no rebuild).
   - Rewrite the last sentence of 31d (line 262). After a per-file `+` from the sidebar, the active combined diff rebuilds without that file. Clicking a remaining file's left side still selects its row.
   - Add a step for the empty state, background tabs, and edits:
     - With the combined diff active, mark its last file. The tab stays open with no files. Title-bar `Mark Cluster Reviewed` reports `No files in '<label>' need review.`. Edit a file of the cluster, and the tab fills again with it diffed `last reviewed ↔ working tree`.
     - Switch to another editor, mark files from the sidebar, and the background tab is untouched. Click it, and it rebuilds once with current files.
     - Agent edit to the contract moving a file into the cluster: the active tab gains it.
   - If task 01_01 already added a `31e`, number this one next.
   - In the "Scripted extension-host checks" paragraph, no change is needed beyond keeping accuracy (`__inspect` already returns `clusterChangesTabs`, which now include `signature`).
4. package.json `"version": "0.13.0"`. plugin/.claude-plugin/plugin.json `"version": "0.8.0"`. Check `.claude-plugin/marketplace.json` for a duplicated plugin version and keep it in sync if present.

## Gotchas

- The stable API has no multi-diff tab input class. Tabs are found by label. `vscode.changes` always opens in the active group with a fresh random `multi-diff-editor:` source, so in-place update is impossible. Do not use internal `_workbench.*` commands.
- Tab object identity across `tabGroups.all` reads is assumed stable in the extension host (it caches API objects per tab id). Confirm in the scripted check that the before-set filter finds exactly one new tab. If identity is not stable, fall back to comparing `tabGroups.all` tab counts per group, plus the active tab after the open.
- `vscode.changes` with an empty resource list may or may not open a tab. The fallback in step 2 keeps the old tab and shows the message. Record which behavior the scripted check observed in the handback.
- Your own open and close fires `onDidChangeTabs`. The `rebuildingClusterChanges` flag plus the serial queue prevent rebuild loops. After a rebuild the signature matches, so a later sync is `unchanged`.
- `refresh()` runs often (every 400 ms debounced file event). The sync must be cheap when nothing changed: signature compare only, no tab operations.
- An active tab whose title matches two entries, or two tabs with the same title: do nothing (same caution as `markClusterChangesReviewed`).
- Prettier: `.mise/` and `.claude/` must stay in `.prettierignore`.
- Extension-host launches steal focus. Batch scripted checks into one launch.

## Verification

- Tests to run: `yarn test`, `yarn lint`, `yarn build`.
- Tests this task writes in src/clusterChanges.test.ts:
  - `clusterChangesSignature` is order-sensitive. It changes when `diffBaseSha`, `diffBasePath`, or `deleted` changes. An undefined sha encodes as `empty`.
  - `clusterChangesRebuild` returns `changed-cluster` for a different label, title, repoRoot, or branch.
  - It returns `unchanged` when needs-review files and bases match, including when a reviewed file is added to `clusterFiles`.
  - It returns `rebuild` with the remaining files when a file was marked reviewed.
  - It returns `rebuild` with `[]` when none remain.
  - It returns `rebuild` when a reviewed file became needs-review with a snapshot base.
  - The existing `clusterChangesMarkPaths` tests still pass after the comparison refactor.
- Substitute check (config Test exceptions; extension-host behavior): one scripted `@vscode/test-electron` run per DEVELOPMENT.md "Scripted extension-host checks". The harness lives in the session scratchpad and is not committed. Launch with `env -u ELECTRON_RUN_AS_NODE`, a short `--user-data-dir`, and `DELTA_REVIEW_TEST=1`. On a temp repo with a 2-file cluster contract:
  1. Open Cluster Changes. `__inspect().clusterChangesTabs[title].paths` has 2 entries, and exactly one matching tab exists.
  2. `deltaReview.markReviewed` one file (or the command the per-file `+` uses). After refresh, the entry has 1 path, still exactly one matching tab, and the same group and index as before.
  3. Mark the last file. The tab is still open (or the fallback message path ran, which you report), and the entry has 0 paths.
  4. Open a plain text editor to make it active. Edit a cluster file so it needs review, and wait for refresh. The entry is still at 0 paths, so the background tab was not rebuilt.
  5. Re-activate the cluster tab. The entry has 1 path.
