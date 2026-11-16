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
- `vscode.changes` behavior (VS Code 1.146 source): its handler calls `executeCommand("_workbench.changes", …)` without returning it, so awaiting `vscode.changes` does NOT wait for the editor to open. `_workbench.changes` opens with no editor options, so the tab is a preview in the active group and takes focus. `resources: []` opens an empty multi-diff tab; only a missing resources list throws.
- `diffUris(activeGit, file)` (718-731) builds the left and right URIs. `left` is `createReviewBaseUri(file.diffBasePath, file.diffBaseSha)`, with path `/${path}` and query `sha ?? "empty"` (src/baseDocument.ts:39-45).
- `refresh()` assigns `clusterModel` and `model` and calls `treeProvider.setModel(model)` at extension.ts:449-462, guarded by `generation !== refreshGeneration` checks (pattern at 350, 443, 504). Every review mark goes through `applyReviewStateChange` (605-621), which calls `refresh()`. File and contract watchers call `scheduleRefresh` (632-694). So hooking the end of a successful `refresh()` covers every trigger.
- Title-bar `deltaReview.markClusterChangesReviewed` (1392-1457) uses `clusterChangesMarkPaths` (clusterChanges.ts:91-115). It refuses with `changedClusterMessage` when the source, title, or label differ.
- Selection sync (extension.ts:867-920) reads `entry.leftSides`, so keep that field.
- `createSerialQueue` is in src/serialQueue.ts.
- Design decisions:
  - Rebuild trigger: any change to the ordered list of (path, diffBasePath, diffBaseSha, deleted) for the cluster's needs-review files. The right side is the live file, so plain edits that keep needs-review status need no rebuild.
  - Only the active tab of the active group rebuilds. Background tabs are never rebuilt (no focus steal, no tab moving). Each is checked when it becomes active, via tab and tab-group change events.
  - Last needs-review file gone: the tab is NOT closed. It is rebuilt with zero resources (VS Code's empty multi-diff state).
  - Rebuild success is decided by a tab-opened event, not by the `vscode.changes` promise. A rebuild that sees no new tab within 3000 ms keeps the old tab and entry and memoizes the failed signature so it is not retried until the signature changes again.
  - Accepted: the rebuilt tab opens as a preview (replacing the old tab in place when that was a preview, or possibly an unrelated preview tab otherwise; re-pinned via `workbench.action.keepEditor` when the old tab was pinned). A rebuild moves keyboard focus to the combined diff; no stable API can preserve or restore it.
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
   - Add `export const refreshFailedMessage = (label: string) => `Couldn't refresh '${label}'. Reopen it from the Delta Review pane.``. It is used only by the failure path in step 2.
2. src/extension.ts:
   - Add `signature: string[]` to `ClusterChangesEntry`.
   - Extract from `openClusterChanges` two helpers:
     - `buildClusterChanges(activeGit, branch, clusterKey, label, files): { entry: ClusterChangesEntry; resources: [vscode.Uri, vscode.Uri, vscode.Uri][] }` builds the resources and the entry (incl. `signature: clusterChangesSignature(files)`). It records nothing.
     - `showClusterChanges(title, resources): Promise<void>` awaits `vscode.commands.executeCommand("vscode.changes", title, resources)` with zero or more resources.
     - `openClusterChanges` keeps its zero-files message and its close-stale-then-open behavior: build, `clusterChangesTabs.set(title, entry)`, then `showClusterChanges`, in today's order.
   - Add module state `let rebuildingTitle: string | undefined` and `const failedRebuildSignature = new Map<string, string>()` (title -> `signature.join("\n")`).
   - Add `waitForNewClusterChangesTab(title, before: Set<vscode.Tab>, next: ClusterChangesEntry, timeoutMs = 3000): Promise<vscode.Tab | undefined>`. It subscribes to `vscode.window.tabGroups.onDidChangeTabs`. On the first tab in `event.opened` or `event.changed` where `isClusterChangesLabel(tab.label, title) && !isStableTabInput(tab.input) && !before.has(tab)`, it calls `clusterChangesTabs.set(title, next)` synchronously inside that callback and then resolves with the tab. It resolves `undefined` on timeout and records nothing. It disposes the listener and clears the timer on either outcome. Create it before calling `vscode.changes` so no event is missed.
     - Why the entry is set inside the callback: `deltaReview.markClusterChangesReviewed` (extension.ts:1393-1457) is not on `clusterChangesQueue` and reads `activeClusterChanges()`. If the new entry were recorded before the new tab exists, pressing the button on the still-visible old tab would mark files that tab does not show. Setting it in the event callback that first exposes the new tab leaves no window in which a command sees a mismatched tab and entry.
   - Add `rebuildClusterChanges(activeGit, branch, title, entry, files)`:
     1. `const before = new Set(clusterChangesTabsFor(title))`, `const wasPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview === true`, and `const { entry: next, resources } = buildClusterChanges(activeGit, branch, entry.clusterKey, entry.label, files)`. Do not record `next` here.
     2. `rebuildingTitle = title`, then `const waiting = waitForNewClusterChangesTab(title, before, next)`.
     3. `await showClusterChanges(title, resources)`, then `const opened = await waiting`. Until the waiter fires, the previous entry stays recorded.
     4. If `opened !== undefined`: `failedRebuildSignature.delete(title)`. Close the members of `before` that are still in `clusterChangesTabsFor(title)` with `vscode.window.tabGroups.close([...])`. None left (preview replacement already closed the old one) is success too. If `!wasPreview`, `await vscode.commands.executeCommand("workbench.action.keepEditor")` so the rebuilt tab stays pinned.
     5. Otherwise: the previous entry was never replaced, so nothing is restored. `failedRebuildSignature.set(title, clusterChangesSignature(files).join("\n"))`, and show `refreshFailedMessage(entry.label)` as an information message.
     6. In `finally`: `rebuildingTitle = undefined`. If `clusterChangesTabsFor(title).length === 0`, delete the entry and its `failedRebuildSignature`. Call `updateClusterChangesContext()`. Then call `void syncActiveClusterChanges()` once (not awaited: it enqueues behind the current queue task) so a tab switch whose sync was skipped while `rebuildingTitle` was set is caught. The signature check keeps it loop-safe.
   - In the existing `onDidChangeTabs` closed loop (800-816), skip deleting a title equal to `rebuildingTitle`. When an entry is deleted, delete its `failedRebuildSignature` too.
   - Add `const clusterChangesQueue = createSerialQueue()` and `syncActiveClusterChanges = () => clusterChangesQueue.run(async () => { ... })`. Inside, return early unless all of these hold:
     - `git`, `model`, and `clusterModel` are defined
     - `activeClusterChanges()` returns one `{ title, entry }`
     - `clusterChangesTabsFor(title).length === 1`
   - It then calls `clusterChangesRebuild({ title, label: entry.label, repoRoot: entry.repoRoot, branch: entry.branch, signature: entry.signature }, { title: clusterChangesTitle(clusterModel, entry.clusterKey), label: clusterLabelForKey(clusterModel, entry.clusterKey), repoRoot: git.repoRoot, branch: model.branch }, clusterFilesForKey(clusterModel, entry.clusterKey))`. `ClusterChangesEntry` has no `title`, so build the object as `markClusterChangesReviewed` does (extension.ts:1428-1434). Only `kind === "rebuild"` acts, and only when `clusterChangesSignature(result.files).join("\n") !== failedRebuildSignature.get(title)`. It calls `rebuildClusterChanges(git, model.branch, title, entry, result.files)`. Catch and `console.warn` errors so a failed rebuild never breaks refresh.
   - Call `void syncActiveClusterChanges()` in `refresh()` after `commentController.renderProvenanceThreads(...)` (extension.ts:466) and before the `reviewedCount` code, inside the generation-guarded success path.
   - Call it from the existing `onDidChangeTabs` handler and the `onDidChangeTabGroups` subscription (800-817) when `rebuildingTitle === undefined`. That is how a background tab rebuilds on switch-back.
   - Leave `markClusterChangesReviewed` logic unchanged. It stays correct mid-rebuild only because the waiter swaps the entry when the new tab appears (above). An empty rebuilt tab has `entry.paths = []`, so it reports `nothingToReviewMessage`.
3. DEVELOPMENT.md:
   - Rewrite manual-test step 31c (line 261). Pressing `Mark Cluster Reviewed` marks the listed needs-review files, and the tab stays open and rebuilds in place without them, keeping its title and position. Keep the rename/reorder sentence (`changedClusterMessage`, no rebuild).
     - Replace "Add a file to the cluster after opening and press it → that file stays Needs Review" (now false: an active tab rebuilds to include the file). New wording: with the combined diff open but in the background (another pinned editor active in the same group), add a file to the cluster in the contract → the background tab is untouched; activate it → it rebuilds once and lists the new file; press the button → it marks exactly the files the tab lists, including the new one. The button never marks a file the visible tab does not list.
     - Drop the closing "Open the combined diff, edit another cluster file, reopen it → the first tab is gone ..." clause only if it now duplicates the new behavior; otherwise keep it (reopen still closes the stale tab).
   - Rewrite the last sentence of 31d (line 262). After a per-file `+` from the sidebar, the active combined diff rebuilds without that file, and keyboard focus moves to the combined diff (expected: `vscode.changes` has no `preserveFocus`). Clicking a remaining file's left side still selects its row.
   - Add a step for the empty state, background tabs, and edits:
     - With the combined diff active, mark its last file. The tab stays open with no files. Title-bar `Mark Cluster Reviewed` reports `No files in '<label>' need review.`. Edit a file of the cluster, and the tab fills again with it diffed `last reviewed ↔ working tree`.
     - Switch to another editor opened pinned (double-click it, so it does not replace a preview combined-diff tab), mark files from the sidebar, and the background tab is untouched. Click it, and it rebuilds once with current files.
     - Agent edit to the contract moving a file into the cluster: the active tab gains it.
   - If task 01_01 already added a `31e`, number this one next.
   - In the "Scripted extension-host checks" paragraph, no change is needed beyond keeping accuracy (`__inspect` already returns `clusterChangesTabs`, which now include `signature`).
4. package.json `"version": "0.13.0"`. plugin/.claude-plugin/plugin.json `"version": "0.8.0"`. Check `.claude-plugin/marketplace.json` for a duplicated plugin version and keep it in sync if present.

## Gotchas

- The stable API has no multi-diff tab input class. Tabs are found by label. `vscode.changes` always opens in the active group with a fresh random `multi-diff-editor:` source, so in-place update is impossible. Do not use internal `_workbench.*` commands.
- Never decide success right after `await vscode.commands.executeCommand("vscode.changes", …)`: the tab has not opened yet. Always go through `waitForNewClusterChangesTab`.
- Tab object identity across events and `tabGroups.all` reads is assumed stable in the extension host (it caches API objects per tab id). Confirm in the scripted check that the waiter resolves with a tab and that exactly one matching tab remains afterwards. If identity is not stable, compare by `tab.group.viewColumn` plus index instead of object identity for `before`.
- When the old tab is a preview, the new one replaces it: the same or adjacent events carry the old tab in `closed` and the new one in `opened`. The `rebuildingTitle` guard keeps the closed handler from deleting the entry in between.
- Loop safety: your own open and close fire `onDidChangeTabs`, possibly after `rebuildingTitle` resets. That is safe only because a later sync compares signatures: `unchanged` after success, and a `failedRebuildSignature` match after failure. Never restore the previous entry without recording the failed signature, or every refresh retries the rebuild.
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
  2. `deltaReview.markFileReviewed` one file (the command the per-file `+` uses). After refresh, the entry has 1 path, still exactly one matching tab, and the same group and index as before.
  3. Mark the last file. The tab is still open, exactly one matching tab exists, and the entry has 0 paths. No `Couldn't refresh` message appeared, and after a further 2 s with no changes no additional rebuild ran (count tab-opened events matching the title: exactly one per mark).
  4. Open a plain text editor with `vscode.window.showTextDocument(doc, { preview: false })` so it cannot replace the cluster tab, making it active. Edit a cluster file so it needs review, and wait for refresh. The entry is still at 0 paths, so the background tab was not rebuilt.
  5. Re-activate the cluster tab. The entry has 1 path.
