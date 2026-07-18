# Task 1.1: Pure status-filter and cluster body-state helpers

## Goal

Add the unit-testable core of the Reviewed-bucket feature to `src/clusters.ts`: helpers that filter a file list by review status and classify what a cluster's body should render, plus Vitest coverage.

## Requirements addressed

REQ-STRUCT-3, REQ-STRUCT-4, REQ-STRUCT-5, REQ-STRUCT-6, REQ-REV-1 (logic layer; rendering lands in Task 2.1)

## Background

Delta Review is a VS Code extension (SCM sidebar tree) for reviewing a branch's changes. Files have a derived status: `FileReviewStatus.NeedsReview` or `FileReviewStatus.Reviewed` (enum in `src/model.ts:12-15`). An optional "clusters contract" groups files into buckets; when grouping is on, the tree renders cluster buckets instead of the plain Needs Review/Reviewed groups.

The feature being built: in grouped mode, reviewed files stop rendering inside their cluster and instead render in a single **Reviewed** bucket at the bottom of the view. Clusters render only needs-review files; a cluster whose full membership is reviewed shows a dim message row `All files reviewed.`; a cluster with no members in the change keeps the existing message `No files from this cluster are in the current change.`.

`src/clusters.ts` is the home for pure cluster logic — it imports `FileReviewStatus`/`ReviewFile` from `./model` and never imports `vscode`, which is what makes it Vitest-testable (the `vscode` module cannot be imported under Vitest — see `.claude/mise-config.md` Test conventions). Existing precedent helpers there: `clusterContextValue(files)` (clusters.ts:84-93) and `clusterCountDescription(files, plainUntilFirstReviewed)` (clusters.ts:98-109), both taking `readonly ReviewFile[]`.

`src/clusters.test.ts` already tests these using two factories (`src/clusters.test.ts:21-35`): `file(path, triage = "normal")` builds a needs-review `ReviewFile` and `reviewedFile(path, triage = "normal")` a reviewed one — follow their style; the new tests will need both.

## Files to modify/create

- `src/clusters.ts` — add three exported pure helpers.
- `src/clusters.test.ts` — add tests for them.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. In `src/clusters.ts`, near `clusterContextValue`, add:
   - `filesWithStatus(files: readonly ReviewFile[], status: FileReviewStatus): ReviewFile[]` — order-preserving filter. (Note: `ReviewTreeProvider` has a private method of the same name; this new export is the pure sibling. If the name shadows confusingly, `filterByStatus` is fine — pick one and use it consistently in Task 2.1.)
   - `clusterBodyState(files: readonly ReviewFile[]): "no-files" | "all-reviewed" | "has-needs-review"` — `"no-files"` when the list is empty, `"all-reviewed"` when non-empty with zero needs-review members, else `"has-needs-review"`. This drives which body a real cluster renders.
2. Add a doc comment on each in the file's existing comment style (see the block comments above `clusterContextValue` and `clusterCountDescription`).
3. In `src/clusters.test.ts`, add a `describe` block per helper using the existing `reviewFile` factory:
   - `filterByStatus`/`filesWithStatus`: mixed list (built from `file(...)` and `reviewedFile(...)`) returns only matching, preserves order; empty input → empty output; both statuses covered.
   - `clusterBodyState`: `[]` → `"no-files"`; all reviewed → `"all-reviewed"`; mixed → `"has-needs-review"`; all needs-review → `"has-needs-review"`.

## Testing suggestions

- `yarn test` — new tests plus the existing suite green.
- Test exception (config): these helpers are consumed by extension-host rendering verified manually in later tasks; unit tests here are the full automated coverage for this task.

## Gotchas

- Keep the helpers operating on `readonly ReviewFile[]` and returning new arrays — `resolveClusterModel` keeps `ReviewFile` objects by reference and callers rely on `model.files`' path-sorted order surviving filters.
- Do not touch `clusterContextValue` or `clusterCountDescription`: counts and header bulk actions intentionally stay derived from full membership (REQ-COUNT-1, REQ-FLOW-4).

## Verification checklist

- [ ] `yarn test` passes with the new describe blocks included
- [ ] `src/clusters.ts` still has no `vscode` import
- [ ] End-to-end tests: none — config Test exception (no e2e infrastructure); covered by the unit tests above and manual dev-host verification in Tasks 2.1/2.2
