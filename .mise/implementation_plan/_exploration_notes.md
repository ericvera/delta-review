# Exploration Notes

Key facts about the codebase, verified 2026-07-17 against the working tree.

## Files and roles

- `src/treeProvider.ts` (511 lines) — `ReviewTreeProvider`, the whole tree rendering. Element union `ReviewTreeElement`: `group` (ungrouped Needs Review/Reviewed), `autoGroup` (Auto subgroup under an ungrouped group), `cluster` (grouped root buckets incl. synthetic `unclustered`/`auto`), `message` (dim info row), `folder`, `file`.
- `src/clusters.ts` (294 lines) — contract parsing, `ClusterModel` resolution, pure helpers (`clusterFilesForKey`, `clusterContextValue`, `clusterCountDescription`). No `vscode` import → unit-testable.
- `src/clusters.test.ts` — Vitest tests for clusters.ts; factories at lines 21-35: `file(path, triage = "normal")` (needs-review) and `reviewedFile(path, triage = "normal")` (reviewed).
- `src/extension.ts` (743 lines) — activation, commands, refresh loop, collapse persistence, its own `folderScopeFiles` (extension.ts:405-412) mirroring the tree provider's.
- `src/model.ts` — `ReviewFile` (path, status, deleted, movedFrom, triage, …), `FileReviewStatus` enum (`"needs-review"` / `"reviewed"`), `computeReviewModel`. `model.files` is path-sorted.
- `src/decorations.ts` — M/A/D/R letters + theme colors via URI query; NO status-based (reviewed vs needs-review) coloring exists anywhere — "muted" look in the mock is aspirational language; today reviewed rows look identical to needs-review rows apart from placement/✓.
- `package.json` — commands + menus. Context values in play: `needsReviewFile`/`reviewedFile`(+`Deleted` suffix), `needsReviewFolder`/`reviewedFolder`, `needsReviewGroup`/`reviewedGroup`, `needsReviewAutoGroup`/`reviewedAutoGroup`, `clusterNeedsReview`/`clusterReviewed`/`clusterEmpty`.

## Grouped-mode rendering today (what changes)

- Root (`getChildren` no element, treeProvider.ts:137-159): grouped → clusters `c<i>` in contract order (empty included), then `unclustered` and `auto` only when non-empty; ungrouped → the two `group` elements.
- `clusterChildren` (treeProvider.ts:204-236): `unclustered`/`auto` → all bucket files as `alwaysFlat: true, grouped: true` FileElements; real cluster with 0 files → message "No files from this cluster are in the current change."; else list mode → all files (`grouped: true`), tree mode → `treeChildren(files, "", {clusterKey})`.
- Reviewed-in-place ✓: `FileElement.grouped?: true` (treeProvider.ts:63-66) drives a `✓` description suffix (treeProvider.ts:416-424). This flag exists ONLY for that suffix.
- Cluster folder contextValue (treeProvider.ts:362-380): cluster-scoped folders check `hasNeedsReview` under the prefix because reviewed files render in place; ungrouped folders use the group status.
- `folderScopeFiles` (treeProvider.ts:240-250): cluster scope → `clusterFilesForKey` (full bucket); ungrouped scope → `filesWithStatus(status, "normal")`.

## Counts, context values, bulk actions (mostly unchanged)

- `clusterCountDescription(files, plainUntilFirstReviewed)` (clusters.ts:98-109): reviewed/total; Auto passes `true` → plain total until first reviewed. Operates on full membership — keep calling with full membership.
- `clusterContextValue(files)` (clusters.ts:84-93): `clusterNeedsReview` | `clusterReviewed` | `clusterEmpty` over full membership → drives header +/− (package.json menus). Untouched = REQ-FLOW-4 satisfied.
- Bulk commands (extension.ts): `markClusterReviewed`/`unmarkClusterReviewed` filter `clusterFilesForKey` by status — full membership, unaffected by rendering. `unmarkAllReviewed` (extension.ts:447-462) unmarks every reviewed file in `model.files` — exactly the Reviewed bucket's contents, and its menu entry binds to `viewItem == reviewedGroup` inline (package.json), no count condition.
- Folder commands (extension.ts:482-530) filter `folderScopeFiles(element)` by status + path prefix. extension.ts `folderScopeFiles` must learn the reviewed-bucket scope (else auto files under a folder would be skipped — REQ-COLLAPSE-2).

## Collapse persistence

- `collapseKeyFor` (treeProvider.ts:84-95): `group` → bare status (`"reviewed"` is the ungrouped Reviewed group's key), `autoGroup:` prefix, `cluster:` prefix, `folder:<clusterKey ?? status>:<path>`. Key namespaces must not collide — a new `reviewedBucket` key and `folder:reviewedBucket:<path>` folder keys are safely distinct from `"reviewed"`/`folder:reviewed:...` (REQ-EDGE-3).
- `isDefaultCollapsed` (treeProvider.ts:101-103): only autoGroup + cluster:auto. Reviewed bucket is default-expanded → store bare key while collapsed (the existing default-expanded convention, extension.ts:85-97).
- Collapse events (extension.ts:124-148) skip `file`/`message` kinds via early return; any new collapsible kind flows through `collapseKeyFor` automatically, but the guard `element.kind === "file" || element.kind === "message"` must still exclude only those.

## Rendering details

- File rows (treeProvider.ts:385-446): URI via `createReviewItemUri` (M/A/D/R decoration), `id: file:<path>`, contextValue `needsReviewFile|reviewedFile(+Deleted)`, description = directory (list mode or alwaysFlat) + `← movedFrom`, tooltip, `deltaReview.openDiff` command. Reviewed bucket rows need NO new row logic — a plain FileElement (not alwaysFlat) in list mode already shows the directory; tree mode hides it.
- `treeChildren(files, parentPath, scope)` (treeProvider.ts:257-289): folders-first alphabetical; stamps scope onto produced elements. Scope today: `{status?, clusterKey?}`.
- Message rows (treeProvider.ts:343-350): plain TreeItem, no icon/command, `TreeItemCollapsibleState.None`.
- Cluster header items (`clusterTreeItem`, treeProvider.ts:449-494): label/icon per key; Unclustered warning color via `createUnclusteredHeaderUri`.

## Testing

- Vitest, colocated `*.test.ts`; `vscode` module cannot be imported under Vitest → pure logic must live outside treeProvider/extension (clusters.ts is the precedent).
- `yarn format` / `yarn lint` / `yarn build` (tsc + esbuild) / `yarn test` (vitest run).
- Test exception (config): extension-host behavior → unit tests + manual verification in the F5 dev host; DEVELOPMENT.md has the manual test script to extend.
