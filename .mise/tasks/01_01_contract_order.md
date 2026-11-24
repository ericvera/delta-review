# 01_01 Contract order inside clusters

## Goal

In list mode, a cluster's file rows follow the order of that cluster's `files` array in the clusters contract (the agent's reading order), not path order. Tree (folder) mode keeps folders-first alphabetical.

## Files to modify/create

- `src/clusters.ts`
- `src/treeParents.ts`
- `src/treeProvider.ts`
- `plugin/skills/cluster/SKILL.md`
- `DEVELOPMENT.md`

## Background

- The extension is a VS Code SCM-sidebar review tool. The clusters contract (`<git common dir>/delta-review/clusters-<branch>.json`) groups changed files into clusters; `resolveClusterModel` (`src/clusters.ts:520-585`) buckets the review set. It iterates `files` (the model's path-sorted list) and pushes, so every bucket is path-sorted today (comment at `src/clusters.ts:512-519`; `filterByStatus` comment at `src/clusters.ts:137-139` also says path-sorted).
- List mode renders a cluster's needs-review files in bucket order (`src/treeProvider.ts:311-317`). Tree mode builds folders via `ReviewTreeProvider.treeChildren` (`src/treeProvider.ts:345-383`): folder names are sorted, but direct files keep input order — so once buckets stop being path-sorted, tree mode would show contract order unless direct files are sorted too.
- Design decision: contract order applies in list mode only; tree mode stays folders-first alphabetical. Unclustered, Auto, the Reviewed bucket and ungrouped mode stay path-sorted.
- Order inside a real cluster: members listed explicitly in the cluster's `files` come first, ordered by their index in that array; members claimed only by `patterns` follow in input (path) order.
- The combined cluster diff (`src/clusterChanges.ts`) lists files in bucket order, so it follows reading order too — intended.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/cluster/SKILL.md (doc): the clusters contract file — read before changing cluster generation or its file format

## Implementation details

1. `src/clusters.ts` `resolveClusterModel`: record each explicit path's position (`Map<string, { cluster: number; position: number }>`, first listing wins as today). After bucketing, stably reorder each real bucket: explicit members by `position`, then pattern members in their existing order. Update the function comment and the `filterByStatus` comment (it preserves the caller's order; it no longer guarantees path order).
2. `src/treeParents.ts`: add a pure exported `treeLevel(files: readonly ReviewFile[], parentPath: string): { folderNames: string[]; directFiles: ReviewFile[] }` — the split `treeChildren` does today, with folder names sorted and direct files sorted by `path` (plain `<` comparison, matching `model.ts`'s `.sort()`).
3. `src/treeProvider.ts` `treeChildren`: use `treeLevel` and map its result to elements; behavior otherwise unchanged.
4. `plugin/skills/cluster/SKILL.md`: in the Contract, state that a cluster's `files` order is the reading order the sidebar's list mode shows (tree mode stays alphabetical); in the workflow's clustering step, list `files` in the order a reviewer should read them. State each rule once, in the Contract; the workflow step references it.
5. `DEVELOPMENT.md` "ClusterModel flow": replace path-order wording with the ordering rule above; add a manual step under "Clusters" (list mode follows `files` order; tree mode alphabetical).

## Gotchas

- Keep `ReviewFile` objects by reference; callers compare identity.
- A path listed in two clusters' `files` belongs to the first; its position comes from that first cluster's array.
- Do not reorder `unclustered` or `auto`.
- `src/treeParents.ts` must stay free of runtime `vscode` imports (type-only imports from `./treeProvider` only).

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Write in `src/clusters.test.ts`: explicit members follow `files` order regardless of path order; pattern-only members follow explicit ones in path order; Unclustered/Auto stay path-sorted; first-listing cluster's position wins.
- Write in `src/treeParents.test.ts`: `treeLevel` returns sorted folders and path-sorted direct files for unsorted input, and filters by `parentPath`.
