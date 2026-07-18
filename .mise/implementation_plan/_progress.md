# Progress

## 01_01 — Pure status-filter and cluster body-state helpers in src/clusters.ts

- Key changes: `src/clusters.ts` — added exported `filterByStatus(files, status)` (order-preserving, reference-keeping filter) and `clusterBodyState(files)` returning the exported `ClusterBodyState` type (`"no-files" | "all-reviewed" | "has-needs-review"`); `src/clusters.test.ts` — new `describe` blocks for both helpers.
- Deviations from plan: named the filter helper `filterByStatus` (not `filesWithStatus`) per the task's own alternative, to avoid shadowing `ReviewTreeProvider`'s private `filesWithStatus`; Task 2.1 should use `filterByStatus`. Also exported the `ClusterBodyState` type alias alongside the function (matches the file's `ClusterContextValue` precedent).
