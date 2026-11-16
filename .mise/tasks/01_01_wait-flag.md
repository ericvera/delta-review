# 01_01 Wait flag on clusters

## Goal

Let the agent that writes the clusters contract flag a cluster `"wait": true`, meaning "still expected to change". The Delta Review sidebar renders that cluster's header, folder, and file rows muted, in the git-ignored color, with a tooltip line explaining why. The flag is optional, informational, and needs no contract version bump. The cluster skill and DEVELOPMENT.md document it.

## Files to modify/create

- src/clusters.ts
- src/decorations.ts
- src/treeProvider.ts
- plugin/skills/cluster/SKILL.md
- DEVELOPMENT.md
- Tests: src/clusters.test.ts

## Background

- Delta Review is a VS Code SCM-sidebar extension. An external agent skill writes a JSON "clusters contract" (`<git common dir>/delta-review/clusters-<branch>.json`), and the extension only reads it. A watcher on that directory already triggers a refresh (src/extension.ts:668-694), so a flag added or removed by the agent shows up with no new plumbing.
- Parsing:
  - `parseCluster` is at src/clusters.ts:222-254.
  - The types are `ClusterDefinition` (15-22) and `ClusterBucket` (54-58).
  - `resolveClusterModel` (446-500) builds buckets from contract clusters.
  - Unknown keys are ignored (clusters.ts:351), so older extensions will ignore `wait`.
- Rendering:
  - `clusterTreeItem` is at src/treeProvider.ts:575-620. Real clusters get the `layers` icon and `tooltip = bucket?.summary`.
  - The folder branch of `getTreeItem` starts at treeProvider.ts:463 (`if (element.kind === "folder")`). It uses `createReviewFolderUri(path)`, and `element.clusterKey` is set when the folder sits under a cluster. It has no local `clusterModel`; call `this.getClusterModel()` (constructor callback, treeProvider.ts:156).
  - File rows follow at treeProvider.ts:493-573. They also have no local `clusterModel`; call `this.getClusterModel()`. They use `createReviewItemUri(file)` and a MarkdownString tooltip with a `notes` list.
  - Pattern to follow: the Unclustered header sets both a label and a `resourceUri` so a FileDecoration color tints the label (treeProvider.ts:600-602, decorations.ts:33-51).
- Decorations: src/decorations.ts. The provider maps `uri.query` to a decoration (decorations.ts:79-90). File-row query is the change kind (`modified|added|deleted|renamed`). Folder rows have no query.
- Design decisions:
  - Key name `wait`, boolean.
  - It applies only to agent-defined clusters (`c<n>` keys), never to the synthetic Unclustered/Auto buckets or the Reviewed bucket.
  - No sorting change. Nothing is disabled, and hover actions and context values are unchanged.
  - No contract `version` bump: stays 3, and the parser still accepts 1-3. `wait` is read in every accepted version.
  - SKILL.md's "Schema changes" rule (SKILL.md:164-166) is amended to exempt optional keys an older extension can safely ignore.
  - Muting covers the cluster row plus every folder and file row under it. Muting applies only in grouped mode. In ungrouped mode there are no cluster rows and nothing is muted.
  - Tooltip text: `Waiting on the agent: still expected to change.`
  - The agent alone owns the flag. The extension does no "changed since flagged" tracking.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/cluster/SKILL.md (doc): the clusters contract file — read before changing cluster generation or its file format

## Implementation details

1. src/clusters.ts:
   - Add `wait?: true` to `ClusterDefinition` and `ClusterBucket`, with a one-line comment: "agent says this cluster is still expected to change; informational".
   - In `parseCluster`:
     - If `entry.wait` is neither `undefined` nor a boolean, return `` { error: `${where2}: "wait" must be a boolean` } ``.
     - Include `...(entry.wait === true ? { wait: true } : {})` in the returned definition.
   - In `resolveClusterModel`, copy `wait` onto each bucket the same conditional way, so buckets without the flag keep their exact current shape.
   - Export the helpers:
     - `isWaitingClusterKey(model: ClusterModel, clusterKey: string): boolean` is `clusterBucketForKey(model, clusterKey)?.wait === true`.
     - `isWaitingFile(model: ClusterModel, file: ReviewFile): boolean` is true when some bucket with `wait` has a file whose `path` equals `file.path`.
2. src/decorations.ts:
   - Add a `WAIT_TOOLTIP = "Waiting on the agent: still expected to change."` export (treeProvider reuses it). Add a muted color, `new vscode.ThemeColor("gitDecoration.ignoredResourceForeground")`.
   - Change `createReviewItemUri(file, waiting = false)` so the query is `changeKind` or `` `${changeKind},wait` ``.
   - Change `createReviewFolderUri(path, waiting = false)` so the query is `"wait"` when waiting, or empty as today.
   - Add `createWaitingClusterHeaderUri(clusterKey)` returning path `` `/cluster-header/${clusterKey}` `` and query `"wait"`.
   - Provider:
     - `unclustered-header` is unchanged.
     - A query ending `,wait` returns a FileDecoration with the base kind's badge letter, the tooltip `WAIT_TOOLTIP`, and the muted color.
     - A query of exactly `wait` returns a FileDecoration with no badge, the tooltip `WAIT_TOOLTIP`, and the muted color.
     - Otherwise, the existing table. Build the muted decorations once, as module constants, like `DECORATIONS`.
3. src/treeProvider.ts:
   - `clusterTreeItem`, real-cluster branch: when `isWaitingClusterKey(clusterModel, key)`, set `item.resourceUri = createWaitingClusterHeaderUri(key)`. Set the tooltip to `` `${bucket.summary}\n\n${WAIT_TOOLTIP}` `` (just `WAIT_TOOLTIP` when the summary is empty).
   - Folder branch: with `const clusterModel = this.getClusterModel()`, `waiting = element.clusterKey !== undefined && clusterModel !== undefined && isWaitingClusterKey(clusterModel, element.clusterKey)`. Pass it to `createReviewFolderUri`, and when true, set the tooltip to `` `${element.path}\n\n${WAIT_TOOLTIP}` ``.
   - File branch: with `const clusterModel = this.getClusterModel()`, `waiting = this.isGrouped() && file.status === FileReviewStatus.NeedsReview && clusterModel !== undefined && isWaitingFile(clusterModel, file)`. Pass it to `createReviewItemUri`, and when true, push `WAIT_TOOLTIP` as the last entry of `notes`.
   - Check how the provider reads `isGrouped`/`getClusterModel` (constructor callbacks) and reuse them.
4. plugin/skills/cluster/SKILL.md. Follow CLAUDE.md: a binding Contract plus a Default workflow that references it, terse, each rule stated once.
   - Schema example: add `"wait": true` to one cluster.
   - Field list (around line 80-90): `wait`: optional boolean on a cluster. `true` means you still expect this cluster to change, and the reviewer sees it muted. Omit it or write `false` when the cluster is settled. Any non-boolean value rejects the file.
   - Add a Contract subsection `### Wait`. Set `wait: true` on a cluster you still expect to change; clear it once the cluster is settled or plans change. On a cold re-run, preserve existing `wait` values only for clusters whose label survives; a cold run sets no new `wait`. Keep it short.
   - Amend the rule at SKILL.md:115 ("Everything in `clusters` must be derivable from the current diff on every run; `moves` and `notes` are the preserved exceptions, because ..."). Name `wait` as a preserved exception there too, because the agent's intent is not recoverable from the diff. That sentence stays the single statement of what is preserved; `### Wait` only says how `wait` is carried and does not restate the exception.
   - Amend `### Schema changes` (line 164-166). Any change requires bumping `version` and updating `src/clusters.ts` in the same commit, except a new optional key an older extension can safely ignore (like `wait`), which keeps the version.
   - Default workflow: step 3 (existing-contract baseline) references carrying `wait` per **Wait**. Step 6 or 7 sets or clears `wait` per **Wait**, and step 7's report lists clusters flagged `wait`.
5. DEVELOPMENT.md:
   - In "Clusters contract" (around lines 113-121), add `"wait"` to the schema bullet. Add a bullet: `wait` (optional boolean, any version, no version bump since older extensions ignore it). `true` renders the cluster's header, folder, and file rows in grouped mode in the git-ignored color, with the tooltip line `Waiting on the agent: still expected to change.`. Non-boolean values reject the file. It gates no action and changes no order.
   - Add a manual test step after 31 (as `31e`, or the next free sub-number if 01_02 already added one): add `"wait": true` to one cluster, and with no manual refresh its rows go muted, with the tooltip line on cluster, folder (tree mode), and file rows. Unclustered, Auto, and Reviewed are never muted, and hover actions still work. Remove the key and the rows render normally. `"wait": "yes"` gives `⚠ Clusters contract: cluster N ("<label>"): "wait" must be a boolean`.

## Gotchas

- Existing tests build `ClusterBucket`/`ClusterDefinition` literals without `wait`. Keep the field optional and conditional (`...(x ? { wait: true } : {})`) so `toEqual` assertions on existing contracts still pass. tsc includes `src/**/*.test.ts` (tsconfig `include: ["src"]`).
- FileDecoration caching is keyed by URI. Because `wait` lives in the query, a flag flip yields a different URI and the color updates without firing `onDidChangeFileDecorations`.
- Do not change element shapes (`FileElement`, `FolderElement`). `src/treeParents.ts` rebuilds elements for `reveal` and must keep matching rows.
- In ungrouped mode, `isGrouped()` is false, so no file row is muted even if its cluster waits.
- Keep `contextValue` unchanged on every muted row. Menus in package.json key off it.
- Prettier runs over markdown. Do not touch `.mise/` or `.claude/`.

## Verification

- Tests to run: `yarn test`, `yarn lint`, `yarn build`.
- Tests this task writes in src/clusters.test.ts:
  - `parseClustersContract` keeps `wait: true` on a cluster.
  - It omits `wait` for `false` and for absent.
  - It rejects `"wait": "yes"` with the exact message.
  - `wait` is accepted in a version 1 contract.
  - `resolveClusterModel` carries `wait` onto the bucket.
  - `isWaitingClusterKey` is true for a flagged `c<n>`, and false for unflagged, `unclustered`, `auto`, and out-of-range keys.
  - `isWaitingFile` is true for a file in a flagged bucket, and false for one in an unflagged bucket, in unclustered, or in auto.
- Substitute check for the tree rendering (UI, no unit test possible; config Test exceptions): verify the muted color, tooltips, and unchanged hover actions manually in the dev host per the new DEVELOPMENT.md step. If no dev host is available, state that in the handback.
