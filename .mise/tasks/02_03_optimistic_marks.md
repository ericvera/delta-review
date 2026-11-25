# 02_03 Optimistic mark/unmark with rollback; no-op reasons

## Goal

Clicking mark or unmark (file, folder, cluster, auto, all) moves the rows, badge and status-bar counter immediately, before the git write and refresh finish. On failure, the change is undone and an error explains why, offering Retry and Show Log. The mark/unmark commands' silent no-ops say why nothing happened.

## Files to modify/create

- src/optimisticModel.ts (new; test: src/optimisticModel.test.ts)
- src/extension.ts
- DEVELOPMENT.md

## Background

- Line numbers are from before earlier tasks edited `src/extension.ts`. Locate by symbol.
- `applyReviewStateChange(action, mutate)` (`src/extension.ts:801-817`) wraps `reviewStateQueue.run(mutate)` + `refresh()` in `vscode.window.withProgress({ location: { viewId: "deltaReview" } })` and shows `Delta Review: failed to <action> (<msg>)` on error.
  - Callers: `markClusterPaths` (`:819-826`), `markFileReviewed` (`:1554-1572`), `unmarkFileReviewed` (`:1574-1593`), `unmarkAllReviewed` (`:1596-1611`), `markFolderReviewed` / `unmarkFolderReviewed` (`:1814-1865`), cluster (`:1981-2030`), auto (`:2033-2086`), `markAllReviewed` (`:2088-2103`).
- The tree updates only at `treeProvider.setModel(model)` inside `refresh()`. The badge and counter text are computed right after it (`:571-593`), so factor that block into a `publishModel(model)` helper that the optimistic path reuses.
- Grouped (cluster) mode reads a separate `clusterModel`: `refresh()` builds it with `resolveClusterModel(contractResult.contract, computed.files)` (`src/extension.ts:543-555`) before the publish block. `ClusterModel` holds `ReviewFile` objects (`src/clusters.ts:81-87`) that the grouped tree reads (`src/treeProvider.ts:279-300`, `:322-330`) through the `() => clusterModel` getter (`src/extension.ts:200`). An optimistic model with new file objects leaves those rows stale unless `clusterModel` is re-resolved from the optimistic files.
- Slice anchoring runs inside `reviewStateQueue` during every refresh (`src/extension.ts:526-535`), after that refresh already read the review ref. A refresh started after an optimistic publish but before the queued write lands therefore holds pre-write state when it publishes.
- Task 02_02 added `publishCount` to `__inspect`, incremented in `refresh()` beside `treeProvider.setModel(model)`. Keep the increment in `refresh()` right after its `publishModel(model)` call, not inside `publishModel`: it counts refresh publishes only, so the optimistic publish adds nothing and a mark still adds exactly one.
- `ReviewFile.status` (`FileReviewStatus.NeedsReview | Reviewed`) and `hasReviewSnapshot` (`src/model.ts:34-60`) drive row placement and the inline `+`/`−` actions.
- Task 02_01: `ReviewStateConflictError` (exported from `src/reviewState.ts`, fields `ref`, `kind: "moved" | "locked"`, `lockPath?`) is thrown after compare-and-set retries fail. `locked` may be a stale lock from a crashed git process, so its reason must not blame another window.
- Task 02_02: the refresh scheduler. Own ref writes no longer trigger a second refresh.
- Mock (`.mise/mock/mark-reviewed.html`):
  - The row moves in the same frame with no progress spinner. The badge and `Review n/m` update with it.
  - On failure the row moves back and the error reads `Could not mark src/notesStore.ts reviewed: the review state changed in another window and the retry also failed. Your mark was undone.` with buttons `Retry` and `Show Log`. A non-conflict failure carries git's reason, e.g. `Could not mark src/notesStore.ts reviewed: cannot lock ref '…'. Your mark was undone.`
  - The same applies to unmark, mark-all and unmark-all.
- `git.run` (`src/git.ts:30-33`) rejects with Node's raw `execFile` error. Its `message` is `Command failed: git update-ref …` followed by git's stderr on the next lines, and its `stderr` property holds the stderr (a Buffer, since `runGit` uses `encoding: "buffer"`). For a lock failure git prints `fatal: cannot lock ref 'refs/review/<branch>': Unable to create '<path>.lock': File exists.` (or `… Permission denied`).
- Goals assumption: the silent no-ops report why (`model === undefined`, or the element is not a file: `src/extension.ts:1556-1561`, `:1577-1584`).
- `model` is also undefined when no review can exist, not only while loading: task 01_02 leaves it undefined when the explicit base is missing (`baseResolution.missing`, early return in `refresh()`) and in the fatal catch on a `MergeBaseError` (`src/model.ts`) with no merge-base; 01_03 sets context keys `deltaReview.baseMissing` / `deltaReview.mergeBaseFailed` at those same two sites. "Still loading" is wrong there.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `src/optimisticModel.ts` (pure):
  - `withReviewStatus(model, paths, reviewed): { model: ReviewModel; prior: Map<path, { status, hasReviewSnapshot }> }`.
    - It returns a shallow-copied model with new file objects for the affected paths.
    - Reviewed sets `status = Reviewed, hasReviewSnapshot = true`. Unreviewed sets `status = NeedsReview, hasReviewSnapshot = false`.
    - Unknown paths are ignored.
  - `revertReviewStatus(model, prior)` restores those fields on the matching files of whatever model is current, again by copy.
  - `gitErrorReason(error: unknown): string`: take stderr from `error.stderr` (Buffer → UTF-8, or string) when present, else the message lines after a first line starting `Command failed:`, else the whole message. Return the first line starting `fatal:` or `error:` with that prefix and surrounding whitespace removed; else the first non-empty line; else the message's first line. Strip one trailing `.` so the toast's own `. Your mark was undone.` does not double it. A non-Error value gives `String(error)`.
  - `noModelMessage(unavailable: { kind: "baseMissing"; base: string; branch: string } | { kind: "mergeBaseFailed"; base: string } | undefined): string`:
    - undefined: `Delta Review: the review is still loading — try again in a moment.`
    - `baseMissing`: `Delta Review: nothing to mark — base <base> for branch <branch> does not resolve. Click the base in the status bar to choose one.`
    - `mergeBaseFailed`: `Delta Review: nothing to mark — no merge-base with "<base>". Click the base in the status bar to choose another.`
  - `applyPendingMarks(model, pending: readonly { paths: readonly string[]; reviewed: boolean }[]): ReviewModel` folds `withReviewStatus` over the entries in order (later entries win on a shared path) and returns the input unchanged when `pending` is empty.
- `src/extension.ts`:
  - Create `const log = vscode.window.createOutputChannel("Delta Review")` (subscriptions).
  - `let clusterContract: ClustersContract | undefined`: in `refresh()`, set it to `contractResult.contract` when the contract is ok, else undefined, at the `resolveClusterModel` site; clear it wherever `clusterModel` is cleared.
  - `publishModel(next: ReviewModel)`: `model = next`; `clusterModel = clusterContract === undefined ? undefined : resolveClusterModel(clusterContract, next.files)`; `treeProvider.setModel(next)`; badge and counter (the factored block). `refresh()` calls it in place of `model = computed; treeProvider.setModel(model)` plus the badge/counter block, and keeps its provenance, agent-line and `syncActiveClusterChanges` calls beside it.
  - Pending overlay: `const pendingMarks: { token: number; paths: string[]; reviewed: boolean }[] = []`. In `refresh()`, right after the final `computeReviewModel` result is known (after the auto-mark recompute) and before the `resolveClusterModel` site, replace `computed` with `applyPendingMarks(computed, pendingMarks)`, so the cluster resolution, `setClustersAvailable` and `publishModel` all see the overlaid files. Notes code keeps using the overlaid model (only `status`/`hasReviewSnapshot` differ).
  - Replace `applyReviewStateChange` with `applyReviewStateChange({ action, subject, mutate, optimistic?: { paths, reviewed } })`. No `withProgress`.
    1. If `optimistic` is set: push `{ token, paths, reviewed }` onto `pendingMarks`. If `model` is defined, run `withReviewStatus`, keep its `prior`, and `publishModel(result.model)`.
    2. `await reviewStateQueue.run(mutate)`. Then, in one synchronous step, remove the entry from `pendingMarks` and start `const done = refresh()` (its synchronous `++refreshGeneration` makes every older in-flight refresh bail before it can publish un-overlaid state); then `await done`.
    3. On error from the mutation: log the full error (stack) to `log`. In one synchronous step, remove the entry, and if a model is current, `publishModel(applyPendingMarks(revertReviewStatus(model, prior), pendingMarks))` (other still-pending changes stay applied), then `void refresh()`. An error from the post-write `refresh()` is logged and shown as `Delta Review: refresh failed (<msg>)` with no revert, since the write landed.
    4. Show `Could not ${action} ${subject}: ${reason}. Your mark was undone.` Reasons: `ReviewStateConflictError` with `kind: "moved"` → `the review state changed in another window and the retry also failed`; `kind: "locked"` → `${error.ref} stayed locked by another git process (${error.lockPath}); if no git command is running, delete that file`; otherwise `gitErrorReason(error)` (never Node's `Command failed: git …` line). Buttons are `Retry` (call the same `applyReviewStateChange` args again) and `Show Log` (`log.show()`).
  - `subject` is the file path for single files, `<n> files` for groups, and the label for clusters and folders.
  - Pass `optimistic` from every caller:
    - mark: the paths it marks
    - unmark: the paths whose rows it affects (for `unmarkFileReviewed` that is `element.file.path`; `reviewSnapshotPaths` still drives the mutation)
    - unmarkAll: all model file paths with `hasReviewSnapshot`
  - No-op reasons, as info messages:
    - model undefined: `noModelMessage(reviewUnavailable)`. Hold `let reviewUnavailable: Parameters<typeof noModelMessage>[0]` in `extension.ts`: set it to `{ kind: "baseMissing", base, branch }` in `refresh()`'s missing-base early return and to `{ kind: "mergeBaseFailed", base }` in the `MergeBaseError` fatal path (the same two sites that set the 01_03 context keys true); set it to `undefined` at every other outcome of `refresh()` (successful publish, other fatal errors, no git) and in `setActiveRepo`.
    - element not a file: `Delta Review: select a file row to mark it reviewed.`
    - unmark without a snapshot: `Delta Review: <path> has no reviewed snapshot to drop.`
- DEVELOPMENT.md:
  - Add a short "Responsiveness" subsection under "How it works":
    - optimistic publish (clusters re-resolved), the pending overlay applied by every refresh until the write settles, and rollback
    - compare-and-set with 3 attempts (from 02_01), and the `locked` error naming a possibly stale lock file
    - the scheduler's max wait and the self-write filter (from 02_02), including the cross-window trade-off
  - Add a manual-script step: mark a file and see the row move instantly; run `chmod -R a-w .git/refs/review` (in the main worktree's git dir), mark another file and see the rollback error with Retry and Show Log; restore with `chmod -R u+w .git/refs/review`.
  - Terse, per CLAUDE.md.

## Gotchas

- Overlay rule (the only one): an in-flight refresh that read pre-write state must not flip the row back, whether it started before or after the optimistic publish. The pending overlay covers every refresh that publishes while the write is queued or running; removing the entry and starting `refresh()` in the same synchronous step covers the moment the write settles. Do not add a separate generation bump at the optimistic publish.
- Do not `await` anything between removing a `pendingMarks` entry and calling `refresh()` / `publishModel`.
- Revert against the current model, not the captured one: another refresh may have landed in between.
- Keep the command handlers' "read `git`/`model` into locals before enqueueing" pattern.

## Verification

- `src/optimisticModel.test.ts`:
  - `withReviewStatus` marks and unmarks the right files only and never mutates the input
  - `prior` captures the original values
  - `revertReviewStatus` on a different model instance restores only the listed paths
  - unknown paths are ignored
  - `gitErrorReason`: an execFile-shaped error (`message` `Command failed: git update-ref refs/review/x abc def\nfatal: cannot lock ref 'refs/review/x': Unable to create '/r/.git/refs/review/x.lock': File exists.\n`, `stderr` as a Buffer of the same stderr) gives `cannot lock ref 'refs/review/x': Unable to create '/r/.git/refs/review/x.lock': File exists`; the same with no `stderr` property gives the same result; `error: …` stderr is stripped likewise; stderr with no prefixed line gives its first non-empty line; a plain `new Error("boom")` gives `boom`; a string gives itself
  - `noModelMessage` gives the loading text for undefined, and the base-missing and no-merge-base texts (each naming the base, neither saying `loading`)
  - `applyPendingMarks` applies entries in order (a later unmark beats an earlier mark on the same path) and returns the same object for an empty list
  - `resolveClusterModel(contract, withReviewStatus(model, [p], true).model.files)` places `p` as reviewed in its cluster bucket (guards the grouped-mode wiring)
- Run `yarn test`, `yarn lint`, `yarn build`.
- Scripted extension-host check (batch with 02_02's):
  - Call `executeCommand("deltaReview.markFileReviewed", { kind: "file", file })` without awaiting. Read `__inspect().treeRows` on the next tick: the file's row is already under Reviewed.
  - After awaiting, `git ls-tree refs/review/<branch>` lists it.
  - Grouped mode: write a clusters contract (`.git/delta-review/clusters-<branch>.json`, per `plugin/skills/cluster/SKILL.md`) putting the file in a cluster, run `executeCommand("deltaReview.groupByCluster")`, then mark without awaiting. On the next tick `__inspect().treeRows` shows the file under the Reviewed bucket, not in its cluster body; after the failure case below, it is back in its cluster body.
  - Pending overlay: mark without awaiting, then immediately `executeCommand("deltaReview.refresh")` without awaiting (a refresh that starts after the optimistic publish and may read pre-write state). Sample `__inspect().treeRows` on every tick until both resolve: the row never reads Needs review.
- After a first mark, make `.git/refs/review` unwritable with `chmod -R a-w <repo>/.git/refs/review` (recursive: a branch with `/` puts its lock file in a subdirectory), mark another file, then await. The row is back under Needs review and the ref is unchanged. Restore with `chmod -R u+w <repo>/.git/refs/review` in a `finally`, so a failed assertion never leaves the temp repo unwritable.
- `__inspect().publishCount` rises by exactly one per mark (the optimistic publish does not count).
- Manual (eyeball): the error toast shows Retry and Show Log, and Show Log opens "Delta Review" output with the stack.
