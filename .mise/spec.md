# Spec: cluster review status at a glance

## What

- In grouped mode, every row with nothing to review right now renders dimmed (the git-ignored grey, `gitDecoration.ignoredResourceForeground`); every row with something to review renders normally. Applies at cluster, directory, and file level.
  - Cluster header: dimmed when it has no needs-review member that is not waiting (fully reviewed, all remaining files waiting, cluster-level wait, or empty).
  - Directory row inside a cluster (tree mode): dimmed when every needs-review file under it is waiting.
  - File row inside a cluster: dimmed when waiting.
  - Reviewed bucket: header, its directories, and its file rows always dimmed.
- A real cluster's icon becomes `watch` (no hourglass codicon exists) in place of `layers` when the cluster has `wait: true` or any of its needs-review members is flagged waiting, whether the header is dimmed or not. Dimmed with `layers` means fully reviewed or empty. Waiting files and directories keep their normal icons and only dim.
- Agents can flag individual files and directories as waiting through a new top-level `waitPaths` key in the clusters contract, alongside the existing cluster-level `wait`.
- Unchanged: the `x/z` count text, Unclustered and Auto rows (never dimmed, even when a `waitPaths` entry covers their files), contract order, expansion/collapse behavior, context values and inline actions, ungrouped mode rendering.

## Design

### Contract: `waitPaths`

- Top-level optional array of strings, accepted in every version (1, 2, 3), no version bump: an older extension ignores the unknown key, per the skill's Schema changes rule.
- Non-array, or any non-string entry, rejects the whole file: `"waitPaths" must be an array of strings`.
- Normalization: trailing `/` characters stripped; entries empty after stripping dropped.
- Coverage: entry `e` covers path `p` when `p === e` or `p` starts with `e + "/"`. One entry thus names a file or a directory.
- Only members of real clusters can be waiting. An entry covering an Unclustered or Auto file, or naming nothing in the review set, has no effect.

### Types (`src/clusters.ts`)

- `ClustersContract.waitPaths: string[]` (required, normalized; `[]` when absent).
- `ClusterBucket.waitingPaths?: ReadonlySet<string>`: paths of the bucket's members covered by `waitPaths`; set by `resolveClusterModel` only when non-empty. Optional so existing `ClusterModel` fixtures stay valid. `ClusterModel` shape is unchanged.
- `isWaitingFile(model, file)`: true when `file` is a member of a real cluster that has `wait: true` or whose `waitingPaths` has `file.path`. Status-agnostic, as today; callers gate on status.
- `clusterHeaderTone(bucket): { dimmed: boolean; hourglass: boolean }`, with waiting(member) = `bucket.wait === true || bucket.waitingPaths?.has(member.path)`:
  - `dimmed` = no needs-review member that is not waiting (true for an empty bucket).
  - `hourglass` = `bucket.wait === true` or some needs-review member is in `waitingPaths`.
- `everyFileWaiting(model, files)`: `files.length > 0 && files.every(f => isWaitingFile(model, f))`; drives cluster-folder dimming.

### Rendering

- `src/decorations.ts`: one dim color (`DIM_COLOR`, exported; today's `WAIT_COLOR`). File URI query `<kind>` | `<kind>,wait` (dim color, `WAIT_TOOLTIP`) | `<kind>,dim` (dim color, the kind's normal tooltip); badge letters kept in all three. Folder and header URIs use query `dim` (dim color, no badge, no tooltip) or `""` (no decoration). `createWaitingClusterHeaderUri` is replaced by `createDimmedHeaderUri(id)` (path `/header/<id>`). `createReviewItemUri(file, tone)` takes `"normal" | "waiting" | "dimmed"`; `createReviewFolderUri(path, dimmed)`.
- Icons: a `FileDecoration` colors labels only, so dimmed cluster and Reviewed-bucket headers also get a `ThemeIcon` with `DIM_COLOR`. Folder and file icons come from the file icon theme and cannot take a color; on those rows only the label (and badge) dims.
- `src/treeProvider.ts`:
  - Real cluster header: `clusterHeaderTone`; icon `watch`/`layers`, colored when dimmed; `resourceUri = createDimmedHeaderUri("cluster-<key>")` when dimmed, none otherwise. Tooltip: summary, plus `WAIT_TOOLTIP` when `wait: true`, else plus `SOME_WAITING_TOOLTIP` ("Some files are waiting on the agent: still expected to change.") when the hourglass comes from `waitPaths` only.
  - Cluster folder: dimmed by `everyFileWaiting` over the needs-review files it renders; tooltip gains `WAIT_TOOLTIP` when dimmed.
  - Reviewed-bucket folder: always dimmed, no wait tooltip line.
  - File row (grouped only): `"waiting"` when needs-review and `isWaitingFile`; `"dimmed"` when reviewed; else `"normal"`. `WAIT_TOOLTIP` tooltip line only for `"waiting"`.
  - Reviewed bucket header: `check` icon colored `DIM_COLOR`, `resourceUri = createDimmedHeaderUri("reviewed-bucket")`.
  - Ungrouped mode untouched (its Reviewed group does not dim); message rows untouched.
- `src/extension.ts` `deltaReview.__inspect` (test-only) gains `treeRows`: a full walk of `treeProvider` from the root through every child regardless of collapse state, one entry per row with `id`, `label`, `description`, `icon` (ThemeIcon id), `iconColor` (ThemeColor id), `query` (`resourceUri?.query`).

### Removed

- `createWaitingClusterHeaderUri`, `WAITING_FOLDER_DECORATION`, and the `wait` folder/header query, replaced in the rendering task by the `dim` query.

## Hard-to-undo

none (`waitPaths` is an additive optional contract key with no version bump; older extensions ignore it)

## Task index

| Task file | What it does | Files |
| --- | --- | --- |
| `01_01_wait_paths_contract.md` | Parse `waitPaths`, stamp `waitingPaths` on buckets, extend `isWaitingFile`, add `clusterHeaderTone` and `everyFileWaiting`; document the key in the skill contract and DEVELOPMENT.md | `src/clusters.ts`, `plugin/skills/cluster/SKILL.md`, `DEVELOPMENT.md` |
| `01_02_dim_rule_rendering.md` | Dim rows with nothing to review, `watch` icon on waiting clusters, dim Reviewed bucket; extend `__inspect`; update docs | `src/decorations.ts`, `src/treeProvider.ts`, `src/extension.ts`, `DEVELOPMENT.md`, `README.md` |
