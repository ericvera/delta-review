# Review

## Tasks

- 01_01 (e48db10): auto-triaged files (`autoReview.globs`, linguist-generated) excluded from tree badge, status bar `Review x/y`, and Needs Review/Reviewed header counts via pure `src/reviewCounts.ts` (+ test); `publishModel` and tree headers use it; `__inspect` gains `fileBadge`/`statusBarText`; DEVELOPMENT.md updated. Verify: set `deltaReview.autoReview.globs` to `[".mise/**"]` on this branch — badge/status bar count only `src/` and `DEVELOPMENT.md` files; Auto subgroup still lists `.mise/` files.
- 02_01 (69a1400): removed `deltaReview.autoReview.markAutomatically` and its auto-mark path in `refresh()` (package.json, src/extension.ts, DEVELOPMENT.md incl. manual-test renumbering, README.md). Verify: setting no longer offered in Settings UI; auto files stay unreviewed and uncounted.
- Feedback (432fbd6): `.vscode/settings.json` sets `deltaReview.autoReview.globs: [".mise/**"]` for this repo.

## Open assumptions

- Auto subgroup row keeps its own count of auto files.
- Mark All and folder bulk actions unchanged.
- Only auto files unreviewed → badge cleared, status bar shows full progress.
- No mock: a count change is not a structural UI change.

## Amendments

- 2026-11-27 Remove `markAutomatically` (redundant once auto files stop counting) — 02_01.
