# 02_03 "Mark Cluster Reviewed" button in the combined diff's title bar

## Goal

While a Delta Review combined cluster diff (`Cluster Changes: <label>`, opened by task 02_02) is the active editor, show a **Mark Cluster Reviewed** button (`$(check-all)`, first) in its editor title bar. It marks the files that tab shows which still need review, through the same write path as the sidebar's cluster Mark Reviewed. It never writes review state for a cluster or files the user did not see in that tab: if the cluster behind the tab changed since the tab opened, or the active repo or branch is not the one the tab was opened from, it marks nothing and shows a message. It acts only from the tab it was pressed in. The tab stays open. The button must not show on other multi-diff editors (e.g. the SCM "View Changes") or on ordinary editors.

## Files to modify/create

- `src/extension.ts`
- `package.json`
- `DEVELOPMENT.md`

## Background

- Task 02_02 added, in `src/extension.ts`, `type ClusterChangesEntry = { clusterKey; label; paths; leftSides; repoRoot; branch }` (`leftSides` is used only by 02_04) (`repoRoot`/`branch` = `git.repoRoot` / `model.branch` when the tab opened), the `clusterChangesTabs: Map<title, ClusterChangesEntry>` map, `isClusterChangesLabel(label, title): boolean` (`src/extension.ts:732`; true for the bare `title` or `title` + ` (<digits>…)`, because the multi-diff editor appends a localized file count such as `<title> (2 files)` / `<title> (1 file)` once its resources resolve, so a real tab's `label` is usually not the bare title), and `clusterChangesTabsFor(title): vscode.Tab[]` (`src/extension.ts:739`; open tabs whose label satisfies `isClusterChangesLabel` and whose input is none of the stable input classes). `deltaReview.openClusterChanges` first closes every tab `clusterChangesTabsFor(title)` returns, then records the entry, then opens the combined diff via `vscode.changes(title, …)`, so at most one combined-diff tab carries each title. Titles come from `clusterChangesTitle(model, clusterKey)` and are unique within one model (` (<n>)` suffix on label collisions, skipping any `n` whose title is already taken).
- Task 02_01 added, in `src/clusterChanges.ts`: `clusterLabelForKey(model, key)`, `clusterChangesTitle(model, key)`, and `clusterChangesMarkPaths(entry: { title; label; paths; repoRoot; branch }, current: { title; label; repoRoot; branch }, clusterFiles)`, which returns `{ paths }` (entry paths that still need review) or `{ message }` (cluster changed since open, repo root or branch differs, or nothing left to review).
- Marking overwrites each file's prior reviewed snapshot (`src/reviewState.ts:108`), so a wrong mark loses review state. This is listed in the spec's Hard-to-undo.
- `deltaReview.markClusterReviewed` (`src/extension.ts:1152-1175`) computes `clusterFilesForKey(clusterModel, key).filter(NeedsReview).map(path)` and calls `applyReviewStateChange("mark cluster reviewed", () => markReviewed(activeGit, branch, paths))`.
- VS Code API facts (investigated against VS Code `main` and engine 1.140):
  - The `editor/title` menu is stable. Core's own multi-diff buttons use `when: activeEditor == 'multiDiffEditor'`.
  - `vscode.changes` opens a random `multi-diff-editor:<random>` resource, and the stable API has no multi-diff tab-input class, so `resource`/`resourceScheme` cannot single out our editor.
  - The approach is to watch `window.tabGroups.onDidChangeTabs` (and `onDidChangeTabGroups` for active-group switches), check that the active tab's `label` matches a title we opened via `isClusterChangesLabel` and that its `input` is not one of the known stable input classes, and set a context key with `setContext`.
- Rule: every place that matches a tab to a title (context key, tab-close pruning, the more-than-one-tab refusal, and 02_04's click-to-select) uses `isClusterChangesLabel` / `clusterChangesTabsFor`. Never `tab.label === title`, and never `clusterChangesTabs.get(tab.label)` / `.has(tab.label)`.
- Existing context-key pattern: `deltaReview.clustersAvailable` (search `setContext` in `src/extension.ts`).
- Menu ordering: VS Code sorts items in a menu group by order (missing = 0), then title. `navigation@0` would tie with core's own multi-diff `navigation` buttons and lose on title, so use a negative order.
- Design decisions (spec): the button sits first (`navigation@-1000`). The tab stays open after the mark and is not refreshed: left URIs carry a fixed sha (`src/extension.ts:707`), so its diffs keep the bases they opened with. Never document or test that it refreshes.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Add the tab-to-title helpers:
   - Extract the stable-input check from `clusterChangesTabsFor` into `isStableTabInput(input: unknown): boolean` (`instanceof` any of `TabInputText`, `TabInputTextDiff`, `TabInputCustom`, `TabInputWebview`, `TabInputNotebook`, `TabInputNotebookDiff`, `TabInputTerminal`) and use it in `clusterChangesTabsFor`; its behavior is unchanged.
   - `clusterChangesTitlesForTab(tab: vscode.Tab | undefined): string[]`: `[]` when `tab` is undefined or `isStableTabInput(tab.input)`; otherwise `[...clusterChangesTabs.keys()].filter(k => isClusterChangesLabel(tab.label, k))`. More than one title matches only when a cluster label itself ends in ` (N files)` (e.g. titles `Cluster Changes: A` and `Cluster Changes: A (2 files)` both match the label `Cluster Changes: A (2 files)`).
   - `isClusterChangesTab(tab): boolean` = `clusterChangesTitlesForTab(tab).length > 0`.
   - `activeClusterChanges(): { title: string; entry: ClusterChangesEntry } | undefined`: `titles = clusterChangesTitlesForTab(vscode.window.tabGroups.activeTabGroup.activeTab)`; return `{ title: titles[0], entry: clusterChangesTabs.get(titles[0])! }` only when `titles.length === 1`, else undefined. Task 02_04 relies on this shape.
2. Add `updateClusterChangesContext()`, which runs `void vscode.commands.executeCommand("setContext", "deltaReview.clusterChangesActive", isClusterChangesTab(vscode.window.tabGroups.activeTabGroup.activeTab))` (true also when the label is ambiguous, so the button shows and the press reports why it refuses). Subscribe it to `vscode.window.tabGroups.onDidChangeTabs` and `onDidChangeTabGroups` (push both into `context.subscriptions`). Also call it right after `vscode.changes` resolves in `openClusterChanges`. Prune in the `onDidChangeTabs` handler from `event.closed` only: for each closed tab, for each key `k` of `clusterChangesTabs` with `isClusterChangesLabel(tab.label, k)` (collect the keys first, then delete), `clusterChangesTabs.delete(k)` when `clusterChangesTabsFor(k)` is empty. A closed tab's label carries the file-count suffix, so never `delete(tab.label)`. Never prune from `event.opened`/`event.changed` or by scanning the whole map (the entry is recorded just before `vscode.changes` creates its tab, so a scan could drop it). This keeps a later plain multi-diff with a coincidental label from matching.
3. Extract a shared `markClusterPaths(activeGit: Git, branch: string, paths: string[])` from `markClusterReviewed` (same `applyReviewStateChange("mark cluster reviewed", () => markReviewed(activeGit, branch, paths))` call). It takes the repo and branch explicitly and never reads the mutable `git`/`model`. `markClusterReviewed` computes `activeGit`, `branch` and its paths as today and calls it; its behavior is unchanged.
4. Register `deltaReview.markClusterChangesReviewed(...args: unknown[])`:
   - Resolve the invoking tab (finding: `activeEditor` in an `editor/title` `when` is evaluated per editor group while `deltaReview.clusterChangesActive` is global, so with our combined diff active in group 1 and another multi-diff, e.g. the SCM "View Changes", in group 2, the button can show in group 2's title bar; reading only the active group would then mark group 1's files):
     - First confirm, against VS Code `main` (the editor title toolbar's command arguments, e.g. `IEditorCommandsContext { groupId, editorIndex }` and the resource argument) or with a logging stub in a dev host, what arguments an `editor/title` command receives when pressed on a multi-diff editor, and whether any of them can be mapped to a stable `vscode.TabGroup`/`vscode.Tab` (`TabGroup` exposes `viewColumn`, not the internal group id).
     - If they identify the tab: return silently unless that tab satisfies `isClusterChangesTab` and is `vscode.window.tabGroups.activeTabGroup.activeTab`.
     - If they do not: proceed only when `isClusterChangesTab(activeTabGroup.activeTab)`, `clusterChangesTabsFor(title).length === 1` for its single matching title (the ambiguity check below runs first), and no other group's `activeTab` has an input outside the stable input classes (any such tab's title bar could be where the button was pressed; this includes non-diff pages with no stable input class such as Settings, Welcome or extension pages). Otherwise run `void vscode.window.showInformationMessage("Can't tell which editor this button belongs to. Focus the cluster's combined diff and try again.")` and return without writing.
     - Record which branch you implemented, and the argument shape you found, in a code comment and in your report.
   - Ambiguity: when `clusterChangesTitlesForTab(vscode.window.tabGroups.activeTabGroup.activeTab).length > 1`, run `void vscode.window.showInformationMessage("Can't tell which editor this button belongs to. Focus the cluster's combined diff and try again.")` and return without writing. Do this before the invoking-tab check's `clusterChangesTabsFor(title)` count, in both branches above.
   - `active = activeClusterChanges()`; `{ title, entry } = active` (`title` is the map key, never `tab.label`, which carries the file-count suffix). Return when `active` is undefined, or when `git`, `model` or `clusterModel` is undefined. Capture `activeGit = git` and `branch = model.branch` once, here.
   - When `clusterChangesTabsFor(title).length > 1`, run ``void vscode.window.showInformationMessage(`More than one '${title}' tab is open. Close them and reopen it from the Delta Review pane.`)`` and return without writing (guard: the entry describes only one of those tabs; 02_02's close-before-open should make this unreachable, e.g. unless a close was refused).
   - `current = { title: clusterChangesTitle(clusterModel, entry.clusterKey), label: clusterLabelForKey(clusterModel, entry.clusterKey), repoRoot: activeGit.repoRoot, branch }`.
   - `result = clusterChangesMarkPaths({ title, label: entry.label, paths: entry.paths, repoRoot: entry.repoRoot, branch: entry.branch }, current, clusterFilesForKey(clusterModel, entry.clusterKey))`.
   - `"message" in result` → `void vscode.window.showInformationMessage(result.message)` and return without writing. Otherwise `await markClusterPaths(activeGit, branch, result.paths)` (the same `activeGit`/`branch` that were compared).
5. `package.json`:
   - Declare `{ "command": "deltaReview.markClusterChangesReviewed", "title": "Mark Cluster Reviewed", "icon": "$(check-all)", "category": "Delta Review" }`.
   - Add a new `"editor/title"` menu array with `{ "command": "deltaReview.markClusterChangesReviewed", "when": "activeEditor == 'multiDiffEditor' && deltaReview.clusterChangesActive", "group": "navigation@-1000" }`.
   - Hide it in `commandPalette` (`"when": "false"`).
6. `DEVELOPMENT.md`:
   - Add a short paragraph near the Clusters contract notes (`:108-126`) describing the `deltaReview.clusterChangesActive` context key and why it uses label matching (no stable multi-diff tab input), that labels carry VS Code's ` (N files)` suffix (matched by `isClusterChangesLabel`), and that a label matching more than one recorded title refuses to mark.
   - Add manual step `31c.`: with a combined diff active, the title bar's first button is `Mark Cluster Reviewed`. Pressing it marks the files the tab lists that still need review, and the tab stays open (it is not refreshed; reopen it to see current bases). Switching to a plain file editor or the SCM "View Changes" multi-diff hides the button. Rename the cluster in the contract (or reorder clusters) while the tab is open and press it → `Cluster '<label>' changed since this diff opened. Reopen it from the Delta Review pane.` and `refs/review/<branch>` gets no new commit. Add a file to the cluster after opening and press it → that file stays Needs Review. Open `Cluster Changes: Unclustered`, switch the active SCM repo (or check out another branch) and press it → the changed-cluster message and no new commit on any `refs/review/*`. With the combined diff in one editor group and the SCM "View Changes" multi-diff in another, pressing the button from the other group writes nothing. Open the combined diff, edit another cluster file, reopen it → the first tab is gone and only one `Cluster Changes: <label>` tab exists; pressing its button marks the files it lists.

## Gotchas

- The cluster key is index-based (`c0`, `c1`, …). If the contract is rewritten between open and press, the key may point to a different cluster. `clusterChangesMarkPaths` refuses when the key's current label or title differs from the stored ones, and limits the mark to stored `paths` ∩ current needs-review files of that key. Never mark the key's full current file list and never mark stored paths without intersecting.
- Negative menu order: VS Code parses `group@order` with `Number(...)`, so `navigation@-1000` is kept as -1000. If you can confirm otherwise (e.g. in VS Code's `menusExtensionPoint.ts`), use the lowest order that is kept and say so in your report.
- `setContext` is async and fire-and-forget. Do not await it inside the tab-change handler.
- `onDidChangeTabs` fires for every tab change, so keep the handler cheap (no git).
- Repo and branch: titles of synthetic buckets (`Cluster Changes: Unclustered`, `Cluster Changes: Auto`) and cluster labels repeat across repos and branches, and repo-relative paths can overlap, so the label/title check alone does not stop a write into another repo's or branch's `refs/review/<branch>`. Always pass `repoRoot`/`branch` to `clusterChangesMarkPaths`, and write with the captured `activeGit`/`branch`, never by re-reading `git`/`model` after an `await`.
- Tab labels: a real multi-diff tab's label is `<title> (N files)` / `<title> (1 file)` (localized), not `<title>`. Every tab-to-title match goes through `isClusterChangesLabel` / `clusterChangesTabsFor` / `clusterChangesTitlesForTab`. When a label matches more than one title, the mark refuses with the can't-tell message; never pick one.
- The tab title alone keys the map; the close-before-open rule (02_02) plus the more-than-one guard here are what stop a press in an older tab from marking files only a newer tab showed. Do not weaken either.
- Run `yarn format` before finishing.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Scripted extension-host check (DEVELOPMENT.md recipe; scratchpad harness; batch with 02_02's harness if it is still around):
  - Open the combined diff via `deltaReview.openClusterChanges`, then run `deltaReview.markClusterChangesReviewed`.
  - Wait until the tab's label has its file-count suffix (poll `tabGroups.all` for a label starting with the title and ending in `)`), so the suffixed path is the one exercised.
  - Assert that `git ls-tree -r refs/review/<branch>` now lists every file the tab showed, and that the `Cluster Changes: <label>` tab is still open.
  - Close the tab and assert (via `deltaReview.__inspect` if it exposes the map, otherwise skip) that its entry was pruned.
  - Ambiguity: name two clusters `A` and `A (2 files)` where `A` has 2 needs-review files; open both combined diffs, focus the `Cluster Changes: A` tab once its label reads `Cluster Changes: A (2 files)` (it then matches both titles), run the command: no new commit on `refs/review/<branch>`.
  - Reopen after editing a file: exactly one tab carries the title, and its entry lists the edited file.
  - Reopen after editing a file, rewrite the contract to rename the cluster, run the command: no new commit on `refs/review/<branch>`.
  - Reopen, then check out another branch in the temp repo (wait for the model refresh), run the command: no new commit on either branch's `refs/review/<branch>`.
  - The pure guard is unit-tested in 02_01 (`clusterChangesMarkPaths`).
  - Then open a plain file (`showTextDocument`) and run the command again: it is a no-op (no new commit on the ref).
- The button's visibility (`when` clause) is eyeball-only; note it as unverified if no dev host is available.
- Split layout (eyeball-only unless the harness can open the SCM multi-diff): our combined diff active in group 1, another multi-diff in group 2; pressing the button in group 2 (if shown) writes nothing.
