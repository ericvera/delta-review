# Development

## Build & run

```bash
yarn install
yarn build     # or: yarn watch
```

The build is an esbuild bundle: `yarn build` typechecks with `tsc` (`noEmit`) and then bundles `src/extension.ts` into a single `out/extension.js` (CommonJS, node platform, sourcemap; runtime deps like `picomatch` are inlined, only `vscode` stays external — see `esbuild.mjs`). `yarn watch` runs the bundler only, without typechecking.

Open this folder in VS Code and press **F5** ("Run Extension"). An Extension Development Host window opens with the extension loaded — open any git repo with a feature branch in it and start reviewing.

## Packaging

```bash
yarn package       # produces delta-review.vsix (e.g. to share it)
yarn install-ext   # package + install into VS Code in one step
```

Run `yarn install-ext` again after any change to update; reload open windows (**Developer: Reload Window**) to pick up the new version.

## How it works

Review state is **content, not a flag**. Marking a file reviewed snapshots its current working-tree content as a git blob, anchored under a shadow ref (`refs/review/<branch>`). A file's status is always derived by comparison:

- working tree content == reviewed snapshot → **Reviewed**
- snapshot exists but differs → **Needs Review**, and the diff opens against the snapshot (the delta since last review)
- no snapshot → **Needs Review**, diff opens against the merge base with the base branch

Because the state is content-based, it survives rebases, amends, and commits — nothing "resets" unless the file content actually changes.

### Where the state lives

Inside the repo's `.git` object database, under `refs/review/<branch>`:

- Never appears in the working tree, `git status`, branches, or PRs.
- Never pushed unless you explicitly `git push origin 'refs/review/*'`.
- Each save is a commit on the ref, so you get a browsable history of review sessions.

Inspect it:

```bash
git ls-tree -r refs/review/<branch>     # what's marked reviewed (path -> snapshot blob)
git log refs/review/<branch>            # review session history
git update-ref -d refs/review/<branch>  # nuke state for a branch (or use the command)
```

### Repository selection

Delta Review follows the repository selected in the Source Control view — the same selection that drives the built-in CHANGES panel. Switching to another repository or git worktree retargets the review set to that checkout (the panel header shows which one is active). If the built-in git extension is disabled, it falls back to the first workspace folder's repo. Review state is per-branch and lives in the shared `.git`, so it travels with a branch across worktrees.

### File status letters

Files carry `M`/`A`/`D` letters and colors like the CHANGES view — computed relative to `merge-base(baseBranch, HEAD)`, not HEAD, so committed changes still show. Untracked files are included. Renames are not detected (`--no-renames`).

### Auto triage

Every file in the review set is classified `auto` or `normal` (`src/triage.ts`, called from `computeReviewModel` in `src/model.ts`) from exactly two inputs:

- `deltaReview.autoReview.globs` — picomatch patterns (`dot: true`, case-sensitive, repo-relative `/` paths). Empty, non-string, or uncompilable entries are skipped, never fatal.
- Paths marked `linguist-generated` in `.gitattributes`, fetched via `git check-attr --stdin -z linguist-generated` (best-effort: any failure means "none").

`auto` files render in the collapsed **Auto** subgroup (flat in both layouts, directory shown in the description) and are excluded from the normal list/tree and from folder bulk actions; group counts and Mark All still include them. With `autoReview.markAutomatically` on, `refresh()` marks needs-review auto files through the normal `markReviewed` snapshot path before the tree updates — so a later edit resurfaces as a delta, exactly like a hand-marked file.

### Clusters contract

Clustered review is driven by a JSON contract the extension only ever **reads** — an external tool (the `cluster-review` Claude Code skill in `plugin/`) writes it:

- Path: `<git common dir>/delta-review/clusters-<sanitized branch>.json`. The common dir (`git rev-parse --git-common-dir`, resolved against the repo root when relative) keeps the contract next to the review refs, shared across linked worktrees.
- Sanitization: every branch-name char outside `[A-Za-z0-9._-]` becomes `-` (`sanitizeBranchForFilename` in `src/clusters.ts`; the skill applies the identical rule).
- Schema (version must be the integer `1`): `{ "version": 1, "clusters": [{ "label", "summary", "files": [...], "patterns": [...] }] }` — each cluster needs at least one non-empty array of `files` (explicit repo-relative paths) or `patterns` (picomatch globs). Unknown keys are ignored. `parseClustersContract` returns one-line user-facing errors.

#### ClusterModel flow

- Every `refresh()` reloads the contract for the current branch (`loadClustersContract`): `missing` → no cluster state, no message; `invalid` → no cluster state plus a `⚠ Clusters contract: <error>` view message; `ok` → `resolveClusterModel(contract, files)`.
- `resolveClusterModel` buckets the review set: auto-triaged files always go to `auto` (auto wins over everything); explicit `files` listings beat `patterns`, first listing cluster wins; otherwise the first cluster (contract order) whose pattern matches wins; the rest are `unclustered`. Files named by the contract but absent from the review set are simply not shown.
- The grouping lever (`deltaReview.groupByCluster` / `ungroupClusters`, workspaceState key `deltaReview.grouped`) only shows while a valid contract exists (`deltaReview.clustersAvailable` context key). Effective grouping is `preference && clusterModel !== undefined`, so a vanished/invalid contract falls back to ungrouped without erasing the preference.
- A dedicated watcher on `<common dir>/delta-review/*.json` schedules a refresh on contract create/change/delete; the per-refresh re-read keeps things correct even if watcher events are missed.
- Grouping is pure presentation: tree rows resolve their files from the current `ClusterModel` at render time, and no lever flip touches `refs/review/<branch>`.

## Manual test script

Basics (no contract, default settings):

1. In the dev host, open a repo with changes vs `main`. The panel lists them under Needs Review.
2. Click a file → diff is _merge base ↔ working tree_.
3. Click its `+` → it moves to Reviewed; status bar count updates.
4. Edit the file → it moves back to Needs Review, and its diff is now _last reviewed ↔ working tree_ (only the new edit).
5. Revert the edit (undo + save) → content matches the snapshot again, file returns to Reviewed on its own.
6. Commit / rebase — review state is unaffected (content-based).
7. Tree/list toggle, folder `+`/`−`, collapse state surviving reload, and repo switching in Source Control all behave as before.

Auto-review:

8. Set `deltaReview.autoReview.globs` (e.g. `["**/*.lock"]`) → matching files move into a collapsed **Auto** subgroup (⚙, count, flat with directory descriptions) first under Needs Review, in both layouts. No reload needed.
9. A file marked `linguist-generated` in `.gitattributes` lands in Auto even with empty globs.
10. Auto header `+` marks them all; they stay inspectable under Reviewed → Auto. Folder `+` does not touch auto files; Mark All still covers everything.
11. Flip `markAutomatically` on → next refresh self-marks auto files; edit one → it resurfaces under Needs Review → Auto with a delta diff.

Clusters:

12. No contract → no grouping button. Create a valid contract for the branch (run the `cluster-review` skill, or hand-write one at `.git/delta-review/clusters-<branch>.json`) → the group-by-cluster button appears without a manual refresh.
13. Group → clusters render in contract order with `n/m` counts and summary tooltips; reviewed files stay in place, dimmed with a `✓`; **Unclustered** (warning-styled) after the clusters, only when non-empty; **Auto** last, collapsed; a cluster with no files in the change shows a message row.
14. Tree/list toggle still works inside clusters (per-cluster folder collapse, folder actions scoped to the cluster); cluster header `+`/`−` bulk-marks exactly that bucket.
15. Both levers persist across reload. Flipping either lever changes no review state (`git ls-tree -r refs/review/<branch>` identical before/after).
16. Break the contract (e.g. `"version": 3`) → ⚠ message, view falls back to ungrouped, grouping preference survives a later fix. Delete the contract → button and message disappear.
17. Throughout: `git status` in the test repo stays clean — the contract lives under `.git`.
