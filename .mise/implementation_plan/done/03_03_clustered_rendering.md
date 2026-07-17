# Task 3.3: Clustered rendering — clusters, Unclustered, Auto, actions

## Goal

With grouping on, the tree renders top-level clusters (contract order) → Unclustered (warning-styled) → Auto, honoring the layout lever inside clusters (flat list or folder tree), with header counts, summary tooltips, bulk actions, empty-cluster placeholders, and collapse persistence. This completes Feature 1's UI.

## Requirements addressed

REQ-CLUS-1 through REQ-CLUS-10, REQ-AUTO-3/4/5 (grouped placement + counts), REQ-PRESERVE-3.

## Background

State so far: `ReviewFile` has `triage` (Task 1.2); `src/clusters.ts` (Task 3.1) resolves `ClusterModel { clusters: [{label, summary, files: ReviewFile[]}], unclustered: ReviewFile[], auto: ReviewFile[] }` (buckets preserve path-sorted order; auto overrides cluster membership); `src/extension.ts` (Task 3.2) computes an *effective grouped* flag (`preference && clusterModel !== undefined`) and holds `clusterModel` next to `model`. Ungrouped rendering (including the Auto subgroups from Task 2.1 with element kind `autoGroup`) must remain exactly as is when grouping is off.

`src/treeProvider.ts` structure: `ReviewTreeProvider` gets callbacks `(isCollapsed(key), getViewMode())` — extend with `getClusterModel()` / `isGrouped()` (or pass one state object; keep the ctor signature coherent). `getChildren` root currently returns the two status groups (`src/treeProvider.ts:61-66`); `treeChildren(status, parentPath)` (`src/treeProvider.ts:83-112`) builds the folder hierarchy from `filesWithStatus(status)` filtered by path prefix — reuse it for in-cluster trees by parameterizing the file source (a file list) instead of the status filter. `getTreeItem` (`src/treeProvider.ts:114`): group rows = label + `description` count + contextValue; folder rows = `createReviewFolderUri(path)`; file rows = `createReviewItemUri(file)` with M/A/D decorations, dir `description` in list mode, tooltip, `openDiff` click command — file rendering is reused untouched (REQ-PRESERVE-3).

Decorations (`src/decorations.ts`): scheme `delta-review-item`; the URI `query` selects a `FileDecoration` (letter badge + ThemeColor). A TreeItem may set **both** `label` and `resourceUri` — the label wins for display, the decoration still colors it. That's the mechanism for Unclustered's warning-colored label.

Collapse persistence: `collapseKeyFor` (`src/treeProvider.ts:29-34`) + workspaceState set in `src/extension.ts:73-84`. Folder keys are `folder:<status>:<path>` — cluster-scoped folders need distinct keys.

Bulk-action precedent: `deltaReview.markFolderReviewed` (`src/extension.ts:299-322`) — guard, filter paths, `markReviewed`, `refresh()`. Menus in `package.json` `view/item/context` keyed on `viewItem`.

Mock specifics (approved mocks live at `.mise/mocks.html`, scenario IDs 1/1T/2A/2B/3/4/5; decisions log at `.mise/mocks.context.md`): cluster header = `$(layers)`-style icon, label, `description` = `n/m` (non-auto reviewed/total), tooltip = summary; reviewed files inside clusters stay visible, dimmed, ✓ in description; Unclustered header = `$(warning)` icon + warning-colored label + `n/m`; Auto header = `$(gear)`, count (plain until statuses mix, then `n/m`), flat contents; empty cluster expands to one message row "No files from this cluster are in the current change."

## Files to modify/create

- `src/treeProvider.ts` — grouped root; new element kinds; cluster-scoped tree children; items (below).
- `src/decorations.ts` — new decoration query values: `unclustered-header` (ThemeColor `list.warningForeground`, no badge) and optionally a dimmed variant for reviewed-in-cluster file rows if the M/A/D colors read too loud (see Gotchas before adding).
- `src/extension.ts` — commands `deltaReview.markClusterReviewed` / `deltaReview.unmarkClusterReviewed` acting on cluster-kind elements (covers real clusters, Unclustered, and the grouped Auto group via their file lists).
- `package.json` — command declarations + `view/item/context` inline/navigation entries for the new contextValues.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. **Element kinds**: `ClusterElement { kind: 'cluster', clusterKey: string, /* index-based: 'c0','c1', or 'unclustered' | 'auto' */ }` and `MessageElement { kind: 'message', text: string }`. Resolve a `ClusterElement`'s files from `getClusterModel()` at render time (don't snapshot file arrays into elements — the model changes under refresh).
2. **Root** (`getChildren(undefined)`): if `isGrouped()` → `[...clusters.map((_, i) => cluster('c'+i)), ...(unclustered.length ? [cluster('unclustered')] : []), ...(auto.length ? [cluster('auto')] : [])]`; else the existing two status groups. Empty real clusters ARE rendered (REQ-CLUS-8); empty Unclustered/Auto are omitted (REQ-CLUS-4, REQ-AUTO-9).
3. **Cluster children**: Auto and Unclustered → flat `FileElement`s always, and their file rows show the directory as description **in both layouts** (REQ-CLUS-7 — same "flat rows always show location" rule Task 2.1 applies to the ungrouped autoGroup; reuse that mechanism). Real clusters → layout lever: flat → `FileElement`s; tree → `treeChildren` parameterized with the cluster's file list and a `clusterKey` scope. Empty real cluster → `[{kind:'message', text:'No files from this cluster are in the current change.'}]`.
4. **Folder scoping**: extend `FolderElement` with optional `clusterKey`; collapse key becomes `folder:<clusterKey>:<path>` when scoped (existing unscoped keys unchanged for backward compat); `treeChildren` filters within the cluster's files; folder mark/unmark commands must scope to the cluster's files under that folder — thread `clusterKey` through the element so `markFolderReviewed` can resolve the right file set (extend its filter: when `element.clusterKey` is set, filter the cluster's file list instead of `model.files`; keep status filter).
5. **Cluster items**: label; `iconPath` ThemeIcon (`layers` / `warning` / `gear`); `description`: real clusters and Unclustered `«reviewed»/«total»` of the element's files (these buckets are non-auto by construction); Auto: plain count only while nothing is reviewed yet, `n/m` from the first reviewed file onward — including `n/n` when all are reviewed (REQ-AUTO-4, REQ-AUTO-5); tooltip: summary (real clusters), explanatory text for Unclustered ("Files not claimed by any cluster") and Auto; `id` `cluster:<clusterKey>`; collapse key `cluster:<clusterKey>` — expanded default for clusters/Unclustered (absence in the collapsed set = expanded, the existing convention), collapsed default for Auto via the inverted convention Task 2.1 establishes: default-collapsed elements are collapsed unless an `expanded:<collapseKey>` entry exists in the same persisted set (the expand listener adds it, the collapse listener removes it); `contextValue`: `clusterNeedsReview` (has ≥1 needs-review file) / `clusterReviewed` (all reviewed, ≥1 file) / `clusterEmpty` (none) driving which inline action shows (✓ / − / none). Unclustered additionally sets `resourceUri` to a `delta-review-item` URI with query `unclustered-header` for the warning label color.
6. **Message item**: plain TreeItem, no icon, `TreeItemCollapsibleState.None`, no command; dim styling comes free from being a description-less plain label — acceptable per mock.
7. **Reviewed-in-cluster files**: reuse existing file rendering; append `✓` to the `description` for `status === Reviewed` when grouped — flat rows (all cluster-flat, Unclustered, Auto): `dir ✓`; tree-nested rows inside real clusters: bare `✓` (the hierarchy carries the location; Unclustered/Auto rows are never tree-nested and always keep the dir). Existing M/A/D decoration remains (REQ-PRESERVE-3).
8. **Commands**: `markClusterReviewed` → element's files with status NeedsReview → `markReviewed`; `unmarkClusterReviewed` → element's files with status Reviewed → `unmarkReviewed`. Menus: ✓ on `viewItem == clusterNeedsReview`, − on `clusterReviewed` (inline + context, copying the folder entries' shape). Existing file-level and folder-level actions work unchanged on the reused element kinds.
9. **Lever interplay**: switching levers only changes rendering — assert no state writes anywhere in the new paths (REQ-CLUS-10).

## Testing suggestions

- Extract any nontrivial pure decisions (e.g. cluster contextValue/count-format selection from a file list) into `src/clusters.ts` or a small helper and unit-test them; tree provider itself is vscode-bound and verified manually.
- Manual (F5 dev host, contract from mock scenario 1's shape): verify against scenarios 1, 1T, 4 in `.mise/mocks.html` — order, counts, tooltips, warning color, Auto last and collapsed, empty-cluster message row, flat⇄tree inside clusters with per-cluster folder collapse, bulk ✓/− per cluster/Unclustered/Auto, per-file actions and diffs unchanged, no state change on lever flips (flip both levers, confirm `git ls-tree -r refs/review/<branch>` unchanged).
- Test exception applies (no e2e infrastructure): manual dev-host verification per above + unit tests for extracted helpers.

## Gotchas

- **Don't snapshot files into elements** — `getChildren`/`getTreeItem` must read through `getClusterModel()` so refreshes re-resolve; stale captured arrays are the classic tree-provider bug.
- TreeItem `id` collisions break VS Code trees silently: cluster keys are index-based (`c0`), so two clusters with identical labels stay distinct (assumption recorded in requirements).
- Setting `resourceUri` on the Unclustered header changes nothing about its children — only that row gets the query; folder URIs (`createReviewFolderUri`) have no query → no decoration, keep it that way.
- The dim look of reviewed rows: VS Code has no per-item opacity; the ✓-in-description plus the muted decoration colors is the approved look (`.mise/mocks.context.md` tweaks log, API-grounding entry) — don't chase custom dimming (that would need a second decoration with a muted ThemeColor replacing M/A/D; only add if the M/A/D variant genuinely misreads, and keep the letter badge).
- `collapseKeyFor` must handle every collapsible kind — the collapse listeners in `src/extension.ts:73-84` call it for any non-file element; a missed kind throws at runtime.
- Keep group elements' existing behavior when ungrouped: literally the same code path, gated once at the root.

## Verification checklist

- [ ] Grouped view matches mocks 1/1T/4: order (clusters → Unclustered → Auto), counts, tooltips, warning styling, flat/tree per lever, message row for empty clusters
- [ ] Bulk and per-file actions correct in every combination; folder actions scoped to their cluster
- [ ] Lever flips change zero review state (`git ls-tree -r refs/review/<branch>` before/after identical)
- [ ] Collapse state persists per cluster and per cluster-scoped folder across reloads
- [ ] `yarn build`/`lint`/`test` green
- [ ] End-to-end: Test exception (no e2e infra) — manual dev-host pass above
