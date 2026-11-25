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
- Task 02_02 added `publishCount` to `__inspect`, incremented in `refresh()` beside `treeProvider.setModel(model)`. Keep the increment in `refresh()` right after its `publishModel(model)` call, not inside `publishModel`: it counts refresh publishes only, so the optimistic publish adds nothing and a mark still adds exactly one.
- `ReviewFile.status` (`FileReviewStatus.NeedsReview | Reviewed`) and `hasReviewSnapshot` (`src/model.ts:34-60`) drive row placement and the inline `+`/`−` actions.
- Task 02_01: `ReviewStateConflictError` (exported from `src/reviewState.ts`) is thrown after compare-and-set retries fail.
- Task 02_02: the refresh scheduler. Own ref writes no longer trigger a second refresh.
- Mock (`.mise/mock/mark-reviewed.html`):
  - The row moves in the same frame with no progress spinner. The badge and `Review n/m` update with it.
  - On failure the row moves back and the error reads `Could not mark src/notesStore.ts reviewed: the review state changed in another window and the retry also failed. Your mark was undone.` with buttons `Retry` and `Show Log`. A non-conflict failure carries git's reason, e.g. `Could not mark src/notesStore.ts reviewed: cannot lock ref '…'. Your mark was undone.`
  - The same applies to unmark, mark-all and unmark-all.
- Goals assumption: the silent no-ops report why (`model === undefined`, or the element is not a file: `src/extension.ts:1556-1561`, `:1577-1584`).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `src/optimisticModel.ts` (pure):
  - `withReviewStatus(model, paths, reviewed): { model: ReviewModel; prior: Map<path, { status, hasReviewSnapshot }> }`.
    - It returns a shallow-copied model with new file objects for the affected paths.
    - Reviewed sets `status = Reviewed, hasReviewSnapshot = true`. Unreviewed sets `status = NeedsReview, hasReviewSnapshot = false`.
    - Unknown paths are ignored.
  - `revertReviewStatus(model, prior)` restores those fields on the matching files of whatever model is current, again by copy.
- `src/extension.ts`:
  - Create `const log = vscode.window.createOutputChannel("Delta Review")` (subscriptions).
  - Replace `applyReviewStateChange` with `applyReviewStateChange({ action, subject, mutate, optimistic?: { paths, reviewed } })`. No `withProgress`.
    1. If `optimistic` is set and `model` is defined: bump `refreshGeneration`, run `withReviewStatus`, assign the result to `model`, then `publishModel`.
    2. `await reviewStateQueue.run(mutate)`, then `await refresh()`.
    3. On error, log the full error (stack) to `log`. If a model is current, revert it and `publishModel`. Then `void refresh()`.
    4. Show `Could not ${action} ${subject}: ${reason}. Your mark was undone.` The reason is the conflict text for `ReviewStateConflictError`, otherwise the error message's first line. Buttons are `Retry` (call the same `applyReviewStateChange` args again) and `Show Log` (`log.show()`).
  - `subject` is the file path for single files, `<n> files` for groups, and the label for clusters and folders.
  - Pass `optimistic` from every caller:
    - mark: the paths it marks
    - unmark: the paths whose rows it affects (for `unmarkFileReviewed` that is `element.file.path`; `reviewSnapshotPaths` still drives the mutation)
    - unmarkAll: all model file paths with `hasReviewSnapshot`
  - No-op reasons, as info messages:
    - model undefined: `Delta Review: the review is still loading — try again in a moment.`
    - element not a file: `Delta Review: select a file row to mark it reviewed.`
    - unmark without a snapshot: `Delta Review: <path> has no reviewed snapshot to drop.`
- DEVELOPMENT.md:
  - Add a short "Responsiveness" subsection under "How it works":
    - optimistic publish and rollback
    - compare-and-set with 3 attempts (from 02_01)
    - the scheduler's max wait and the self-write filter (from 02_02), including the cross-window trade-off
  - Add a manual-script step: mark a file and see the row move instantly; run `chmod -R a-w .git/refs/review` (in the main worktree's git dir), mark another file and see the rollback error with Retry and Show Log; restore with `chmod -R u+w .git/refs/review`.
  - Terse, per CLAUDE.md.

## Gotchas

- Generation rule (the only one): an in-flight refresh that read pre-write state must not flip the row back. So `applyReviewStateChange` bumps `refreshGeneration` right before the optimistic publish; older in-flight refreshes then bail at their generation checks, and the command's own `refresh()` (started after the write) publishes next.
- Revert against the current model, not the captured one: another refresh may have landed in between.
- Keep the command handlers' "read `git`/`model` into locals before enqueueing" pattern.

## Verification

- `src/optimisticModel.test.ts`:
  - `withReviewStatus` marks and unmarks the right files only and never mutates the input
  - `prior` captures the original values
  - `revertReviewStatus` on a different model instance restores only the listed paths
  - unknown paths are ignored
- Run `yarn test`, `yarn lint`, `yarn build`.
- Scripted extension-host check (batch with 02_02's):
  - Call `executeCommand("deltaReview.markFileReviewed", { kind: "file", file })` without awaiting. Read `__inspect().treeRows` on the next tick: the file's row is already under Reviewed.
  - After awaiting, `git ls-tree refs/review/<branch>` lists it.
  - After a first mark, make `.git/refs/review` unwritable with `chmod -R a-w <repo>/.git/refs/review` (recursive: a branch with `/` puts its lock file in a subdirectory), mark another file, then await. The row is back under Needs review and the ref is unchanged. Restore with `chmod -R u+w <repo>/.git/refs/review` in a `finally`, so a failed assertion never leaves the temp repo unwritable.
- `__inspect().publishCount` rises by exactly one per mark (the optimistic publish does not count).
- Manual (eyeball): the error toast shows Retry and Show Log, and Show Log opens "Delta Review" output with the stack.
