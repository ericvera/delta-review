# 01_01 Moved files inherit when extractions share the origin or the origin is only a deletion row

## Goal

In Delta Review (a VS Code extension for reviewing a branch's diff), a moved file can inherit the reviewed snapshot of its old path (`from`). Two rules in `selectReviewSnapshot` / `computeReviewModel` (`src/model.ts`) block that inheritance in cases where it should apply. Relax both:

1. Only whole-file moves (`fromLines === undefined`) count toward the "shared origin" rule. Extraction entries naming the same `from` no longer block inheritance.
2. A `from` that is its own row in the review set no longer blocks inheritance when that row is only its deletion (absent from the working tree). A `from` that is its own row and still exists on disk still blocks it.

## Files to modify/create

- `src/model.ts`
- `DEVELOPMENT.md`
- (tests) `src/model.test.ts`

## Background

- Review state is a map path -> snapshot blob sha (`refs/review/<branch>`). A file whose own snapshot is missing can inherit its move origin's snapshot. `selectReviewSnapshot` (`src/model.ts:270`) decides this. The blocking clauses are `!input.originShared` and `!input.reviewPaths.has(move.from)` (`src/model.ts:293`).
- `computeReviewModel` builds `fromCounts` from every resolved move (`src/model.ts:675-680`), extractions included. It feeds `originShared` (per file, around `:683`) and the cheap pre-check `originDeleted` (`src/model.ts:689-696`), which repeats `!reviewPaths.has(move.from)` before calling the filesystem walk `isAbsentAtExactCase`.
- `currentShaByPath` (`src/model.ts:669`) holds working-tree shas for review-set paths that exist on disk. `deleted = !currentShaByPath.has(path)`.
- The comment at `src/model.ts:620-623` says the review-set check in `selectReviewSnapshot` guards a `from` that is its own row on a case-insensitive filesystem. Keep that guard: a case-renamed `from` that is its own row passes `existsSync`, so it is hashed into `currentShaByPath` and is "live".
- Design decision (spec): replace the `selectReviewSnapshot` input `reviewPaths: ReadonlySet<string>` with `liveReviewPaths: ReadonlySet<string>`, meaning review-set paths present in the working tree (`new Set(currentShaByPath.keys())`). The clause becomes `!input.liveReviewPaths.has(move.from)`. The `originDeleted` pre-check uses the same set.
- `fromLines` is the extraction field (`src/clusters.ts:38-40`, `ResolvedMove.fromLines` at `src/model.ts:157-159`). An extraction itself never inherits (`move.fromLines === undefined` clause); that stays.
- When can `from` be its own deletion row? `adjustReviewSetForMoves` (`src/model.ts:181-252`) keeps the origin's deletion in the set when the destination existed at the merge base (an overwrite). A displaced git-rename source is also re-added, but that row is the detected source, not `move.from`, and it is unaffected.
- Owner decisions that reach this task: unmarking a moved file that inherits also drops the origin's key (`reviewSnapshotPaths`, `src/model.ts:106-113`), so when the origin is its own deletion row that row is unmarked too. This is accepted; do not change it. Marking the origin's deletion row currently overwrites its key with the deleted sentinel and so cancels inheritance. Task 01_02 fixes that; leave it alone here.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `computeReviewModel`: count only `move.fromLines === undefined` moves in `fromCounts`. Rename it if it helps (e.g. `wholeFileFromCounts`), and update the comment on `selectReviewSnapshot`'s `originShared` input to say "more than one whole-file move".
2. `computeReviewModel`: build `liveReviewPaths = new Set(currentShaByPath.keys())`. Use `!liveReviewPaths.has(move.from)` in the `originDeleted` pre-check in place of `!reviewPaths.has(move.from)`. Pass `liveReviewPaths` to `selectReviewSnapshot`. Delete `reviewPaths` if nothing else uses it.
3. `selectReviewSnapshot`: rename the input to `liveReviewPaths` and document it ("review-set paths present in the working tree; a `from` among them is its own live row"). Use it in the clause.
4. Update the comment at `src/model.ts:620-623` to say the guard is now `liveReviewPaths`.
4a. Update the diff-base precedence comment on `resolveFileBase` (`src/model.ts:318-320`): an overwrite destination that inherits a snapshot diffs against it (`useSnapshotBase` outranks the merge-base blob, `:352-356`), so the content it overwrote is no longer shown anywhere; the merge-base blob is the base only when there is no snapshot. Do not change the precedence itself.
5. `DEVELOPMENT.md:30` (the "moved file ... inherits" bullet): change "another move shares its `from`" to "another whole-file move shares its `from` (extractions naming it do not count)". Change "the deleted old path is still its own row (overwrite, displaced git-rename source)" to "the old path is still its own row and exists on disk; a row that is only the old path's deletion (an overwrite) no longer blocks it". Add one line saying that unmarking the moved file drops the origin row's snapshot too. Amend manual step 18 (`DEVELOPMENT.md:236`): its claim that the origin's content "is shown nowhere else" and that the destination diffs against its own merge-base blob holds only when the origin has no snapshot. Add: if the deleted origin held a snapshot, the destination inherits it and diffs `last reviewed ↔ working tree`, and the destination's overwritten merge-base content is then shown nowhere (accepted trade-off). Keep the docs terse (project CLAUDE.md: state each rule once).

## Gotchas

- Do not change `adjustReviewSetForMoves`: which rows exist stays the same.
- `originShared` must still block when two whole-file moves share a `from` (test "lends a deleted origin two declarations share to neither", `src/model.test.ts:~1140`, must stay green).
- The `select` test helper (`src/model.test.ts:315-332`) passes `reviewPaths`. Rename it to `liveReviewPaths` with default `["src/new.ts"]`.
- `isAbsentAtExactCase` stays the last condition in the pre-check (it hits the filesystem).
- Run `yarn format` before finishing; `.mise/` is in `.prettierignore`, so keep it there.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Unit tests in `src/model.test.ts`:
  - Keep "does not inherit from an origin another move shares" (`:412`) unchanged: `originShared: true` still yields `NOT_INHERITED`, since that input now means whole-file sharing.
  - Replace "does not inherit from an origin that is its own row" (`:432`) with two tests. With `liveReviewPaths: ["src/new.ts", "src/old.ts"]`, the result is `NOT_INHERITED` (live row). With `liveReviewPaths: ["src/new.ts"]` (old path is a deletion row, so not live), the result inherits.
  - Integration (pattern `src/model.test.ts:1141-1167`, `setUp` + `computeReviewModel` + `declaration(...)`):
    - A whole-file declaration `src/a.ts <- src/shared.ts` plus an extraction declaration `src/b.ts <- src/shared.ts` with `fromLines`, with `src/shared.ts` deleted and holding a snapshot. `a.ts` inherits (`inheritedSnapshotFrom === "src/shared.ts"`) and `b.ts` does not.
    - Overwrite: destination `src/dest.ts` exists at the merge base (`baseBlobs`), `changes` has `["M", "src/dest.ts"]` and `["D", "src/old.ts"]`, the review state holds `src/old.ts`, and the declaration is `src/dest.ts <- src/old.ts`. Both rows exist, `dest.ts` inherits with `diffBaseSha === REVIEWED_SHA`, and `pathsWithReviewSnapshot(model.files)` includes `src/old.ts` once per holder (expected order as returned).
    - Live own row: `from` is its own row and still on disk (in `changes` as `M` and in `workingShas`), so there is no inheritance.
- Existing case-only rename tests (`:1169`, `:1181`) and "does not inherit from a declared origin still on disk" (`:1193`) stay green.
