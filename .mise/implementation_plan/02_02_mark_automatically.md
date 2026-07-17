# Task 2.2: `deltaReview.autoReview.markAutomatically`

## Goal

When the setting is true, auto-triaged files needing review are marked reviewed automatically during refresh, through the normal snapshot path, so later edits still resurface as deltas.

## Requirements addressed

REQ-AUTO-6.

## Background

Delta Review marks a file reviewed by snapshotting its working-tree content as a git blob under `refs/review/<branch>` (`markReviewed`, `src/reviewState.ts:90`: `hash-object -w` then a review-ref commit). Status is derived by content comparison in `computeReviewModel` (`src/model.ts:94-113`), so an auto-marked file that later changes automatically returns to Needs Review — that property is why auto-marking MUST go through `markReviewed`, never a parallel mechanism.

Task 1.2 added `triage: 'auto' | 'normal'` to `ReviewFile` and declared the `deltaReview.autoReview.markAutomatically` setting (boolean, default false) in `package.json`. Task 2.1 renders reviewed auto files in an Auto subgroup under Reviewed, so auto-marked files stay visible (never hidden).

The refresh cycle lives in `refresh()` (`src/extension.ts:114-162`): guarded by a generation counter against concurrent runs, it calls `computeReviewModel`, then updates the tree/badge/status bar. Refresh triggers: 400ms-debounced file watcher, document save, window focus, configuration change, git repo state change (`src/extension.ts:387-398, 422`).

## Files to modify/create

- `src/extension.ts` — auto-marking inside `refresh()`.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. In `refresh()`, after `computeReviewModel` succeeds and the generation check passes: read `deltaReview.autoReview.markAutomatically`; if true, collect `files.filter(f => f.triage === 'auto' && f.status === NeedsReview)`.
2. If non-empty: `await markReviewed(git, model.branch, paths)` then recompute the model once (call `computeReviewModel` again) and proceed with the recomputed result. One recompute suffices — after marking, those files compare equal to their snapshots.
3. Re-check the generation counter after each await (the existing pattern at `src/extension.ts:131-133, 153-155`) so a stale refresh never writes the UI.
4. Never unmark, never touch already-reviewed files or normal files (the filter above guarantees this; keep it that way).

## Testing suggestions

- Manual (F5 dev host): enable the setting with a matching glob → matching files land in Reviewed → Auto automatically on the next refresh; edit one → it returns to Needs Review (Auto subgroup) with the diff against the auto-snapshot; disable the setting → nothing is auto-marked but existing marks persist.
- Toggle the setting while the panel is open — config-change refresh applies it without reload (REQ-AUTO-8 wiring from Task 1.2).
- `git log refs/review/<branch>` shows the auto-mark as a normal review-state commit.
- Test exception applies (no e2e infrastructure): manual dev-host verification above.

## Gotchas

- **Loop safety**: `markReviewed` writes a ref inside `.git`; the repo watcher and/or the git extension's `repository.state.onDidChange` (`src/extension.ts:422`) may fire and schedule another refresh. That refresh finds nothing to mark (all auto files reviewed) — the operation is idempotent; do not add extra suppression state.
- Deleted auto files: `markReviewed` records the deletion sentinel — intended; don't filter deleted paths.
- Do the marking *before* `treeProvider.setModel` so users never see a flash of "needs review" for files that are about to be auto-marked.

## Verification checklist

- [ ] Setting true → auto files self-mark via the review ref (verify with `git ls-tree -r refs/review/<branch>`)
- [ ] Edited auto-marked file resurfaces as needs-review delta
- [ ] Setting false (default) → behavior identical to Task 2.1
- [ ] `yarn build`/`lint`/`test` green
- [ ] End-to-end: Test exception (no e2e infra) — manual dev-host pass above
