when looking at delta review clusters, it takes me a few seconds to differentiate between clusters that still have files that need review and those that are done. Then x/z at the end does it, but it requires a full scan rather than a glance. I would like to explore ideas to make this better.

## Investigation

- Cluster header row: `clusterTreeItem`, src/treeProvider.ts:595-652. Every real cluster uses the same `layers` icon (:630); `x/z` via `description` (:645) is the only state signal.
- Count text: `clusterCountDescription`, src/clusters.ts:174 (Auto shows plain total until first review, :181); tests src/clusters.test.ts:1259.
- Pure state predicates exist: `clusterBodyState` (src/clusters.ts:135), `clusterContextValue` (src/clusters.ts:157). New display logic goes in clusters.ts with Vitest tests.
- Row tint pattern: `delta-review-item` resourceUri + query + `FileDecoration` color via `createReviewDecorationProvider` (src/decorations.ts:118-136). Used by Unclustered (warning color + colored ThemeIcon; treeProvider.ts:616-622, decorations.ts:63-78) and wait clusters (`gitDecoration.ignoredResourceForeground`; decorations.ts:23,54-59,112; treeProvider.ts:631-636).
- Colored ThemeIcons per state already used in notes tree (src/notesTreeProvider.ts:50-65).
- Conflict: a done + wait-flagged cluster would need two tints; wait always sets resourceUri today.
- Clusters render in contract order (treeProvider.ts:182-190); no status sort. Fully reviewed clusters stay expanded with one "All files reviewed." row (:308-309). Only Auto collapses by default (:136-138); collapse state persisted with inverted keys (treeProvider.ts:132-135; extension.ts:236-248).
- Inline menus key on context values `^clusterNeedsReview`, `^(clusterReviewed|clusterNeedsReviewSnapshot)$` (package.json:358-383); don't rename.
- Docs pinning current behavior: DEVELOPMENT.md:131, :256 (manual step 27), README.md:68.
- `deltaReview.__inspect` (src/extension.ts:~2025-2045) returns nothing about cluster headers; e2e verification of header icon/color would need it extended.
- Nothing hard to undo; no contract/schema change.

## Decisions

- Rule (owner): dimmed = nothing to review right now (fully reviewed, waiting, or empty), at every level: clusters, directories, files. Not dimmed = ok to review. No status icons.
- In scope: agents can flag individual files and directories as "wait", not only clusters (contract change; spec and critic run).
- Reviewed file rows dim too (same rule at every level).
- Only agents set file/dir wait, via the clusters file (as cluster wait today). Reviewer-side toggle is out of scope.
- Hourglass (or closest codicon) replaces the cluster icon when anything inside is flagged wait, whether the cluster is bright or dimmed; no "waiting" text note. Dimmed without hourglass = fully reviewed.
- Hourglass on clusters only (2b); waiting files/directories only dim. Under a cluster, a dimmed file can only mean waiting, since reviewed files move to the Reviewed group.
- Out of scope: reordering or auto-collapsing done clusters; contract order and current expansion behavior stay.

## Assumptions

- Done and waiting share one grey; intended under the dim rule.
- A cluster or directory whose only unreviewed files are waiting counts as nothing-to-review and dims.
- A cluster with any unreviewed, non-waiting file stays undimmed; its waiting files dim inside it.
- The x/z count keeps its current meaning (reviewed / total).
- Reviewed files are not listed inside clusters today; "reviewed files dim" applies to the Reviewed bucket, whose header dims too.
- Dimming covers the cluster icon and labels; folder/file icons come from the file icon theme and cannot take a color, so on those rows only the label (and badge) dims.
- No hourglass codicon may exist; `watch` is the candidate fallback.
- Unclustered and Auto rows unchanged.

## Proposal

- Issue: a cluster's review state shows only in the trailing `x/z`, so telling actionable from done/waiting takes a scan.
- Approach: dim every row with nothing to review now (reviewed, waiting, empty) at cluster/directory/file level; hourglass marks clusters containing waiting items (files/dirs only dim); agents can flag files and directories as wait via the clusters file.
- Skips nothing: the clusters contract changes, so spec and critic run.
