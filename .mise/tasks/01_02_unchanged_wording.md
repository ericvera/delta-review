# 01_02 Show the "unchanged" classification on moved rows

## Goal

In the Delta Review VS Code extension, render the new `"unchanged"` move classification: the row description ends `· unchanged`, the tooltip says `Unchanged since last reviewed`, and the tooltip no longer says `Changed since last reviewed` for such a file.

## Files to modify/create

- `src/moveDisplay.ts`
- `src/treeProvider.ts`

## Background

- Task 01_01 added `"unchanged"` to `MoveClassification` (`src/model.ts`). The model sets it when a moved file has a last reviewed snapshot (its own, or one inherited from its old path, `ReviewFile.inheritedSnapshotFrom`) and its working content equals that snapshot. Such a file with an inherited snapshot is Needs Review with `diffBaseIsReviewedSnapshot: true` and an empty diff; a Reviewed moved file with its own matching snapshot also reads `"unchanged"` (with `diffBaseIsReviewedSnapshot: false`).
- `"verbatim"` now appears only when the moved file has no snapshot at either path; `"adapted"` also covers "differs from the last reviewed snapshot".
- `classificationText` (`src/moveDisplay.ts:95-100`) renders `· verbatim` / `· adapted`, nothing otherwise; used by `buildRowDescription` (row) for both plain moves and extractions (:158, :182).
- `buildTooltipStatusLine` (`src/moveDisplay.ts:281-322`) pushes `Identical to the origin` / `Identical to the extracted lines` for verbatim, then out-of-range / unavailable warnings. The unavailable warning is guarded by `lines.length === 0` (:315), which would hide it behind the new unchanged line. Case that matters: a Reviewed moved file (own snapshot equals working sha, so no snapshot base) with no merge-base blob at its path and no origin blob has `originContentUnavailable` true and classification `"unchanged"`; its diff shows the whole file against an empty base, so the warning must still show.
- `src/treeProvider.ts:547-558` stacks the tooltip: status line, `Deleted from the working tree`, then `Changed since last reviewed` when `file.diffBaseIsReviewedSnapshot`.
- The test hook `deltaReview.__inspect` (`src/extension.ts:1345-1370`) reuses `buildRowDescription`, so it picks up the word automatically.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `classificationText`: render `· ${classification}` for `"verbatim"`, `"adapted"` and `"unchanged"`; still `undefined` for `"unknown"`/`undefined`. The row-length threshold logic is generic; do not special-case it.
2. `buildTooltipStatusLine`: when `moveClassification === "unchanged"`, push `Unchanged since last reviewed` first (where the verbatim line goes; the two are exclusive). Change the unavailable branch's guard from `originContentUnavailable && lines.length === 0` to `originContentUnavailable && moveClassification !== "verbatim"`, so both warnings follow the unchanged line. Update the function's comment: the unchanged line is followed by either warning; only verbatim excludes the unavailable warning (verbatim needs an origin base).
3. `src/treeProvider.ts`: change the condition to `file.diffBaseIsReviewedSnapshot && file.moveClassification !== "unchanged"` with a one-line comment (an unchanged file has nothing changed since its review).

## Gotchas

- No tree structure, command, or `package.json` change.
- `src/treeProvider.ts` imports `vscode` and has no unit tests; keep the change to the one condition.

## Verification

- Run: `yarn lint`, `yarn build`, `yarn test`.
- Write in `src/moveDisplay.test.ts`:
  - `describe("classification wording")` (:349): appends the unchanged word for a repo move (`src/api ← src/util/backoff.ts · unchanged`), and for an extraction row (`← big.ts:120-180 · unchanged` form, following existing extraction tests).
  - `describe("buildTooltipStatusLine")` (:714): `"unchanged"` returns `Unchanged since last reviewed`; with `originLinesOutOfRange` true it is followed by the out-of-range line; with `originContentUnavailable` true it is followed by `Origin content is no longer available — showing the whole file.`; existing verbatim/unavailable expectations stay green.
- The `treeProvider.ts` condition has no unit test (vscode import); verified by `yarn build` and by reading the diff.
