# Review

## Tasks

- 01_01 (c292685) — New optional top-level `waitPaths` contract key (v1–3; trailing `/` stripped, empties dropped, bad type rejects the file). `resolveClusterModel` sets `ClusterBucket.waitingPaths` (exact or `dir/` prefix match); `isWaitingFile` rewritten; `clusterHeaderTone` and `everyFileWaiting` added. Docs: plugin/skills/cluster/SKILL.md, DEVELOPMENT.md. Verify: src/clusters.test.ts `waitPaths`, `clusterHeaderTone`, `everyFileWaiting` blocks.
- 01_02 (ad94d1d) — Dim rule rendering. One `DIM_COLOR` via `dim` decoration query; cluster header icon `watch` when anything inside waits, else `layers`, dimmed when nothing to review; cluster folders dim when every scoped file waits; Reviewed bucket header/folders/files always dim; file tone in grouped mode only; ungrouped unchanged. `__inspect` returns `treeRows`. Docs: DEVELOPMENT.md (Dim rule bullet, manual steps 27, 31e), README.md. Verify: dev host with a clusters file mixing pending, waiting (`waitPaths` + cluster `wait`), done and empty clusters.

## Open assumptions

- Done and waiting share one grey (intended under the dim rule).
- A cluster/directory whose only unreviewed files wait dims; any unreviewed non-waiting file keeps it bright.
- `x/z` count unchanged (reviewed / total).
- Reviewed files aren't listed in clusters; the Reviewed bucket and its header dim instead.
- Folder/file icons come from the icon theme and can't be colored; only labels (and badges) dim on those rows. Cluster icons dim.
- No hourglass codicon; `watch` used.
- Dimming applies in grouped mode only.
- Unclustered and Auto unchanged.

## Amendments

- None.
