# 01_01 waitPaths contract key

## Goal

Let agents flag individual files and directories as waiting through a new top-level `waitPaths` key in the Delta Review clusters contract, and add the pure predicates the dim-rule rendering (task 01_02) will use. No rendering change in this task beyond what the existing wait path already does with `isWaitingFile`.

## Files to modify/create

- `src/clusters.ts`
- `plugin/skills/cluster/SKILL.md`
- `DEVELOPMENT.md`

(Tests: `src/clusters.test.ts`.)

## Background

- The extension is a VS Code SCM-sidebar review panel. An agent writes a JSON "clusters contract" grouping the branch's changed files into clusters; the extension only reads it (`parseClustersContract`, src/clusters.ts:384-461) and resolves membership into buckets (`resolveClusterModel`, src/clusters.ts:~475-528).
- A cluster can already carry `wait: true` (agent still expects it to change): parsed in `parseCluster` (src/clusters.ts:~265-272), carried onto `ClusterBucket.wait` (src/clusters.ts:56-62, :500-505). `isWaitingFile` (src/clusters.ts:116-121) is true for members of a `wait` bucket; `src/treeProvider.ts:507-513` mutes needs-review file rows with it in grouped mode.
- Pattern for an optional top-level key: the `notes` block at src/clusters.ts:436-459 (validate, normalize, reject the whole file with a one-line error on a bad type).
- Design decisions (spec `## Design`, "Contract: `waitPaths`" and "Types"):
  - `waitPaths`: top-level optional array of strings, accepted in every version (1, 2, 3), no version bump.
  - Non-array or any non-string entry rejects the file with exactly `"waitPaths" must be an array of strings`.
  - Normalize: strip trailing `/` characters; drop entries empty after stripping.
  - Entry `e` covers path `p` when `p === e` or `p.startsWith(e + "/")`.
  - Only members of real clusters can be waiting; entries covering Unclustered/Auto files or nothing have no effect.
  - `ClustersContract.waitPaths: string[]` required (`[]` when absent).
  - `ClusterBucket.waitingPaths?: ReadonlySet<string>` set by `resolveClusterModel` only when non-empty: the bucket's member paths covered by `waitPaths`. `ClusterModel` shape unchanged.
  - `isWaitingFile(model, file)`: member of a real cluster with `wait: true`, or whose `waitingPaths` has `file.path`. Status-agnostic.
  - `clusterHeaderTone(bucket): { dimmed: boolean; hourglass: boolean }` where waiting(member) = `bucket.wait === true || bucket.waitingPaths?.has(member.path) === true`; `dimmed` = no needs-review member that is not waiting (true for an empty bucket); `hourglass` = `bucket.wait === true` or some needs-review member is in `waitingPaths`.
  - `everyFileWaiting(model, files)`: `files.length > 0 && files.every((f) => isWaitingFile(model, f))`.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/cluster/SKILL.md (doc): the clusters contract file — read before changing cluster generation or its file format

## Implementation details

1. `src/clusters.ts`:
   - Add `waitPaths: string[]` to `ClustersContract` with a comment (repo-relative file or directory paths, normalized).
   - Add `waitingPaths?: ReadonlySet<string>` to `ClusterBucket`.
   - In `parseClustersContract`, after the notes block, parse `record.waitPaths` (any version) with `isStringArray` (src/clusters.ts:193); normalize per Background. Return it in the contract.
   - Export a pure `isCoveredByWaitPath(waitPaths, path)` (or keep it module-private if only `resolveClusterModel` needs it; test through `resolveClusterModel` then).
   - In `resolveClusterModel`, after bucketing, set `waitingPaths` on each bucket whose members include covered paths (spread conditionally like `wait`, so a bucket without any stays key-free).
   - Rewrite `isWaitingFile` per Background; add `clusterHeaderTone` and `everyFileWaiting` next to `clusterBodyState` (src/clusters.ts:135). `FileReviewStatus` is already imported.
2. `plugin/skills/cluster/SKILL.md` (agent-facing; terse Contract + Default workflow structure, each rule stated once in the Contract, workflow steps reference Contract sections by name):
   - Schema example (src line ~46-75): add `"waitPaths": ["src/cache", "src/api.ts"]` at top level.
   - Field list (after the `wait` bullet, line 84): `waitPaths` — optional top-level array of repo-relative file or directory paths you still expect to change; a directory entry covers every file under it; any non-array or non-string entry rejects the file. See **Wait**.
   - Silently-dropped list (line 94-101): add "A `waitPaths` entry covering no clustered file in the review set (Unclustered and Auto files never show as waiting)."
   - Line 117 preserved-exceptions sentence: add `waitPaths` next to a cluster's `wait`.
   - `### Wait` (line 152): add rules: list a file or directory in `waitPaths` when only part of a cluster is still expected to change (use cluster `wait` when all of it is); remove an entry once settled. On a cold re-run keep an entry only while it still covers a file in the review set; a cold run adds none.
   - `### Conventions ...` (line 157): `waitPaths` entries are repo-relative and `/`-separated like `files`; an absolute or `\` path never matches.
   - Workflow step 3 (line 201): "and `wait` and `waitPaths` per **Wait**". Step 6's "Set or clear `wait`" bullet: include `waitPaths`. Step 7 (line 226): report the clusters and paths flagged wait.
3. `DEVELOPMENT.md`, "Clusters contract" section:
   - Line 115 schema: add `"waitPaths": ["<path>"]`.
   - After the `wait` bullet (line 117), add a `waitPaths` bullet: optional top-level array, any version, no version bump; normalization and coverage rule; non-array/non-string rejects the file with the exact error; only real-cluster members are affected; rendering muted like a `wait` cluster's files (task 01_02 rewrites the rendering wording).

## Gotchas

- `yarn build` runs `tsc` over `src/` including tests: the `contract()` and `contractV2()` fixtures in `src/clusters.test.ts:53-65` must gain `waitPaths: []`. Other `ClusterModel` fixtures (`src/clusterChanges.test.ts:38`, `src/treeParents.test.ts:40`) stay valid because `waitingPaths` is optional.
- Existing `toEqual` assertions on parsed contracts will now see `waitPaths: []`; update them.
- Do not version-gate `waitPaths`; cluster `wait` is ungated too.
- `"src"` must not cover `"src2/a.ts"`: use the `e + "/"` prefix test, never a bare `startsWith(e)`.
- No `REQ-*` ids anywhere. Comments explain why, not what.
- Do not touch `src/treeProvider.ts` or `src/decorations.ts` (task 01_02).

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`; all green.
- Write in `src/clusters.test.ts` (extend `describe("wait flag")` or add `describe("waitPaths")`):
  - parses `waitPaths` in versions 1, 2, 3; absent → `[]`.
  - strips trailing `/`, drops empty entries.
  - rejects a non-array and an array with a non-string, with the exact error.
  - `resolveClusterModel` sets `waitingPaths` from file and directory entries; `"src"` does not cover `"src2/x.ts"`; a bucket with no covered member has no `waitingPaths` key; covered Unclustered/Auto files are not stamped anywhere.
  - `isWaitingFile` true for a `waitingPaths` member, false for an Unclustered file covered by an entry.
  - `clusterHeaderTone`: empty → dimmed, no hourglass; all reviewed → dimmed, no hourglass; one needs-review non-waiting → not dimmed; needs-review all in `waitingPaths` → dimmed + hourglass; mix of waiting and non-waiting needs-review → not dimmed + hourglass; `wait: true` → dimmed + hourglass even with needs-review members; a reviewed member in `waitingPaths` alone → no hourglass.
  - `everyFileWaiting`: empty list → false; all waiting → true; one not waiting → false.
