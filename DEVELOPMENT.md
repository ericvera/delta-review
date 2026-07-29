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

Files carry `M`/`A`/`D`/`R` letters and colors like the CHANGES view — computed relative to `merge-base(baseBranch, HEAD)`, not HEAD, so committed changes still show. Untracked files are included.

Moves reach the model from two sources, made indistinguishable downstream by `adjustReviewSetForMoves` (`src/model.ts`):

- **Detected** — git's rename detection (`--find-renames`). Always a repo origin.
- **Declared** — a `moves` entry in the clusters contract; the only way a file ported from another project, or moved without git noticing, reads as a move. A declaration beats detection for the same path, and the displaced detected source re-enters the set as its own row. A declaration whose `path` is not in the review set is ignored.

Either way the file is a single `R` row at the new path:

- **Description** — `← <reduced origin> · verbatim|adapted`, with `[donor]` before an external origin (`src/moveDisplay.ts`). The origin drops the trailing segments it shares with the new path, and an external origin is first cut back to its path inside the donor. Past `ROW_DESCRIPTION_THRESHOLD` (48 chars) it collapses to `…/<final segment>`. The tooltip carries the full origin (`Moved from <path>`, plus `(donor: <name>)` when the donor is not already a segment of it).
- **`verbatim`/`adapted` is derived, not declared** — `resolveFileBase` compares the working-tree blob to the origin's base blob. Two conditions, easily conflated: the row shows **no word** whenever that comparison is impossible (no origin base blob, or the file is deleted), while the tooltip's `Origin content is no longer available — showing the whole file.` needs the diff to have no base _at all_ — no origin blob, no reviewed snapshot, nothing at the destination's own merge-base path. So an overwrite with no origin blob, or a deleted move, drops the word without the line.
- **Diff base** — a repo origin uses the old path's merge-base blob (and `diffBasePath` is that old path); an external origin uses the contract's `baseBlob`, kept only while `git cat-file -t` still reports a blob. Neither → an empty base, so the diff shows the whole file.
- **Overwrite** — when the destination itself existed at the merge base, its own blob wins as the diff base (an overwrite is still an edit to a file the reviewer already had), and the repo origin's `D` row is _not_ suppressed: the origin's content is shown nowhere else.

Rename detection only sees what git sees — a plain unstaged `mv` still shows as a `D` row plus an untracked `A` row until staged or declared.

### Base document identity

The left-hand side of a review diff is a virtual document served by `src/contentProvider.ts`. Declared moves made its identity non-obvious, so it is resolved in exactly one place (`src/baseDocument.ts`):

- `ReviewFile.diffBasePath` names whichever content the base side shows — a repo origin's old path when the base really is that origin's blob, the file's own path otherwise, external origins included. Always repo-relative, so a donor path can never escape into a URI, the notes contract, or a ref. `openDiff` and the comment controller read it; nothing re-derives the left-hand path.
- A base document is keyed by the pair `(diffBasePath, diffBaseSha)` — `reviewBaseUriParts` puts the path in the URI path and the sha in its query, so the same path at two blobs is two distinct documents. A missing sha reads as the empty document.
- Why the key changed: two review files can now present the same base path, by two routes. (1) A declared repo move whose origin is itself in the review set — suppression requires the origin to be deleted, so an origin still on disk _and_ independently modified (or untracked) keeps its own row; an unmodified copy source never enters the review set and collides with nothing. (2) Two declarations naming the same `from`, since `parseClustersContract` dedupes on `path` only. Git's rename detection allowed neither, because it always removed the source row.
- Base-side review notes therefore resolve their current base with `baseBlobForNote`: (1) a file showing that base path whose `diffBaseSha` is the note's own `contentBlob`; (2) else the sole file showing that path — this is what lets a note follow a base that advanced when its file was marked reviewed — with the `path === file` tiebreak when several show it; (3) else no current base.

### Auto triage

Every file in the review set is classified `auto` or `normal` (`src/triage.ts`, called from `computeReviewModel` in `src/model.ts`) from exactly two inputs:

- `deltaReview.autoReview.globs` — picomatch patterns (`dot: true`, case-sensitive, repo-relative `/` paths). Empty, non-string, or uncompilable entries are skipped, never fatal.
- Paths marked `linguist-generated` in `.gitattributes`, fetched via `git check-attr --stdin -z linguist-generated` (best-effort: any failure means "none").

`auto` files render in the collapsed **Auto** subgroup (flat in both layouts, directory shown in the description) and are excluded from the normal list/tree and from folder bulk actions; group counts and Mark All still include them. With `autoReview.markAutomatically` on, `refresh()` marks needs-review auto files through the normal `markReviewed` snapshot path before the tree updates — so while the setting is on, an edited auto file is simply re-marked with a fresh snapshot on the next refresh and never resurfaces. Turn the setting off and the next edit resurfaces as a delta against the last snapshot, exactly like a hand-marked file.

### Clusters contract

Clustered review is driven by a JSON contract the extension only ever **reads** — an external tool (the `/delta:cluster` Claude Code skill in `plugin/`) writes it:

- Path: `<git common dir>/delta-review/clusters-<sanitized branch>.json`. The common dir (`git rev-parse --git-common-dir`, resolved against the repo root when relative) keeps the contract next to the review refs, shared across linked worktrees.
- Sanitization: every branch-name char outside `[A-Za-z0-9._-]` becomes `-` (`sanitizeBranchForFilename` in `src/clusters.ts`; the skill applies the identical rule).
- Schema: `{ "version": 2, "clusters": [{ "label", "summary", "files": [...], "patterns": [...] }], "moves": [...] }` — each cluster needs at least one non-empty array of `files` (explicit repo-relative paths) or `patterns` (picomatch globs). Unknown keys are ignored. `parseClustersContract` returns one-line user-facing errors.
- Versions: the parser accepts the integer `1` or `2`; the `delta:cluster` skill writes `2`. Anything else fails the file with `unsupported version <v> (extension supports 1 and 2)`. A version 1 contract normalizes to an empty `moves` list, and a `moves` key inside one is ignored.
- `moves` (version 2, optional array): one entry per declared move — required `path` (the file's current repo-relative path) and `from` (the origin path), required `origin` (`"repo"` = elsewhere in this repo, `"external"` = another project); optional `donor` (non-empty project name, shown bracketed on the row), `baseBlob` (40- or 64-character lowercase hex object id holding the origin's content) and `note` (free text, shown in the tooltip).
- Silently dropped rather than fatal: `donor`/`baseBlob` on a `repo` entry, a `repo` entry whose `from` equals its `path`, and duplicate `path`s (first entry wins). A declaration whose `path` is outside the review set is ignored later, by the model.
- All-or-nothing: one malformed `moves` entry rejects the **whole** file, so declarations and clustering always fail together — a bad move declaration costs the reviewer their grouping too.

#### ClusterModel flow

- Every `refresh()` loads the contract exactly once (`resolveBranch`, then `loadClustersContract`), **before** the review model is computed. Its `moves` feed both `computeReviewModel` calls — the initial one and the auto-mark recomputation — and cluster resolution reuses that same parse, so a contract rewritten mid-refresh can never produce a model whose moves and clusters disagree.
- Contract states: `missing` → no cluster state, no message, no declared moves; `invalid` → the same, plus a `⚠ Clusters contract: <error>` view message; `ok` → the declarations reach the model and `resolveClusterModel(contract, files)` produces the grouping. An invalid contract costs declared moves as well as grouping.
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
- `responses-<sanitized branch>.json` — **agent-owned**; the `review-notes` skill in `plugin/` appends `{ noteId, response, at, anchor? }` entries. The extension only reads it (corrupt → deduped warning, treated as missing).

Types and whole-file parsers live in `src/notes.ts` (clusters semantics: one violating entry rejects the file with a one-line error); persistence and mutation in `src/notesStore.ts` (atomic same-dir temp+rename saves, an idempotence guard so identical saves never touch the file — no watcher loops — and load→modify→save helpers).

#### The ref: `refs/review-notes/<branch>`

Each note snapshots the whole noted document as a git blob (`contentBlob`, via `hash-object -w`). All live blobs are anchored by a commit on `refs/review-notes/<branch>` (tree path = note id → blob), so `git gc` cannot prune them. It is deliberately separate from `refs/review/<branch>`: Clear Review State must not destroy note snapshots. The ref is deleted when the last note goes. Inspect with `git ls-tree refs/review-notes/<branch>`.

#### Anchoring model & derived-field refresh

A note pins `file`, `side` (`working` = right/current code, `base` = left/old code), a 1-based line range, the range's text (`snapshot`), and `contentBlob`. Every `refresh()` runs `refreshDerived` (`src/notesStore.ts`) to recompute the persisted hints (`status`, `outdated`, `currentStartLine/EndLine`):

- Diff `contentBlob` against the side's current content (`git diff -U0 <blob> <blob>`, hunks mapped by `src/noteAnchor.ts`): hunks above shift the range; a hunk touching it sets `outdated: true` and collapses it to one line; a missing document sets `outdated` and keeps the last position. A base-side note's current base comes from `baseBlobForNote` — the three-step lookup in [Base document identity](#base-document-identity) — so it progresses when its file is marked reviewed but never migrates onto a second file that happens to share the base path.
- Threads are merged in `src/noteThreads.ts`: reviewer `turns` + agent responses interleaved by `at`; status derived — explicit `resolved` wins, else last speaker (agent → **addressed**, reviewer → **open**). Derived fields are persisted back so agents reading the file get near-current hints.
- Response anchors: the newest agent anchor that resolves (`buildAnchorResolver` — repo-relative `/`-separated path only, file exists, line in range; traversal/absolute paths are always dangling) relocates the note to the fix — side flips to `working`, file/lines/snapshot/`contentBlob` are rewritten and re-anchored on the ref. One-shot per response via `appliedAnchorAt`.
- The clusters watcher on `<common dir>/delta-review/*.json` also covers both notes files, so agent replies merge live without a manual refresh.

Rendering is the standard VS Code comments API (`src/commentController.ts`) — threads appear in the built-in Comments panel for free, nothing is built against it. The REVIEW NOTES section (`src/notesTreeProvider.ts`) is a sibling SCM view fed the same merged threads; `renderNoteThreads` in `src/extension.ts` fans out to both surfaces plus the view badge.

## Manual test script

### Scripted extension-host checks

There is no committed e2e suite, but extension-host behavior can be verified headlessly with
`@vscode/test-electron`: a runner script calls `runTests` with `extensionDevelopmentPath` = this
repo root, a throwaway temp git repo as the workspace folder, and a short `--user-data-dir`
path; launch the runner with `env -u ELECTRON_RUN_AS_NODE`. The CommonJS suite drives the real
extension via `vscode.commands.executeCommand` and asserts on the contract files under
`.git/delta-review/`, the `refs/review*` refs, and rendered tree/thread state. Simulate SCM
repository switching via `git.toggleRepositoryVisibility` rather than the picker. These are
throwaway verification harnesses (session scratchpad), not shipped tests.

Basics (no contract, default settings):

1. In the dev host, open a repo with changes vs `main`. The panel lists them under Needs Review.
2. Click a file → diff is _merge base ↔ working tree_.
3. Click its `+` → it moves to Reviewed; status bar count updates.
4. Edit the file → it moves back to Needs Review, and its diff is now _last reviewed ↔ working tree_ (only the new edit).
5. Revert the edit (undo + save) → content matches the snapshot again, file returns to Reviewed on its own.
6. Commit / rebase — review state is unaffected (content-based).
7. Tree/list toggle, folder `+`/`−`, collapse state surviving reload, and repo switching in Source Control all behave as before.

Moves:

8. `git mv` a changed-or-unchanged file to another directory (pure move) → one **R** row at the new path, no row at the old path. Description `<new dir> ← <old dir> · verbatim`, with the origin's trailing segments shared with the new path dropped (in tree mode there is no directory text and the row starts at `←`); tooltip `Moved from <full old path>` then, a blank line later, `Identical to the origin`. Its diff says the files are identical, the title reads `<name> (moved from <old path> — merge base ↔ working tree)`, and the left editor is labeled with the old path. That last part holds for a repo origin only while the destination did not exist at the merge base (contrast step 16) and the file is not on a reviewed-snapshot base (contrast step 10); step 14 covers an external origin.
9. `git mv` another file **and** edit it → still one R row, now `· adapted`, and the tooltip drops the `Identical to the origin` line; the diff shows only the edited lines, same title shape.
10. Mark a move row reviewed (inline `+`) → it moves to Reviewed and counts as one file. Edit it again → back to Needs Review with title `… (moved from … — last reviewed ↔ working tree)` and a diff of only the post-review edit.
11. The inline **Open File** action works on a move row (opens the new path).
12. Move a file with plain `mv` (unstaged) → old path shows as `D` plus an untracked `A` row at the new path. `git add -A`, refresh → the two rows collapse into one R row.
13. **Declared repo move git cannot detect**: leave that plain unstaged `mv` unstaged and hand-write a version 2 contract for the branch — `{"version": 2, "clusters": [], "moves": [{"path": "<new>", "from": "<old>", "origin": "repo"}]}` (path per the Clusters contract section; `clusters` is required even when empty, or the file fails with `"clusters" must be an array` before `moves` is read) → without staging anything, the `D` row at the old path disappears and the new path becomes a single R row rendering exactly as step 8, based on the old path's merge-base blob. Delete the declaration → the two rows return.
14. **Declared external move**: copy a file in from another project, `git hash-object -w` the donor's original (`git hash-object -w ../donor-app/src/telemetry/reporter.ts`), and declare it in a version 2 contract — `{"version": 2, "clusters": [], "moves": [{"path": "src/vendor/reporter.ts", "from": "../donor-app/src/telemetry/reporter.ts", "origin": "external", "donor": "donor-app", "baseBlob": "<that sha>", "note": "Swapped its logger for ours"}]}` → the row reads `src/vendor ← [donor-app] src/telemetry · adapted`, landing exactly on `ROW_DESCRIPTION_THRESHOLD` (48 chars); copy it byte-for-byte instead and the one-character-longer `· verbatim` tips it over, collapsing the origin to `src/vendor ← [donor-app] …/telemetry · verbatim`. The tooltip stacks the full origin, the note, and — when verbatim — `Identical to the origin`. The diff shows **only the adaptation**, not the whole file. The title names the donor path (`reporter.ts (moved from ../donor-app/src/telemetry/reporter.ts — merge base ↔ working tree)`) while the **left editor carries the file's own path** — an external path must never reach a base-document URI, the notes contract, or a ref. Add a base-side note and confirm `notes-<branch>.json` records the repo-relative path.
15. **Pruned `baseBlob`**: point that same `baseBlob` at a well-formed sha that is not in the object database → the row loses its classification word (`src/vendor ← [donor-app] src/telemetry`), the tooltip gains `Origin content is no longer available — showing the whole file.`, and the diff shows the whole file against an empty base. The title is unchanged.
16. **Move onto an existing path**: declare `{"version": 2, "clusters": [], "moves": [{"path": "<a path that exists at the merge base>", "from": "<another path you deleted>", "origin": "repo"}]}` → the destination is an R row whose diff is against **its own** merge-base blob (the overwrite reads as an edit to a file the reviewer already had), and the origin keeps its own `D` row, since its content is shown nowhere else.

Auto-review:

17. Set `deltaReview.autoReview.globs` (e.g. `["**/*.lock"]`) → matching files move into a collapsed **Auto** subgroup (⚙, count, flat with directory descriptions) first under Needs Review, in both layouts. No reload needed.
18. A file marked `linguist-generated` in `.gitattributes` lands in Auto even with empty globs.
19. Auto header `+` marks them all; they stay inspectable under Reviewed → Auto. Folder `+` does not touch auto files; Mark All still covers everything.
20. Flip `markAutomatically` on → next refresh self-marks auto files; edit one → it is silently re-marked with a fresh snapshot (stays under Reviewed → Auto, never resurfaces). Flip the setting off and edit it again → now it resurfaces under Needs Review → Auto with a delta diff.

Clusters:

21. No contract → no grouping button. Create a valid contract for the branch (run the `cluster-review` skill, or hand-write one at `.git/delta-review/clusters-<branch>.json`) → the group-by-cluster button appears without a manual refresh.
22. Group → clusters render in contract order with `n/m` counts and summary tooltips, showing only needs-review rows; **Unclustered** (warning-styled) after the clusters and collapsed **Auto** appear only while something in them needs review; an always-present **Reviewed** bucket renders last (`0` on a fresh branch); a cluster with no files in the change shows a message row. Mark a file → it moves into the Reviewed bucket, not marked in place with a `✓`; fully review a cluster → its header stays with `n/n` over a single `All files reviewed.` row.
23. Tree/list toggle still works inside clusters and the Reviewed bucket (per-cluster folder collapse, folder actions scoped to the cluster); cluster header `+`/`−` bulk-marks exactly that bucket. In the Reviewed bucket, folder `−` (tree mode) unmarks every visible child, auto files included — and with `markAutomatically` on, the auto file bounces back into Reviewed on the next refresh.
24. Both levers persist across reload. Flipping either lever changes no review state (`git ls-tree -r refs/review/<branch>` identical before/after).
25. Break the contract (e.g. `"version": 3`) → `⚠ Clusters contract: unsupported version 3 (extension supports 1 and 2)`, view falls back to ungrouped, **and every declared move reverts to plain rows** — an invalid contract costs moves as well as grouping. Grouping preference survives a later fix. Delete the contract → button and message disappear (moves revert the same way).
26. Throughout: `git status` in the test repo stays clean — the contract lives under `.git`.

Notes:

27. In a review diff, hover a right-side line and click the gutter `+` → the thread renders in place (Open), the REVIEW NOTES section lists it with the blue open icon, and the view badge counts it. `git status` stays clean; `.git/delta-review/notes-<branch>.json` and `refs/review-notes/<branch>` now exist.
28. Add a note on a **left** (base) side line → thread renders on the left editor with a `base` marker in REVIEW NOTES. Select a multi-line range first → the note spans the range.
29. Edit a reviewer turn (pencil on the comment) → Save persists, Cancel restores the original. Delete the only turn → the whole thread disappears (note gone from file and view); deleting one turn of a multi-turn thread keeps the rest.
30. Resolve from the thread title → green check in REVIEW NOTES, thread shows Resolved, badge drops. Unresolve → back to its derived status.
31. Agent round-trip: hand-write `.git/delta-review/responses-<branch>.json` (`{"version":1,"responses":[{"noteId":"<id>","response":"…","at":"<UTC ISO-8601>"}]}`) → with **no manual refresh** the reply appears in the thread as Claude, the label flips to Addressed (yellow outline icon), and a reply box appears. Type a reply and hit Reply & Reopen → Open again, reply box gone.
32. Anchor relocation: append a response entry whose `anchor` names another file/line with that line's exact text as `snapshot` → the note relocates there (a base-side note flips to the working side) and the REVIEW NOTES row follows. An anchor with a bad path shape, a missing file, or an out-of-range line is ignored — reply still shows, note stays put. `snapshot` is not validated: a wrong-but-in-range anchor still relocates the note and stores that snapshot verbatim.
33. Outdated: edit lines **above** a note → the thread shifts down/up, not outdated. Edit the noted line itself → `⚠` in REVIEW NOTES and a dimmed `line was: …` in the thread's first comment.
34. Base progression: with a base-side note on a file, mark the file reviewed → the base thread is recreated against the new base (the reviewed snapshot); turns and status untouched.
35. REVIEW NOTES navigation: click a note → the file's review diff opens with the cursor on the noted line and the thread expanded. A note on a file no longer in the review set opens the plain file; if the file is gone from disk too → "note kept" info toast, nothing opens.
36. Clear Resolved (view title `$(clear-all)`) → resolved notes vanish from the file, the threads, and the ref; open/addressed notes untouched; clicking again is a no-op (file mtime unchanged).
37. Branch switch: `git switch` to another branch → that branch's own (empty or different) notes render; switch back → the originals return. Review marks and notes stay per-branch.
38. Corrupt files: garbage in the notes file → warning toast, notes unrendered, note actions refuse, and the extension **never rewrites the file**; restore it → everything returns. Garbage in the responses file → warning, notes still render (without replies), recovers when fixed. Each warning shows once, not per refresh.
39. Comments panel: open the built-in Comments panel → the same threads are listed there via the standard API; review tree, clusters, and auto-review behave exactly as before while notes exist.
