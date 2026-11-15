# 02_03 "Mark Cluster Reviewed" button in the combined diff's title bar

## Goal

While a Delta Review combined cluster diff (`Cluster Changes: <label>`, opened by task 02_02) is the active editor, show a **Mark Cluster Reviewed** button (`$(check-all)`, first) in its editor title bar. It marks every file of that cluster that currently needs review, exactly as the sidebar's cluster Mark Reviewed does. The tab stays open. The button must not show on other multi-diff editors (e.g. the SCM "View Changes") or on ordinary editors.

## Files to modify/create

- `src/extension.ts`
- `package.json`
- `DEVELOPMENT.md`

## Background

- Task 02_02 added the `clusterChangesTabs: Map<title, { clusterKey; paths }>` map in `src/extension.ts`, filled each time `deltaReview.openClusterChanges` opens a combined diff via `vscode.changes(title, …)`.
- `deltaReview.markClusterReviewed` (`src/extension.ts:1152-1175`) computes `clusterFilesForKey(clusterModel, key).filter(NeedsReview).map(path)` and calls `applyReviewStateChange("mark cluster reviewed", () => markReviewed(activeGit, branch, paths))`.
- VS Code API facts (investigated against VS Code `main` and engine 1.140):
  - The `editor/title` menu is stable. Core's own multi-diff buttons use `when: activeEditor == 'multiDiffEditor'`.
  - `vscode.changes` opens a random `multi-diff-editor:<random>` resource, and the stable API has no multi-diff tab-input class, so `resource`/`resourceScheme` cannot single out our editor.
  - The approach is to watch `window.tabGroups.onDidChangeTabs` (and `onDidChangeTabGroups` for active-group switches), check that the active tab's `label` is a title we opened and that its `input` is not one of the known stable input classes, and set a context key with `setContext`.
- Existing context-key pattern: `deltaReview.clustersAvailable` (search `setContext` in `src/extension.ts`).
- Design decisions (spec): the button sits first (`navigation@0`). The tab stays open after the mark, and the multi-diff refreshes itself as the bases change. Two clusters with the same label share a title, and the most recent open wins.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Add `activeClusterChanges(): { clusterKey: string; paths: string[] } | undefined`:
   - Read `tab = vscode.window.tabGroups.activeTabGroup.activeTab`.
   - Return undefined when there is no tab, or when `tab.input instanceof` any of `TabInputText`, `TabInputTextDiff`, `TabInputCustom`, `TabInputWebview`, `TabInputNotebook`, `TabInputNotebookDiff`, `TabInputTerminal`.
   - Otherwise return `clusterChangesTabs.get(tab.label)`.
2. Add `updateClusterChangesContext()`, which runs `void vscode.commands.executeCommand("setContext", "deltaReview.clusterChangesActive", activeClusterChanges() !== undefined)`. Subscribe it to `vscode.window.tabGroups.onDidChangeTabs` and `onDidChangeTabGroups` (push both into `context.subscriptions`). Also call it right after `vscode.changes` resolves in `openClusterChanges`. Prune `clusterChangesTabs` entries whose title no longer matches any open tab on `onDidChangeTabs` (closed tabs), so a later plain multi-diff with a coincidental label cannot match.
3. Extract a shared `markClusterNeedsReview(clusterKey: string)` from `markClusterReviewed` (same guards, same progress label). Both `markClusterReviewed` and the new command use it.
4. Register `deltaReview.markClusterChangesReviewed()`: `const entry = activeClusterChanges(); if (entry) await markClusterNeedsReview(entry.clusterKey);`.
5. `package.json`:
   - Declare `{ "command": "deltaReview.markClusterChangesReviewed", "title": "Mark Cluster Reviewed", "icon": "$(check-all)", "category": "Delta Review" }`.
   - Add a new `"editor/title"` menu array with `{ "command": "deltaReview.markClusterChangesReviewed", "when": "activeEditor == 'multiDiffEditor' && deltaReview.clusterChangesActive", "group": "navigation@0" }`.
   - Hide it in `commandPalette` (`"when": "false"`).
6. `DEVELOPMENT.md`:
   - Add a short paragraph near the Clusters contract notes (`:108-126`) describing the `deltaReview.clusterChangesActive` context key and why it uses label matching (no stable multi-diff tab input).
   - Add manual step `31c.`: with a combined diff active, the title bar's first button is `Mark Cluster Reviewed`. Pressing it moves the cluster to `n/n`, and the tab stays open. Switching to a plain file editor or the SCM "View Changes" multi-diff hides the button.

## Gotchas

- The cluster key is index-based (`c0`, `c1`, …). If the contract is rewritten between open and press, the key may point to a different cluster. Accept this, but resolve files at press time via `clusterFilesForKey` (never the stale `paths`) so the mark covers whatever that cluster currently holds, the same as the sidebar.
- `setContext` is async and fire-and-forget. Do not await it inside the tab-change handler.
- `onDidChangeTabs` fires for every tab change, so keep the handler cheap (no git).
- Run `yarn format` before finishing.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Scripted extension-host check (DEVELOPMENT.md recipe; scratchpad harness; batch with 02_02's harness if it is still around):
  - Open the combined diff via `deltaReview.openClusterChanges`, then run `deltaReview.markClusterChangesReviewed`.
  - Assert that `git ls-tree -r refs/review/<branch>` now lists every cluster file, and that the `Cluster Changes: <label>` tab is still open.
  - Then open a plain file (`showTextDocument`) and run the command again: it is a no-op (no new commit on the ref).
- The button's visibility (`when` clause) is eyeball-only; note it as unverified if no dev host is available.
