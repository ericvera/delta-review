# Task 2.1: Reviewed bucket and needs-review-only cluster rendering

## Goal

Restructure grouped-mode rendering in `src/treeProvider.ts`: clusters/Unclustered/Auto render only needs-review files, a new always-present **Reviewed** bucket renders every reviewed file at the bottom of the view, fully reviewed clusters show an `All files reviewed.` message, and the in-place `✓` suffix is removed.

## Requirements addressed

REQ-STRUCT-1..6, REQ-REV-1..7, REQ-COUNT-1/2, REQ-FLOW-1/2/4 (rendering side), REQ-COLLAPSE-1, REQ-COLLAPSE-2 (rendering side), REQ-EDGE-1..4, REQ-PRESERVE-1/3/4

## Background

Delta Review is a VS Code extension (SCM sidebar tree). File review status is derived by content comparison (`FileReviewStatus` in `src/model.ts:12-15`); `model.files` is path-sorted. When a valid clusters contract exists and grouping is on, `ReviewTreeProvider` (`src/treeProvider.ts`) renders cluster buckets; otherwise it renders ungrouped **Needs Review**/**Reviewed** groups. Today, grouped reviewed files stay visible in place inside their cluster with a `✓` description suffix; this task moves them into a Reviewed bucket instead.

Task 1.1 added pure helpers to `src/clusters.ts`: a status filter (`filesWithStatus` or `filterByStatus` — check which name Task 1.1 chose and import it) and `clusterBodyState(files) → "no-files" | "all-reviewed" | "has-needs-review"`. Full-membership helpers `clusterFilesForKey`, `clusterCountDescription`, `clusterContextValue` are unchanged and must keep receiving full membership.

Current rendering (all in `src/treeProvider.ts`):

- Element union at lines 20-74: `group`, `autoGroup`, `cluster`, `message`, `folder`, `file`. `FileElement.grouped?: true` (lines 63-66) exists solely to append `✓` to reviewed grouped rows (lines 416-424).
- Grouped root: `getChildren` with no element (lines 137-159) → clusters `c<i>` in contract order (empty ones included), then `unclustered`/`auto` pushed only when their membership is non-empty.
- `clusterChildren` (lines 204-236): `unclustered`/`auto` → all files, `alwaysFlat: true, grouped: true`; real cluster: empty → message `No files from this cluster are in the current change.`; list mode → files with `grouped: true`; tree mode → `treeChildren(files, "", { clusterKey })`.
- `folderScopeFiles` (lines 240-250): cluster scope → `clusterFilesForKey(clusterModel, clusterKey)`; ungrouped scope → `this.filesWithStatus(status, "normal")` (private method, line 498).
- `treeChildren(files, parentPath, scope)` (lines 257-289): folders-first alphabetical, stamps scope (`status?`/`clusterKey?`) onto children; cluster-scoped file children get `grouped: true`.
- Folder TreeItem (lines 352-383): cluster-scoped folders compute `hasNeedsReview` under the prefix to choose `needsReviewFolder` vs `reviewedFolder` contextValue (because reviewed files currently render in place).
- Collapse: `collapseKeyFor` (lines 84-95) — `folder:<clusterKey ?? status>:<path>`, groups use bare status (ungrouped Reviewed group key is `"reviewed"`); `isDefaultCollapsed` (lines 101-103) — only autoGroup and `cluster:auto`. Persistence conventions live in `src/extension.ts:85-97`; collapse events (extension.ts:124-148) skip `file`/`message` kinds and route everything else through `collapseKeyFor`.
- File TreeItem (lines 385-446): URI decorations give M/A/D/R letters; contextValue `needsReviewFile`/`reviewedFile` + `Deleted` suffix (drives inline `+`/`−` and hides Open File for deleted rows — REQ-EDGE-1 comes free); description composes directory (when list mode or `alwaysFlat`) with `← <movedFrom>` (REQ-EDGE-2 comes free once the `✓` branch is gone).
- Design decisions from the overview: the bucket header reuses contextValue `reviewedGroup` so the existing `unmarkAllReviewed` inline `−` (package.json, `viewItem == reviewedGroup`, no count condition) applies — REQ-REV-6 with **no package.json changes**. There is no status-based row coloring in `src/decorations.ts`; do not add any.

## Files to modify/create

- `src/treeProvider.ts` — all changes below.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. **Element types.** Add `interface ReviewedBucketElement { kind: "reviewedBucket" }` to the union and to `CollapsibleElement`. Extend `FolderElement` with an optional reviewed-bucket scope (e.g. `inReviewedBucket?: true`) — exactly one of the three scopes (`status`, `clusterKey`, `inReviewedBucket`) is set per folder. Delete `FileElement.grouped` and its comment.
2. **Collapse keys.** `collapseKeyFor`: `reviewedBucket` → `"reviewedBucket"`; folder → `folder:<clusterKey ?? (inReviewedBucket ? "reviewedBucket" : status)>:<path>`. Update the comment above it: key namespaces (`needs-review`/`reviewed` statuses, `c<n>`/`unclustered`/`auto` cluster keys, `reviewedBucket`) must stay collision-free — this is what keeps the bucket's collapse state separate from the ungrouped Reviewed group's (REQ-EDGE-3). `isDefaultCollapsed` unchanged → the bucket is default-expanded (REQ-COLLAPSE-1).
3. **Grouped root.** In `getChildren`'s grouped branch: keep clusters in contract order; push `unclustered`/`auto` only when the bucket has ≥1 *needs-review* member (use the Task 1.1 filter over `clusterFilesForKey`) — REQ-STRUCT-4; always push `{ kind: "reviewedBucket" }` last — REQ-STRUCT-1/2.
4. **`clusterChildren`.** Compute `files = clusterFilesForKey(...)` (full membership), then render `needsReview = <filter>(files, NeedsReview)`:
   - `unclustered`/`auto`: map `needsReview` to `alwaysFlat: true` FileElements (no `grouped` flag anymore) — REQ-STRUCT-3, REQ-PRESERVE-4.
   - Real clusters: switch on `clusterBodyState(files)` — `"no-files"` → existing message text; `"all-reviewed"` → message `All files reviewed.` (REQ-STRUCT-5/6); `"has-needs-review"` → list mode: `needsReview` as plain FileElements; tree mode: `treeChildren(needsReview, "", { clusterKey })`.
5. **Reviewed bucket children.** New branch in `getChildren` for `kind === "reviewedBucket"`: `reviewed = <filter>(this.model.files, Reviewed)` — all triages, all origins (REQ-REV-1/2). List mode → plain FileElements (list mode already shows the directory description; do NOT set `alwaysFlat`); tree mode → `treeChildren(reviewed, "", { inReviewedBucket: true })` — REQ-REV-3.
6. **`folderScopeFiles`.** Add the reviewed-bucket scope: return the reviewed files of the whole model (all triages). Cluster scope: return only the cluster's needs-review files (folders there now subdivide the filtered render set). Ungrouped scope unchanged.
7. **`treeChildren`.** Extend the `scope` parameter with the reviewed-bucket marker and stamp it onto produced folder/file elements. File children no longer get `grouped`. **Also relay the marker at the folder-recursion call site**: the `getChildren` folder branch (treeProvider.ts:195-200) rebuilds the scope literal `{ status: element.status, clusterKey: element.clusterKey }` when recursing into a folder's children — it must pass the reviewed-bucket marker through too, or every bucket folder at depth ≥ 2 silently renders empty (the field is optional, so tsc won't catch the omission).
8. **Folder TreeItem.** Reviewed-bucket folders → contextValue `reviewedFolder` (all descendants reviewed by construction). Cluster folders → always `needsReviewFolder`; delete the `hasNeedsReview` scan and its comment (folders only exist while a needs-review descendant does). Ungrouped folders unchanged. Folder `id` must incorporate the same scope discriminator as the collapse key so grouped/ungrouped folder ids stay distinct.
9. **Reviewed bucket TreeItem.** In `getTreeItem`: label `Reviewed`, `new vscode.ThemeIcon("check")`, description `String(reviewed count over this.model.files)` (includes auto files — REQ-REV-7), `id: "reviewedBucket"`, contextValue `"reviewedGroup"`, collapsible per `isCollapsed(collapseKeyFor(element), false)`.
10. **`✓` removal.** Delete the `reviewedMark` logic (lines 416-424) so `item.description` is just `locationText` — REQ-REV-4; movedFrom composition stays intact (REQ-EDGE-2).
11. Update the file-top comments that describe reviewed-in-place behavior (e.g. lines 63-66's removed flag, line 363-366's folder comment).

## Testing suggestions

- `yarn build` (tsc catches every element-union switch that misses the new kind), `yarn lint`, `yarn test` (existing suites stay green — this task adds no testable pure logic).
- Manual, in the F5 Extension Development Host (config Test exception — no e2e infrastructure), against a repo with a clusters contract (DEVELOPMENT.md "Clusters contract" for the path/schema; manual script steps 17-22 describe the setup):
  - Grouped list mode matches mock 1A: clusters show only needs-review rows; Reviewed bucket last with check icon, plain count, muted-free ordinary rows with directory descriptions; no `✓` anywhere.
  - Mark a file (`+`) → row moves to Reviewed; unmark (`−`) → returns to its cluster (REQ-FLOW-1, REQ-REV-5). Edit a reviewed file → returns to its cluster (REQ-FLOW-2).
  - Fully review a cluster → header stays `n/n` with `All files reviewed.` row; header `−` still bulk-unmarks it (REQ-STRUCT-5, REQ-FLOW-4).
  - Review all Unclustered/Auto members → those headers disappear (REQ-STRUCT-4); the files sit in Reviewed inline, no subgroup.
  - Nothing reviewed → Reviewed present at `0` with no children (mock 3A). Everything reviewed → all rows in the bucket.
  - Tree mode matches mock 2 (bucket renders as one tree), including reviewed files nested two or more directories deep (exercises the folder-recursion scope relay); toggle list/tree inside clusters still works (REQ-PRESERVE-3); ungrouped view unchanged (REQ-PRESERVE-1); collapse the bucket, reload, still collapsed; ungrouped Reviewed group's collapse state unaffected (REQ-EDGE-3).

## Gotchas

- Header counts and header context values MUST keep using full membership — passing filtered lists to `clusterCountDescription`/`clusterContextValue` silently breaks REQ-COUNT-1/REQ-FLOW-4 (a fully reviewed cluster would show `clusterEmpty` and lose its `−`).
- `unclustered`/`auto` root visibility now depends on needs-review membership, not total membership — using the old non-empty check leaves a header with zero child rows.
- Don't set `alwaysFlat` on reviewed-bucket rows: it would force directory descriptions in tree mode. List mode shows directories without it.
- Folder bulk `−` inside the bucket will skip auto files until Task 2.2 fixes `folderScopeFiles` in `extension.ts` — expected mid-phase state; note it, don't fix extension.ts here (that task also updates its comment).
- The collapse-event guard in extension.ts (lines 124-148) skips only `file`/`message` kinds — `reviewedBucket` flows through `collapseKeyFor` automatically; no extension.ts change needed for collapse.
- `deltaReview.markFileReviewed`/`unmarkFileReviewed`/`openFile` handlers check `element.kind === "file"` — reviewed-bucket rows are ordinary FileElements, so they work untouched.

## Verification checklist

- [ ] `yarn build`, `yarn lint`, `yarn test` all green
- [ ] Manual dev-host pass covering the bullets above (mock scenarios 1A, 2, 3A; mark/unmark/edit round-trips; collapse persistence)
- [ ] `grep -n "grouped" src/treeProvider.ts` shows no leftover FileElement.grouped references
- [ ] End-to-end tests: none — config Test exception (no e2e infrastructure); substitute is the manual dev-host pass above
