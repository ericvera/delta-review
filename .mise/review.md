# Review

## Tasks

- 01_01 (e48db10): auto-triaged files (`autoReview.globs`, linguist-generated) excluded from tree badge, status bar `Review x/y`, and Needs Review/Reviewed header counts via pure `src/reviewCounts.ts` (+ test); `publishModel` and tree headers use it; `__inspect` gains `fileBadge`/`statusBarText`; DEVELOPMENT.md updated. Verify: set `deltaReview.autoReview.globs` to `[".mise/**"]` on this branch — badge/status bar count only `src/` and `DEVELOPMENT.md` files; Auto subgroup still lists `.mise/` files.

## Open assumptions

- Auto subgroup row keeps its own count of auto files.
- Mark All, folder bulk actions and `autoReview.markAutomatically` unchanged.
- Only auto files unreviewed → badge cleared, status bar shows full progress.
- No mock: a count change is not a structural UI change.

## Amendments

- None.
