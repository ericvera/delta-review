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

## Open questions

1. Which signal(s) to explore (mock variants side by side vs. a single pick).
2. Done + wait-flagged cluster: which styling wins.
3. Reorder/collapse done clusters: in or out of scope.
