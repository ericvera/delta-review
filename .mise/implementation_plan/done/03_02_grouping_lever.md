# Task 3.2: Grouping lever, context keys, contract watching, invalid-contract warning

## Goal

The extension loads the clusters contract on every refresh, exposes a persisted grouping lever (clusters on ⇄ off) as a second icon-swapping title-bar button that exists only while a valid contract exists, watches the contract directory for live updates, and surfaces invalid-contract warnings. Rendering of the grouped view itself lands in Task 3.3 — this task wires state, so at its end the lever exists but grouped rendering may temporarily equal ungrouped (still green: no behavior regression, button functional, state correct).

## Requirements addressed

REQ-VIEW-1 (lever mechanics), REQ-VIEW-2, REQ-VIEW-3, REQ-VIEW-4, REQ-VIEW-5, REQ-CONTRACT-3, REQ-CONTRACT-4, REQ-CONTRACT-5.

## Background

Task 3.1 added `src/clusters.ts`: `loadClustersContract(git, branch)` → `{ state: 'missing' | 'invalid' | 'ok', ... }` and `resolveClusterModel(contract, files)` → `ClusterModel`. The contract lives at `<git common dir>/delta-review/clusters-<sanitized-branch>.json`.

Existing lever precedent — the layout toggle: `deltaReview.viewMode` workspaceState + `setContext` (`src/extension.ts:45-51`), `setViewMode` (`src/extension.ts:61-70`), commands `deltaReview.viewAsTree`/`viewAsList` (`src/extension.ts:85-90`), and package.json `view/title` menu entries at `group: navigation@0` whose `when` clauses (`deltaReview.viewMode == list|tree`) swap which icon shows — the button always displays the mode a click switches to.

`refresh()` (`src/extension.ts:114-162`) recomputes the model per change; `treeView.message` is the message slot (used today for errors, `src/extension.ts:159`); the workspace file watcher (`src/extension.ts:184`) never reports `.git` paths, so the contract needs its own watcher. Existing refresh triggers (save/focus/config/repo-state, `src/extension.ts:387-398, 422`) already re-run `refresh()` frequently — re-reading the contract there is the robust fallback. `setActiveRepo` (`src/extension.ts:196-208`) is where per-repo watchers are (re)created.

## Files to modify/create

- `src/extension.ts` — contract loading in `refresh()`; grouping state + commands; contract watcher; warning message.
- `package.json` — commands `deltaReview.groupByCluster` (`icon: $(group-by-ref-type)`, or `$(layers)` if that reads better) and `deltaReview.ungroupClusters` (`icon: $(ungroup-by-ref-type)`); `view/title` entries at `group: navigation@0` (after the layout button, e.g. `navigation@1`, shifting refresh to `@2`) with `when` clauses `view == deltaReview && deltaReview.clustersAvailable && !deltaReview.grouped` / `... && deltaReview.grouped`; hide both from the command palette (`when: false`? no — palette-invokable is harmless, but match the existing pattern: viewAsTree/viewAsList are palette-visible; keep these visible too).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. **State**: `let clusterModel: ClusterModel | undefined` next to `model` (`src/extension.ts:33`); workspaceState key `deltaReview.grouped` (boolean, default false) mirroring the `viewModeKey` pattern (`src/extension.ts:45-46`); context keys `deltaReview.grouped` and `deltaReview.clustersAvailable` via `setContext` on activation and on every change.
2. **Loading**: in `refresh()`, after `computeReviewModel` succeeds (and after Task 2.2's auto-marking), call `loadClustersContract(git, model.branch)`:
   - `ok` → `clusterModel = resolveClusterModel(contract, model.files)`, `clustersAvailable = true`, clear any contract warning.
   - `missing` → `clusterModel = undefined`, `clustersAvailable = false`, no warning (REQ-CONTRACT-3).
   - `invalid` → same as missing **plus** `treeView.message = "⚠ " + error` (REQ-CONTRACT-4); don't overwrite a *fatal* model error message (the catch branch at `src/extension.ts:152-161` still wins).
   - Effective grouping (what Task 3.3 renders) = `groupedPreference && clusterModel !== undefined` — a vanished/invalid contract falls back to ungrouped without erasing the stored preference (REQ-VIEW-5).
3. **Commands**: `groupByCluster` / `ungroupClusters` set the preference, persist, `setContext`, `treeProvider.refresh()` — copy `setViewMode`'s shape.
4. **Watcher**: in `watchRepo`/`setActiveRepo`, alongside the existing repo watcher, create a `FileSystemWatcher` with `new vscode.RelativePattern(vscode.Uri.file(<common-dir>/delta-review), "*.json")` (compute the common dir once per repo via `git rev-parse --git-common-dir`; the directory may not exist yet — VS Code watchers handle that, events fire once it's created). Wire create/change/delete → `scheduleRefresh` and dispose with the repo watcher disposables (`src/extension.ts:175-193`).
5. **Branch changes** re-derive everything because `refresh()` recomputes `model.branch` and reloads the contract for that branch — no extra wiring (REQ-CONTRACT-5's branch clause).
6. Keep `treeView.message` cleared on healthy refreshes (`src/extension.ts:136`) except when step 2's warning applies.

## Testing suggestions

- Manual (F5 dev host, test repo): no contract → no grouping button, panel as today, no warnings. Create a valid contract file → button appears (within the debounce, or on focus) → click toggles icon and context key → reload window → preference persisted. Overwrite with `{"version": 3}` → button gone, ⚠ message shows, panel falls back to ungrouped. Delete the file → warning clears, button gone. Recreate valid → button back; if grouping was on before, it's still on (preference survived).
- Test exception applies (no e2e infrastructure): manual dev-host verification above; contract parsing states already unit-tested in Task 3.1.

## Gotchas

- Don't rely on the existing repo-root watcher for `.git` paths — delivery of events under `.git` is not guaranteed (it varies by watcher type and `files.watcherExclude`); the dedicated directory-scoped watcher is the intended channel, and the per-refresh re-read makes correctness independent of watcher delivery either way (watchers on non-workspace dirs use polling and can lag).
- The common dir for a linked worktree is outside `repoRoot` — always derive it from `git rev-parse --git-common-dir`, never assume `<repoRoot>/.git`.
- `setContext` is global to the window; keys are already namespaced (`deltaReview.`) — follow that.
- Menu `group: navigation@N` ordering: keep layout button first (`@0`), grouping second, refresh last, matching the title bar in scenario 3 of the approved mocks (`.mise/mocks.html`).
- Generation-counter discipline: the contract load is an await inside `refresh()` — re-check `generation !== refreshGeneration` after it (pattern at `src/extension.ts:131-133`).

## Verification checklist

- [ ] Grouping button appears only with a valid contract; icon and context keys track state; preference survives window reload
- [ ] Invalid contract → ⚠ in `treeView.message`, fallback to ungrouped, stored preference intact (verified by recreating a valid file)
- [ ] Contract create/change/delete refreshes the view without manual action
- [ ] No contract → byte-identical UI to before this task
- [ ] `yarn build`/`lint`/`test` green
- [ ] End-to-end: Test exception (no e2e infra) — manual dev-host pass above
