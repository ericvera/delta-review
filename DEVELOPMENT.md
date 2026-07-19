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

Files carry `M`/`A`/`D`/`R` letters and colors like the CHANGES view — computed relative to `merge-base(baseBranch, HEAD)`, not HEAD, so committed changes still show. Untracked files are included. Renames are detected (`--find-renames`, git's default similarity threshold): a moved file shows as a single `R` row at the new path with a `← <old path>` description, and its merge-base diff opens against the old path's blob. Rename detection only sees what git sees — a file moved with plain `mv` (unstaged) still shows as a `D` row plus an untracked `A` row until the move is staged.

### Auto triage

Every file in the review set is classified `auto` or `normal` (`src/triage.ts`, called from `computeReviewModel` in `src/model.ts`) from exactly two inputs:

- `deltaReview.autoReview.globs` — picomatch patterns (`dot: true`, case-sensitive, repo-relative `/` paths). Empty, non-string, or uncompilable entries are skipped, never fatal.
- Paths marked `linguist-generated` in `.gitattributes`, fetched via `git check-attr --stdin -z linguist-generated` (best-effort: any failure means "none").

`auto` files render in the collapsed **Auto** subgroup (flat in both layouts, directory shown in the description) and are excluded from the normal list/tree and from folder bulk actions; group counts and Mark All still include them. With `autoReview.markAutomatically` on, `refresh()` marks needs-review auto files through the normal `markReviewed` snapshot path before the tree updates — so while the setting is on, an edited auto file is simply re-marked with a fresh snapshot on the next refresh and never resurfaces. Turn the setting off and the next edit resurfaces as a delta against the last snapshot, exactly like a hand-marked file.

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
- Grouped rendering: clusters, **Unclustered**, and **Auto** show only their needs-review files; the Unclustered/Auto headers hide entirely while nothing in them needs review. An always-present **Reviewed** bucket renders last: check icon, plain count of all reviewed files, follows the list/tree toggle, no subgrouping; its contextValue reuses `reviewedGroup`, so the header `−` is Unmark All.
- A fully reviewed cluster keeps its header (`n/n`) with a single `All files reviewed.` row; cluster counts and header `+`/`−` still derive from the cluster's full membership.
- Reviewed-bucket folder `−` (tree mode) unmarks every visible child — auto files included, since they render inline in the bucket rather than in an Auto subgroup. With `markAutomatically` on, an unmarked auto file returns to Reviewed on the next refresh (standard auto-review behavior, for every unmark path).
- Grouping is pure presentation: tree rows resolve their files from the current `ClusterModel` at render time, and no lever flip touches `refs/review/<branch>`. Mark/unmark writes through the normal snapshot path, and that ref write is what moves a row between a cluster and the Reviewed bucket.

### Review notes

Inline notes on diff lines, threaded with an agent's replies. Two contract files per branch under `<git common dir>/delta-review/` (same dir and branch sanitization as clusters):

- `notes-<sanitized branch>.json` — **extension-owned**; created/edited from the diff editor. Agents only read it; the extension never rewrites an invalid one (corrupt → deduped warning, notes unrendered, mutations refused).
- `responses-<sanitized branch>.json` — **agent-owned**; the `review-notes` skill in `plugin/` appends `{ noteId, status: "addressed", response, at, anchor? }` entries. The extension only reads it (corrupt → deduped warning, treated as missing).

Types and whole-file parsers live in `src/notes.ts` (clusters semantics: one violating entry rejects the file with a one-line error); persistence and mutation in `src/notesStore.ts` (atomic same-dir temp+rename saves, an idempotence guard so identical saves never touch the file — no watcher loops — and load→modify→save helpers).

#### The ref: `refs/review-notes/<branch>`

Each note snapshots the whole noted document as a git blob (`contentBlob`, via `hash-object -w`). All live blobs are anchored by a commit on `refs/review-notes/<branch>` (tree path = note id → blob), so `git gc` cannot prune them. It is deliberately separate from `refs/review/<branch>`: Clear Review State must not destroy note snapshots. The ref is deleted when the last note goes. Inspect with `git ls-tree refs/review-notes/<branch>`.

#### Anchoring model & derived-field refresh

A note pins `file`, `side` (`working` = right/current code, `base` = left/old code), a 1-based line range, the range's text (`snapshot`), and `contentBlob`. Every `refresh()` runs `refreshDerived` (`src/notesStore.ts`) to recompute the persisted hints (`status`, `outdated`, `currentStartLine/EndLine`):

- Diff `contentBlob` against the side's current content (`git diff -U0 <blob> <blob>`, hunks mapped by `src/noteAnchor.ts`): hunks above shift the range; a hunk touching it sets `outdated: true` and collapses it to one line; a missing document sets `outdated` and keeps the last position. Base-side notes compare against the file's current diff base, so they progress when the file is marked reviewed.
- Threads are merged in `src/noteThreads.ts`: reviewer `turns` + agent responses interleaved by `at`; status derived — explicit `resolved` wins, else last speaker (agent → **addressed**, reviewer → **open**). Derived fields are persisted back so agents reading the file get near-current hints.
- Response anchors: the newest agent anchor that resolves (`buildAnchorResolver` — repo-relative `/`-separated path only, file exists, line in range; traversal/absolute paths are always dangling) relocates the note to the fix — side flips to `working`, file/lines/snapshot/`contentBlob` are rewritten and re-anchored on the ref. One-shot per response via `appliedAnchorAt`.
- The clusters watcher on `<common dir>/delta-review/*.json` also covers both notes files, so agent replies merge live without a manual refresh.

Rendering is the standard VS Code comments API (`src/commentController.ts`) — threads appear in the built-in Comments panel for free, nothing is built against it. The REVIEW NOTES section (`src/notesTreeProvider.ts`) is a sibling SCM view fed the same merged threads; `renderNoteThreads` in `src/extension.ts` fans out to both surfaces plus the view badge.

## Manual test script

Basics (no contract, default settings):

1. In the dev host, open a repo with changes vs `main`. The panel lists them under Needs Review.
2. Click a file → diff is _merge base ↔ working tree_.
3. Click its `+` → it moves to Reviewed; status bar count updates.
4. Edit the file → it moves back to Needs Review, and its diff is now _last reviewed ↔ working tree_ (only the new edit).
5. Revert the edit (undo + save) → content matches the snapshot again, file returns to Reviewed on its own.
6. Commit / rebase — review state is unaffected (content-based).
7. Tree/list toggle, folder `+`/`−`, collapse state surviving reload, and repo switching in Source Control all behave as before.

Moves:

8. `git mv` a changed-or-unchanged file to another directory (pure move) → one **R** row at the new path (`← <old path>` in the description, "Moved from" in the tooltip), no row at the old path. Its diff says the files are identical, the title reads `<name> (moved from <old path> — merge base ↔ working tree)`, and the left editor is labeled with the old path.
9. `git mv` another file **and** edit it → still one R row; the diff shows only the edited lines, same title shape.
10. Mark a move row reviewed (inline `+`) → it moves to Reviewed and counts as one file. Edit it again → back to Needs Review with title `… (moved from … — last reviewed ↔ working tree)` and a diff of only the post-review edit.
11. The inline **Open File** action works on a move row (opens the new path).
12. Move a file with plain `mv` (unstaged) → old path shows as `D` plus an untracked `A` row at the new path. `git add -A`, refresh → the two rows collapse into one R row.

Auto-review:

13. Set `deltaReview.autoReview.globs` (e.g. `["**/*.lock"]`) → matching files move into a collapsed **Auto** subgroup (⚙, count, flat with directory descriptions) first under Needs Review, in both layouts. No reload needed.
14. A file marked `linguist-generated` in `.gitattributes` lands in Auto even with empty globs.
15. Auto header `+` marks them all; they stay inspectable under Reviewed → Auto. Folder `+` does not touch auto files; Mark All still covers everything.
16. Flip `markAutomatically` on → next refresh self-marks auto files; edit one → it is silently re-marked with a fresh snapshot (stays under Reviewed → Auto, never resurfaces). Flip the setting off and edit it again → now it resurfaces under Needs Review → Auto with a delta diff.

Clusters:

17. No contract → no grouping button. Create a valid contract for the branch (run the `cluster-review` skill, or hand-write one at `.git/delta-review/clusters-<branch>.json`) → the group-by-cluster button appears without a manual refresh.
18. Group → clusters render in contract order with `n/m` counts and summary tooltips, showing only needs-review rows; **Unclustered** (warning-styled) after the clusters and collapsed **Auto** appear only while something in them needs review; an always-present **Reviewed** bucket renders last (`0` on a fresh branch); a cluster with no files in the change shows a message row. Mark a file → it moves into the Reviewed bucket, not marked in place with a `✓`; fully review a cluster → its header stays with `n/n` over a single `All files reviewed.` row.
19. Tree/list toggle still works inside clusters and the Reviewed bucket (per-cluster folder collapse, folder actions scoped to the cluster); cluster header `+`/`−` bulk-marks exactly that bucket. In the Reviewed bucket, folder `−` (tree mode) unmarks every visible child, auto files included — and with `markAutomatically` on, the auto file bounces back into Reviewed on the next refresh.
20. Both levers persist across reload. Flipping either lever changes no review state (`git ls-tree -r refs/review/<branch>` identical before/after).
21. Break the contract (e.g. `"version": 3`) → ⚠ message, view falls back to ungrouped, grouping preference survives a later fix. Delete the contract → button and message disappear.
22. Throughout: `git status` in the test repo stays clean — the contract lives under `.git`.

Notes:

23. In a review diff, hover a right-side line and click the gutter `+` → the thread renders in place (Open), the REVIEW NOTES section lists it with the blue open icon, and the view badge counts it. `git status` stays clean; `.git/delta-review/notes-<branch>.json` and `refs/review-notes/<branch>` now exist.
24. Add a note on a **left** (base) side line → thread renders on the left editor with a `base` marker in REVIEW NOTES. Select a multi-line range first → the note spans the range.
25. Edit a reviewer turn (pencil on the comment) → Save persists, Cancel restores the original. Delete the only turn → the whole thread disappears (note gone from file and view); deleting one turn of a multi-turn thread keeps the rest.
26. Resolve from the thread title → green check in REVIEW NOTES, thread shows Resolved, badge drops. Unresolve → back to its derived status.
27. Agent round-trip: hand-write `.git/delta-review/responses-<branch>.json` (`{"version":1,"responses":[{"noteId":"<id>","status":"addressed","response":"…","at":"<UTC ISO-8601>"}]}`) → with **no manual refresh** the reply appears in the thread as Claude, the label flips to Addressed (yellow outline icon), and a reply box appears. Type a reply and hit Reply & Reopen → Open again, reply box gone.
28. Anchor relocation: append a response entry whose `anchor` names another file/line with that line's exact text as `snapshot` → the note relocates there (a base-side note flips to the working side) and the REVIEW NOTES row follows. An anchor with a bad path shape, a missing file, or an out-of-range line is ignored — reply still shows, note stays put. `snapshot` is not validated: a wrong-but-in-range anchor still relocates the note and stores that snapshot verbatim.
29. Outdated: edit lines **above** a note → the thread shifts down/up, not outdated. Edit the noted line itself → `⚠` in REVIEW NOTES and a dimmed `line was: …` in the thread's first comment.
30. Base progression: with a base-side note on a file, mark the file reviewed → the base thread is recreated against the new base (the reviewed snapshot); turns and status untouched.
31. REVIEW NOTES navigation: click a note → the file's review diff opens with the cursor on the noted line and the thread expanded. A note on a file no longer in the review set opens the plain file; if the file is gone from disk too → "note kept" info toast, nothing opens.
32. Clear Resolved (view title `$(clear-all)`) → resolved notes vanish from the file, the threads, and the ref; open/addressed notes untouched; clicking again is a no-op (file mtime unchanged).
33. Branch switch: `git switch` to another branch → that branch's own (empty or different) notes render; switch back → the originals return. Review marks and notes stay per-branch.
34. Corrupt files: garbage in the notes file → warning toast, notes unrendered, note actions refuse, and the extension **never rewrites the file**; restore it → everything returns. Garbage in the responses file → warning, notes still render (without replies), recovers when fixed. Each warning shows once, not per refresh.
35. Comments panel: open the built-in Comments panel → the same threads are listed there via the standard API; review tree, clusters, and auto-review behave exactly as before while notes exist.
