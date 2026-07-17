# Task 2.1: Auto subgroups + bulk actions in the existing list/tree modes

## Goal

Auto-triaged files render in a distinct collapsed **Auto** subgroup — first under Needs Review, and (once reviewed) first under Reviewed — in both list and tree layouts, with header-level bulk mark/unmark actions. Non-auto rendering is unchanged; with no auto files, everything is byte-for-byte today's UI.

## Requirements addressed

REQ-AUTO-3 (ungrouped placement), REQ-AUTO-4, REQ-AUTO-5 (ungrouped half), REQ-AUTO-7, REQ-AUTO-9, REQ-CLUS-7 (Auto contents always flat), REQ-PRESERVE-2.

## Background

The feature: files matching auto-review globs / `linguist-generated` (classified as `triage: 'auto'` on `ReviewFile` by Task 1.2 in `src/model.ts`) are mechanical noise; reviewers approve them in bulk rather than one by one. They must never be hidden — reviewed auto files stay inspectable.

Rendering lives in `src/treeProvider.ts`. Current element kinds: `GroupElement {kind:'group', status}` (the Needs Review / Reviewed roots), `FolderElement {kind:'folder', status, path}`, `FileElement {kind:'file', file}`. `getChildren` (`src/treeProvider.ts:57`): root → two groups; group → `filesWithStatus(status)` as flat files (list mode) or `treeChildren(status, '')` (tree mode); folder → `treeChildren(status, element.path)`. `treeChildren` (`src/treeProvider.ts:83`) renders folders-then-files alphabetical, no compaction. `getTreeItem` (`src/treeProvider.ts:114`): group rows use a plain label, count via `item.description`, `contextValue` `needsReviewGroup`/`reviewedGroup`; file rows use `createReviewItemUri(file)` (M/A/D decoration), `contextValue` `needsReviewFile`/`reviewedFile`(+`Deleted`), directory in `description` in list mode only, click opens the diff.

Collapse persistence: `collapseKeyFor` (`src/treeProvider.ts:29`) maps group → bare status, folder → `folder:<status>:<path>`; `src/extension.ts:73-84` stores keys in the `deltaReview.collapsedGroups` workspaceState set, and the provider constructor receives `isCollapsed(key)`. **Default-collapsed is achieved by treating an absent key as collapsed for the new Auto elements — see Implementation details step 3.**

Commands/menus live in `package.json` `contributes` + `src/extension.ts:231-385`. Bulk patterns to copy: `deltaReview.markFolderReviewed` (`src/extension.ts:299-322`) filters `model.files` by status + prefix and calls `markReviewed(git, model.branch, paths)` (`src/reviewState.ts:90`); menus attach inline `✓`/`−` via `view/item/context` with `viewItem ==` matches; `commandPalette` section hides element-bound commands with `when: false`.

## Files to modify/create

- `src/treeProvider.ts` — new element kind `AutoGroupElement {kind:'autoGroup', status}`; children/item logic (below).
- `src/extension.ts` — register `deltaReview.markAutoReviewed` / `deltaReview.unmarkAutoReviewed`; extend the collapse/expand listeners for the default-collapsed convention (Implementation details step 3).
- `package.json` — declare both commands (`icon: $(add)` / `$(remove)`, category Delta Review); `view/item/context` inline+navigation entries for `viewItem == needsReviewAutoGroup` / `reviewedAutoGroup`; hide from palette.
- `src/treeProvider.test.ts` (new, only if a pure extraction makes sense — see Gotchas; otherwise skip tests here and rely on Task 3.1's pure-core tests plus manual verification).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. **Children.** In `getChildren` for a `group` element: compute `autoFiles = filesWithStatus(status).filter(f => f.triage === 'auto')`. If non-empty, prepend `{kind:'autoGroup', status}` and render the *rest* (non-auto files) via the existing list/tree paths — i.e. `filesWithStatus` gains a triage filter or the group/tree paths take a pre-filtered list. `treeChildren` must therefore operate on non-auto files only (auto files never appear in the folder tree, per REQ-CLUS-7). If `autoFiles` is empty, the subgroup is omitted (REQ-AUTO-9) and output is identical to today (REQ-PRESERVE-2).
2. **Auto group children**: its auto files as flat `FileElement`s, alphabetical, in both layouts. File rows keep their existing rendering (M/A/D, dir description in *both* layouts here — the flat list needs the location).
3. **Item.** `getTreeItem` for `autoGroup`: label `Auto`, `iconPath: new vscode.ThemeIcon("gear")`, `description` = count (needing-review count under Needs Review; plain count under Reviewed — statuses never mix within one subgroup here), `id: autoGroup:<status>`, `contextValue` `needsReviewAutoGroup`/`reviewedAutoGroup`, tooltip explaining what lands here ("Matches deltaReview.autoReview.globs or linguist-generated"). Collapsible state: collapsed **by default**. Mechanism (fixed — Task 3.3 reuses it): `collapseKeyFor` → `autoGroup:<status>`; default-collapsed elements are collapsed unless an `expanded:<collapseKey>` entry exists in the same persisted `deltaReview.collapsedGroups` set. This requires extending the collapse/expand listeners in `src/extension.ts:73-84`: for default-collapsed element kinds, `onDidExpandElement` **adds** `expanded:<key>` and `onDidCollapseElement` **removes** it (the inverse of the existing convention); expose it to the provider by widening the constructor callback to `isCollapsed(key, defaultCollapsed: boolean)`. Existing group/folder behavior stays bit-identical (they keep `defaultCollapsed = false` and the current absence-means-expanded convention).
4. **File description in list mode**: current code shows directory only when `getViewMode() === 'list'` (`src/treeProvider.ts:172-176`); auto-group children should show it in tree mode too — thread a flag or check parent kind.
5. **Commands** in `src/extension.ts`: `markAutoReviewed` → paths = files with `triage === 'auto' && status === NeedsReview` → `markReviewed` → `refresh()`; `unmarkAutoReviewed` mirrors with Reviewed + `unmarkReviewed`. Copy the guard style of `markFolderReviewed` (`git`/`model`/element checks).
6. **Group-level Mark All** (`deltaReview.markAllReviewed`, `src/extension.ts:349`) already covers every needs-review file including auto — leave untouched (REQ-AUTO-7).

## Testing suggestions

- Manual (F5 dev host, repo with `yarn.lock`-style files and globs configured): Auto subgroup appears collapsed at top of Needs Review with count and ⚙; expanding shows flat files with dir descriptions in both layouts; header ✓ marks exactly the auto files; they reappear in an Auto subgroup under Reviewed; unmark works; with globs `[]` and no linguist-generated files the panel is identical to before.
- `git ls-tree -r refs/review/<branch>` after bulk-approve shows the auto files' blob shas (normal snapshot path).
- Test exception applies (no e2e infrastructure): manual dev-host verification per above; unit tests for triage already exist (Task 1.2).

## Gotchas

- **Don't regress collapse persistence**: group elements' keys are bare status strings for backward compat (`src/treeProvider.ts:27-34` comment) — don't change existing keys.
- The `viewItem` regexes in package.json for files use prefix matches (`/^needsReviewFile/`) — name the new contextValues so they don't collide with those regexes (`needsReviewAutoGroup` does not match `^needsReviewFile`, fine; but `needsReviewGroup` matchers use `==` equality, also fine).
- Deleted auto files: bulk `markReviewed` already handles deleted paths via the sentinel (`src/reviewState.ts:99-117`) — do not filter them out.
- Sorting: `model.files` is pre-sorted by path (`src/model.ts:63-68`); preserve order rather than re-sorting.

## Verification checklist

- [ ] Auto subgroup renders (collapsed default, gear icon, count) under both status groups in both layouts; flat contents with directory descriptions
- [ ] Bulk ✓/− actions cover exactly the auto files; group-level Mark All still covers everything
- [ ] No auto files → zero UI difference vs. `main` behavior (side-by-side dev-host check)
- [ ] `yarn build`/`lint`/`test` green
- [ ] End-to-end: Test exception (no e2e infra) — manual dev-host pass above
