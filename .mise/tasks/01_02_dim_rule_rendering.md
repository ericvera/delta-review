# 01_02 Dim rule rendering

## Goal

In the Delta Review grouped view, dim every row with nothing to review right now (cluster headers, directories, files, and the Reviewed bucket), and swap a cluster's `layers` icon for `watch` when anything inside it is flagged waiting, so actionable clusters stand out at a glance. Expose the rendered rows to the test-only `deltaReview.__inspect` command and update the docs.

## Files to modify/create

- `src/decorations.ts`
- `src/treeProvider.ts`
- `src/extension.ts`
- `DEVELOPMENT.md`
- `README.md`

## Background

- Task 01_01 added to `src/clusters.ts`: `ClustersContract.waitPaths`, `ClusterBucket.waitingPaths?: ReadonlySet<string>`, `isWaitingFile(model, file)` (member of a real cluster with `wait: true` or in its `waitingPaths`; status-agnostic), `clusterHeaderTone(bucket): { dimmed; hourglass }`, and `everyFileWaiting(model, files)`.
- Row tinting works through a private URI scheme: a tree row's `resourceUri` carries a query, and `createReviewDecorationProvider` (src/decorations.ts:118-136) returns a `FileDecoration` whose color tints the label (and badge). A row can set both a `label` and a `resourceUri`: the label wins for display and the color still applies (Unclustered header: src/treeProvider.ts:616-622, src/decorations.ts:63-78). A `FileDecoration` never colors icons; a `ThemeIcon` takes its own `ThemeColor` (src/notesTreeProvider.ts:50-65, src/treeProvider.ts:617-620).
- Current wait muting: `WAIT_COLOR` (`gitDecoration.ignoredResourceForeground`, src/decorations.ts:23-26), file query `<kind>,wait`, folder/header query `wait` (src/decorations.ts:30-59, :104-116). Cluster header src/treeProvider.ts:623-643, folder :468-495, file :506-513 and :571-573, Reviewed bucket header :402-424.
- Codicons have no hourglass; use `watch`.
- Design decisions (spec `## Design`, "Rendering"):
  - One grey: rename `WAIT_COLOR` to exported `DIM_COLOR`.
  - File query `<kind>` | `<kind>,wait` (DIM_COLOR, `WAIT_TOOLTIP`) | `<kind>,dim` (DIM_COLOR, the kind's normal tooltip); badge letters kept. `createReviewItemUri(file, tone: "normal" | "waiting" | "dimmed")`.
  - Folder and header query `dim` (DIM_COLOR, no badge, no tooltip) or `""`. `createReviewFolderUri(path, dimmed)`. Replace `createWaitingClusterHeaderUri` with `createDimmedHeaderUri(id)` (path `/header/<id>`). Remove `WAITING_FOLDER_DECORATION` and the bare `wait` query.
  - Real cluster header: from `clusterHeaderTone(bucket)`; icon `new ThemeIcon(hourglass ? "watch" : "layers", dimmed ? DIM_COLOR : undefined)`; `resourceUri = createDimmedHeaderUri(\`cluster-${clusterKey}\`)` only when dimmed. Tooltip: summary, plus `WAIT_TOOLTIP` when `bucket.wait`, else plus `SOME_WAITING_TOOLTIP` = "Some files are waiting on the agent: still expected to change." (export from decorations.ts) when hourglass; join like today (src/treeProvider.ts:637-640, blank line between, summary omitted when empty).
  - Cluster folder (tree mode): dimmed = `everyFileWaiting(clusterModel, <needs-review files it renders under its path>)`; tooltip gains `WAIT_TOOLTIP` when dimmed. Reviewed-bucket folder: always dimmed, plain path tooltip. Ungrouped folders: never dimmed.
  - File row, grouped only: `"waiting"` when needs-review and `isWaitingFile`; `"dimmed"` when `file.status === FileReviewStatus.Reviewed`; else `"normal"`. Tooltip `WAIT_TOOLTIP` line only for `"waiting"`. Unclustered/Auto needs-review rows stay normal (`isWaitingFile` is false for them).
  - Reviewed bucket header: `new ThemeIcon("check", DIM_COLOR)`, `resourceUri = createDimmedHeaderUri("reviewed-bucket")`.
  - Unchanged: count text, context values, ids, collapse state, Unclustered/Auto headers, message rows, ungrouped mode (the treeProvider's `isGrouped() === false` output must not change).
  - Icon limitation: folder and file icons come from the file icon theme and cannot be colored; only their labels and badges dim.
  - `__inspect` gains `treeRows` (see Implementation details).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `src/decorations.ts`: implement the query scheme above. Keep `REVIEW_ITEM_SCHEME`, `WAIT_TOOLTIP`, the Unclustered header pieces, and `DECORATIONS` as they are; build `WAITING_DECORATIONS` and a `DIMMED_DECORATIONS` map from `DECORATIONS` (pattern at src/decorations.ts:104-110). Provider order: unclustered header, `dim` (folder/header), `,wait` suffix, `,dim` suffix, plain kind.
2. `src/treeProvider.ts`: import `clusterHeaderTone`, `everyFileWaiting`, `DIM_COLOR`, `SOME_WAITING_TOOLTIP`, `createDimmedHeaderUri`; drop `isWaitingClusterKey` usage if no longer needed (keep the export in clusters.ts; it is tested). Folder dimming: reuse `this.folderScopeFiles(element).filter((f) => f.path.startsWith(\`${element.path}/\`))` (already computed for `contextValue` at :488-493; compute once). Grouping check for file rows stays `this.isGrouped()`; Reviewed-bucket folders only exist grouped.
3. `src/extension.ts` `deltaReview.__inspect` (src/extension.ts:2020-2043): add `treeRows`, a depth-first walk from `treeProvider.getChildren(undefined)` through `getChildren(element)` for every element regardless of collapse state, each row `{ id, label, description, icon, iconColor, query }`: `label` is the string label, or `TreeItemLabel.label`, or the basename of `resourceUri.path` when the label is undefined; `icon`/`iconColor` from `iconPath instanceof vscode.ThemeIcon` (`.id`, `.color?.id`); `query` = `resourceUri?.query`. Keep it a small local helper inside the `DELTA_REVIEW_TEST` block.
4. `DEVELOPMENT.md`:
   - Line 83 tooltip list: the wait line also shows for a file covered by `waitPaths`.
   - Line 117 `wait` bullet and the 01_01 `waitPaths` bullet: replace the rendering wording with a pointer to the dim rule below.
   - After line 131, add a "Dim rule" bullet: the rule, the `watch` icon condition, the `SOME_WAITING_TOOLTIP` line, Reviewed bucket always dim, grouped-only, icon limitation, Unclustered/Auto never dim.
   - Line 213: list `treeRows` among `__inspect` returns.
   - Manual step 27 (line 256): a fully reviewed cluster's header dims with `layers`; the Reviewed bucket header and rows render dimmed.
   - Manual step 31e (line 265): rewrite for the new behavior (cluster `wait` → `watch` icon + dimmed header and rows; a `waitPaths` file entry → only that file dims, cluster stays bright with `watch` and the some-waiting tooltip; a directory entry covering all of a cluster's remaining files → folder and header dim; `"waitPaths": "x"` → `⚠ Clusters contract: "waitPaths" must be an array of strings`).
5. `README.md` line 68 bullet (user-facing, one-liner bullets): add that clusters with nothing left to review (done, waiting on the agent, or empty) render dimmed, and an hourglass-style `watch` icon marks a cluster still waiting on the agent.

## Gotchas

- `vscode` cannot be imported under Vitest: all rule logic already lives in `src/clusters.ts` (01_01); keep treeProvider/decorations changes as glue. No new pure logic here without a test; if you add any, put it in a vscode-free module with a colocated test.
- A row with `resourceUri` and no explicit `iconPath` gets a file-icon-theme icon: keep explicit `iconPath` on every header that gains a `resourceUri`.
- Header URIs must stay distinct from file URIs (`/header/...` prefix) so a decoration for a header never lands on a file named like it.
- Do not change context values (package.json:358-383 match `^clusterNeedsReview`, `^(clusterReviewed|clusterNeedsReviewSnapshot)$`).
- Prettier: keep `.mise/` and `.claude/` in `.prettierignore`; do not run `yarn format` over them.
- Extension-host launches steal focus: run the scripted check once, batched, at the end.
- No `REQ-*` ids. Comments explain why.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`; all green.
- Unit tests: the rule is covered by 01_01's `src/clusters.test.ts`; this task's source files import `vscode` and cannot be unit tested.
- Scripted extension-host check (DEVELOPMENT.md, "Scripted extension-host checks"; harness in the session scratchpad, not committed; launch with `env -u ELECTRON_RUN_AS_NODE`, short `--user-data-dir`, `DELTA_REVIEW_TEST=1` in `extensionTestsEnv`). In a temp git repo with a branch off `main`, write a contract with: cluster A with one plain file and one file under a `waitPaths` directory; cluster B `wait: true`; cluster C whose files are all marked reviewed (`deltaReview.markClusterReviewed` or per-file mark); cluster D naming no changed file; one unclustered file covered by a `waitPaths` entry. Run `deltaReview.groupByCluster` and `deltaReview.viewAsTree`, then assert on `__inspect().treeRows`:
  - A: icon `watch`, no `iconColor`, `query` undefined; its waiting folder `query` `dim`, its waiting file `query` `<kind>,wait`, its plain file `<kind>`.
  - B: icon `watch`, `iconColor` `gitDecoration.ignoredResourceForeground`, `query` `dim`.
  - C and D: icon `layers`, dim color, `query` `dim`.
  - Unclustered header and file unchanged (`unclustered-header` query, file `<kind>`).
  - Reviewed bucket header: icon `check`, dim color, `query` `dim`; its file rows `<kind>,dim`.
  - Ungroup (the command that reverses `groupByCluster`, see package.json) → no row has a `dim` or `,wait` query.
- Eyeball once in the dev host (purely visual polish): grey labels and icons as in `.mise/mock/variant-2b.html`.
