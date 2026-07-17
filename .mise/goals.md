# Goals: Show file moves as moves

## Original request

Currently when a file is moved it is hard to tell that it was moved or look at the diff (if any) vs, just moved. Is there something we can do to see that it is a move and only see that it is either a move or the diff on top of the move?

## Current behavior

`computeReviewModel` runs `git diff --name-only --no-renames`, so a moved file appears as two unrelated rows: a `D` (deleted) row at the old path with a full-red diff, and an `A` (added) row at the new path with a full-green diff. Both count toward review, and nothing links them.

## Goal

Detected moves render the way the built-in git Changes view renders staged renames:

- **One row** at the **new path**; the old path gets no row of its own.
- The row carries an **`R` badge** (renamed decoration color) instead of A/D, and shows the **old path dimmed in the row description** so the move is visible at a glance.
- Opening the row diffs **old-path content at the diff base ↔ new working-tree file**: a pure move shows an empty ("no changes") diff; a move-plus-edit shows only the edits on top of the move.

## Decisions (clarifying Q&A)

1. **Rendering** — single row at the new path with `R` badge and old path in the description; the old path's `D` row disappears. (Chosen over keeping two linked rows.)
2. **Pure moves** (content 100% identical) — remain **normal needs-review rows**; the empty diff makes them a one-glance confirm. They are NOT routed to the Auto bucket and NOT auto-marked.
3. **Detection is git's job** — rely entirely on git rename detection (`git diff --find-renames`, default similarity threshold). We do not build our own exact-sha or similarity matching. Consequences accepted:
   - A move done outside git (new path untracked, e.g. via Finder) keeps today's D + A rendering until both sides are staged — same blind spot as the built-in Changes view.
   - A move with heavy edits that falls below git's similarity threshold degrades to separate D + A rows — git behaving as designed.

## Scope notes

- Review state / mark-reviewed semantics follow the single row: the move is reviewed as one unit keyed by the new path.
- Out of scope: custom similarity heuristics, rename detection for untracked files, directory-level move aggregation.
