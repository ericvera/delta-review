# Mock Context

## Original Description

Currently when a file is moved it is hard to tell that it was moved or look at the diff (if any) vs, just moved. Is there something we can do to see that it is a move and only see that it is either a move or the diff on top of the move?

## Clarifying Q&A

1. How should a move render in the review list?
   - **Answer: 1a** — one row at the new path with an `R` badge and the old path dimmed in the row description; the old path's `D` row disappears.
2. Should a pure move (content 100% identical) still require review like any other file?
   - **Answer: 2a** — yes, a normal needs-review row; the empty diff makes it a one-glance confirm. Not routed to Auto, not auto-marked.
3. For moves git can't detect (new path untracked, e.g. moved via Finder), how far should detection go?
   - **Answer: rely on git entirely** — use git's rename detection (`git diff --find-renames`), no custom exact-sha or similarity matching. Untracked moves keep today's D + A rendering until staged; heavy rewrites below git's similarity threshold degrade to D + A as git intends.

## New Concepts

- **`R` (moved/renamed) row** — not new to the user: identical to the built-in git Changes view's staged-rename rendering (single row, R badge, renamed decoration color). The only Delta-Review-specific addition is showing the origin path dimmed in the row description (`new-dir ← old/path` in list mode, `← old/path` in tree mode), an extension of the existing directory-description convention.

## UI Tweaks Log

(empty — no feedback yet)
