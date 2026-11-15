# 01_02 Marking the origin's deletion row keeps the moved file's inherited snapshot

## Goal

In Delta Review, marking a deleted path reviewed overwrites its review-state key with a "deleted sentinel" blob. When a moved file inherits that path's snapshot (possible since task 01_01, where the origin can be its own deletion row), marking the deletion row silently cancels the inheritance. Owner decision: reviewing the origin's deletion row must not cancel inheritance. The moved file keeps diffing against the snapshot it inherited and still reads Needs Review, and the deletion row reads Reviewed independently.

Mechanism: a sibling ref `refs/review-predeletion/<branch>` remembers, per path, the snapshot it held just before its deletion was marked. Inheritance falls back to it when the origin's key is the sentinel.

## Files to modify/create

- `src/reviewState.ts`
- `src/model.ts`
- `src/extension.ts`
- `DEVELOPMENT.md`
- (tests) `src/reviewState.test.ts`, `src/model.test.ts`

## Background

- `src/reviewState.ts`: `readReviewState` (`:18`) runs `git ls-tree -r -z refs/review/<branch>`, parsed by `parseLsTreeOutput` (`src/git.ts:113`), and returns an empty map when the ref is missing. `writeReviewState` (`:38`) builds a tree in a temp index (`update-index --index-info`), commits it with the previous commit as parent, and runs `update-ref`. `markReviewed` (`:90-120`) writes working-tree blobs for existing paths and the sentinel (`DELETED_SENTINEL_CONTENT` hashed) for deleted ones. `unmarkReviewed` (`:122-132`) deletes keys. `clearAllReviewSnapshots` (`:139-148`) writes an empty tree.
- Sibling-ref precedent: `src/sliceAnchor.ts` (`sliceRefForBranch`, `deleteSliceRef` at `:19-28`).
- `src/model.ts` after task 01_01: `selectReviewSnapshot` (`:270`) reads `inheritedSha = reviewState.get(move.from)` and requires `inheritedSha !== sentinelSha`. `computeReviewModel` reads the review state at `:658`. Its `originDeleted` pre-check reads `oldSha = reviewState.get(move.from)` with the same sentinel check.
- `src/extension.ts` `deltaReview.clearReviewState` (`:1277-1316`) deletes `refs/review/<branch>` and calls `deleteSliceRef` inside `reviewStateQueue.run`. All ref writes are serialized through that queue already (mark/unmark callers wrap `markReviewed`/`unmarkReviewed` in `applyReviewStateChange`, `:593`), so writing a second ref inside `markReviewed`/`unmarkReviewed` is safe.
- Design decisions (spec):
  - `pre[P]` is set only when P is marked while deleted and its prior review-state value is defined and not the sentinel. If the prior value is already the sentinel, `pre[P]` is left as is. Marking P while it exists deletes `pre[P]`. Unmarking P deletes `pre[P]`.
  - Inheritance: `originSnapshotSha(from, reviewState, preDeletionState, sentinelSha)` returns `reviewState.get(from)`, unless that is the sentinel, in which case it returns `preDeletionState.get(from)`. Every other inheritance condition is unchanged.
  - Unmarking moved file F drops `[F, P]` (`reviewSnapshotPaths`), and so drops `pre[P]` too: the origin row is unmarked with it (accepted owner decision). Unmarking P alone drops P and `pre[P]`, so F stops inheriting. That coupling already existed before this change.
  - A sentinel with no pre-deletion entry still blocks inheritance.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `src/reviewState.ts`:
   - Extract `readSnapshotTree(git, ref)` and `writeSnapshotTree(git, ref, map)` from the bodies of `readReviewState`/`writeReviewState`; keep those two as wrappers with unchanged signatures.
   - Add `preDeletionRefForBranch = (branch) => \`refs/review-predeletion/${branch}\``, `readPreDeletionState(git, branch)`, and `deletePreDeletionRef(git, branch)` (pattern: `deleteSliceRef`).
   - `markReviewed`: read both maps. Before setting a deleted path's sentinel, apply the rule above. For existing paths, `pre.delete(path)`. Write the review ref as today, then write the pre-deletion ref only when it changed (compare size and entries, or track a `changed` flag).
   - `unmarkReviewed`: also `pre.delete(path)` and write when changed.
   - `clearAllReviewSnapshots`: also write an empty pre-deletion tree when the pre map is non-empty.
   - Comment the new ref's meaning in one place (top of the helper).
2. `src/model.ts`:
   - Export `originSnapshotSha` (pure).
   - `selectReviewSnapshot` gains `preDeletionState: ReadonlyMap<string, string>` and uses the helper for `inheritedSha`.
   - `computeReviewModel` reads `readPreDeletionState(git, branch)` next to `readReviewState`, uses the helper for `oldSha`, and passes the map through.
3. `src/extension.ts` `clearReviewState`: call `deletePreDeletionRef(activeGit, clearedBranch)` next to `deleteSliceRef`, and update the comment there.
4. `DEVELOPMENT.md`:
   - Opening paragraph of "How it works" (`:24`): the sibling refs list gains `refs/review-predeletion/<branch>` (the snapshot a path held before its deletion was marked).
   - Inherit bullet (`:30`): "the old-path snapshot is the deleted sentinel" becomes "the old-path snapshot is the deleted sentinel with no pre-deletion snapshot behind it", and add that marking the origin's deletion row keeps the inheritance.
   - Clear Review State sentence (`:36`): it deletes the new ref too.
   - "Where the state lives" / inspect commands: add `git ls-tree -r refs/review-predeletion/<branch>`.
   - Add a manual step after 18 (as `18a.`, no renumbering): mark the origin's `D` row and confirm the destination still diffs `last reviewed ↔ working tree` and still reads Needs Review.

## Gotchas

- The `computeReviewModel` test stub in `src/model.test.ts` (`setUp`, `:879-939`) returns `full.reviewState` for every non-merge-base `ls-tree`. It must now branch on the ref argument (`args[3]`): `refs/review/<branch>` gives `reviewState`, and `refs/review-predeletion/<branch>` gives a new optional `preDeletionState` field. When that field is empty, throw like a missing ref, or every existing test silently reads the review state as pre-deletion state.
- The `select` helper (`src/model.test.ts:315`) needs a `preDeletionState` default of an empty map.
- `src/reviewState.test.ts` stubs git per call. `clearAllReviewSnapshots` tests that assert exact call lists will see the extra `ls-tree` for the pre-deletion ref; update them deliberately, not by loosening the assertions.
- Never write the pre-deletion ref on every mark: only on change, or every mark adds a no-op commit.
- Keep `readReviewState`'s signature: `src/extension.ts` and the model call it.
- Run `yarn format` before finishing.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- New unit tests:
  - `src/model.test.ts` `selectReviewSnapshot`: the review state holds the sentinel at `src/old.ts` and the pre-deletion state holds `REVIEWED_SHA`, so it inherits with `snapshotBaseSha === REVIEWED_SHA` and `reviewed: false`. With the sentinel and no pre-deletion entry, it does not inherit (existing test "does not inherit a sentinel old-path snapshot" stays). With a non-sentinel own value at `from`, the pre-deletion entry is ignored.
  - `src/model.test.ts` `originSnapshotSha` table test.
  - `src/model.test.ts` integration: the overwrite case from 01_01 with `reviewState: { "src/old.ts": SENTINEL }` (use whatever sentinel sha the stub's `hash-object` returns for `DELETED_SENTINEL_CONTENT`; follow how existing sentinel tests get it) and `preDeletionState: { "src/old.ts": REVIEWED_SHA }`. `dest.ts` inherits, and the `src/old.ts` row reads `Reviewed`.
  - `src/reviewState.test.ts`: `markReviewed` on a deleted path with a prior snapshot writes a pre-deletion tree containing it. Re-marking (prior is the sentinel) writes no pre-deletion commit. Marking an existing path drops its entry. `unmarkReviewed` drops the entry. `clearAllReviewSnapshots` empties both. Assert via the recorded `update-index` stdin per ref. Marking a deleted path needs `existsSync` false, so use a temp-dir `repoRoot` or a path that does not exist under `/repo`.
- Substitute check for `clearReviewState` (extension-host only): covered by `yarn build` plus reading the diff. A scripted extension-host check is optional.
