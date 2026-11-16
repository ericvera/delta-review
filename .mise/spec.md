# Spec: combined diff refresh and "wait" clusters

## What

- The combined "Cluster Changes: <label>" multi-diff tab stays current. Whenever the cluster's needs-review file set or any shown file's diff base changes (review marks of every kind, auto-review, file edits that move a file into or out of needs-review, agent edits to the clusters file), the tab is rebuilt with the current files.
  - Only the tab that is the active tab of the active editor group rebuilds immediately. A background tab is left alone and rebuilds when it becomes active.
  - When the last needs-review file leaves, the tab stays open and shows an empty state. Files that become needs-review again bring it back to life on the next rebuild.
  - A cluster renamed, reordered, or removed while its tab is open, or a repo/branch switch, gets no rebuild. Today's `changedClusterMessage` from the title-bar button is unchanged.
- Agents can flag a cluster `"wait": true` in the clusters contract: "still expected to change". No flag means ready to review. The flag is optional and informational. It gates nothing and changes no sorting.
  - No contract `version` bump. Older extensions ignore the key. The cluster skill's schema-change rule is amended to exempt optional keys an older extension can safely ignore.
  - In grouped mode, a waiting cluster's header row, its folder rows, and its file rows render muted, in the git-ignored color. Unclustered, Auto, and the Reviewed bucket are never muted. Hover actions stay enabled.
  - Tooltips gain the line `Waiting on the agent: still expected to change.`
  - The cluster skill tells agents to set `wait` on clusters they still expect to change and to clear it when the cluster settles or plans change.

## Design

### Wait flag (task 01_01)

- `src/clusters.ts`
  - `ClusterDefinition` and `ClusterBucket` gain `wait?: true`, present only when the contract says `true`.
  - `parseCluster` accepts `wait`. `true` sets the flag, `false` or absent leaves it unset, any other value is an error: `cluster N ("label"): "wait" must be a boolean`. This is consistent with the other per-cluster field checks.
  - `resolveClusterModel` copies `wait` onto the bucket.
  - New pure helpers:
    - `isWaitingClusterKey(model, clusterKey): boolean` is true only for a real `c<n>` key whose bucket has `wait`.
    - `isWaitingFile(model, file): boolean` is true when the file's path is in a waiting bucket's `files`. Auto files are never in buckets.
  - `version` stays 3, and the parser still accepts 1-3. `wait` is read for every version, because older extensions ignore it anyway.
- `src/decorations.ts`
  - Adds a `wait` marker to the row URI query. File rows use `<changeKind>` or `<changeKind>,wait`. Folder rows use no query, or `wait`. A new cluster-header URI is `/cluster-header/<clusterKey>?wait`.
  - The provider returns the same badge letter for `<kind>,wait`, recolored to `gitDecoration.ignoredResourceForeground`, with the tooltip `Waiting on the agent: still expected to change.`. For `wait` alone it returns no badge and that same color.
  - The existing `unclustered-header` query is unchanged.
- `src/treeProvider.ts`
  - `clusterTreeItem` handles a waiting real cluster. It sets `resourceUri` to the waiting cluster-header URI. The label still wins for display and the decoration tints it, following the Unclustered header precedent at treeProvider.ts:600-602. It appends `\n\nWaiting on the agent: still expected to change.` to the summary tooltip.
  - Folder rows with a `clusterKey` whose cluster is waiting get the `wait` query and the same tooltip line.
  - A file row is muted when `isGrouped()` is true, the file is NeedsReview, and `isWaitingFile` holds. Element shapes do not change, so `treeParents.ts` and reveal are untouched. The file tooltip notes gain the waiting line.
- Docs:
  - `plugin/skills/cluster/SKILL.md`: add `wait` to the schema, field list, and amended Schema-changes rule, plus a workflow step.
  - `DEVELOPMENT.md`: update the Clusters contract schema bullets and add a manual test step.

### Diff refresh (task 01_02)

- `src/clusterChanges.ts` (pure)
  - `clusterChangesSignature(files: readonly ReviewFile[]): string[]` returns one string per file from `path`, `diffBasePath`, `diffBaseSha ?? "empty"`, and `deleted`, in order.
  - `clusterChangesRebuild(entry, current, clusterFiles)` returns `{ kind: "changed-cluster" }` when the source or title or label differ (same test as `clusterChangesMarkPaths`). It returns `{ kind: "unchanged" }` when the signature of `clusterChangesFiles(clusterFiles)` equals `entry.signature`. Otherwise it returns `{ kind: "rebuild", files }`, and `files` may be empty.
  - `nothingToReviewMessage` is unchanged. It is still used by Open Cluster Changes on an empty cluster and by the title-bar button on an empty tab.
- `src/extension.ts`
  - `ClusterChangesEntry` gains `signature: string[]`.
  - The body of `deltaReview.openClusterChanges` that builds resources, records the entry, and calls `vscode.changes` is extracted into `showClusterChanges(title, clusterKey, label, files, { replacing })`.
  - Rebuild order is open first, then close. Snapshot the `clusterChangesTabsFor(title)` Tab objects first. Record the new entry, then call `vscode.changes` (zero resources allowed). Then close the snapshotted old tabs that are still open.
    - The new tab opens beside the active old one, so closing the old one leaves it in the old position.
    - The title's tabs never drop to zero, so the `onDidChangeTabs` closed handler keeps the entry.
    - If no new tab appeared (for example, `vscode.changes` refuses an empty list), the old tab is not closed. The entry is restored to its prior value, and an information message shows `Nothing to review in '<label>'. Files reappear here if they change.`
  - `syncActiveClusterChanges()` runs on its own `createSerialQueue()` (src/serialQueue.ts). It is triggered:
    - at the end of every successful `refresh()`, after `treeProvider.setModel(model)`
    - from `onDidChangeTabs` and `onDidChangeTabGroups`, skipping events fired while a rebuild is in flight
  - Each sync bails unless all of these hold:
    - `git`, `model`, and `clusterModel` are defined
    - `activeClusterChanges()` returns one entry
    - exactly one tab carries that title
  - It then calls `clusterChangesRebuild`, using `clusterChangesTitle`, `clusterLabelForKey`, and `clusterFilesForKey` for the current side. Only `rebuild` acts.
  - Background tabs are never touched. Each is checked when it next becomes active.
  - `markClusterChangesReviewed` is unchanged. On an empty tab, `entry.paths` is empty, so it reports `nothingToReviewMessage`.
- Nothing is removed. `leftSides` stays because selection sync reads it.
- `DEVELOPMENT.md` manual steps 31c and 31d (lines 261-262) are rewritten. Step 31e covers background tabs and the empty state.
- Releases: `package.json` goes to 0.13.0 and `plugin/.claude-plugin/plugin.json` goes to 0.8.0, in task 01_02 so the bump lands with the last task.

## Hard-to-undo

- Clusters contract schema (a public file format read by the extension and written by the plugin skill): new optional per-cluster key `wait` without a `version` bump. SKILL.md's "every schema change bumps `version`" rule is amended to exempt optional keys an older extension can safely ignore. Once agents write `wait`, removing or renaming it means a version bump.

## Task index

| Task file | What it does | Files |
|---|---|---|
| 01_01_wait-flag.md | Parse optional `wait` cluster key, render waiting clusters muted, document it in the skill and DEVELOPMENT.md | src/clusters.ts, src/decorations.ts, src/treeProvider.ts, plugin/skills/cluster/SKILL.md, DEVELOPMENT.md |
| 01_02_diff-refresh.md | Rebuild the active combined diff tab when its files or bases change, keep it open when empty, bump versions | src/clusterChanges.ts, src/extension.ts, DEVELOPMENT.md, package.json, plugin/.claude-plugin/plugin.json |
