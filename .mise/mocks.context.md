# Mock Context

## Original Description

is it possible to do inline comments in the diff?

## Clarifying Q&A

1. What are the comments for? → **Notes + hand-off**: take notes while reviewing, with a way to hand
   them to Claude Code to act on.
2. Where should comments persist? → **Inside `.git`, per branch** (zero-footprint, like review state).
3. What happens when the commented code changes afterward? → **Keep the note, mark it outdated**
   (GitHub-style).
4. Which diff side(s), and replies? → **Right (working-tree) side only**; single note per thread, no
   replies.

## New Concepts

- **Review note** — an inline comment on a diff line. Familiar from PR review UIs and VS Code's native
  comment widget; no new visual language introduced.
- **Outdated** — a note whose underlying line changed after it was written (scenario 4). Familiar from
  GitHub's outdated comments; surfaced as a badge plus the original line text.
- **Hand-off** — a view-title action (scenario 6) that writes the branch's notes to a file under
  `.git/delta-review/` for the companion Claude Code skill to read. New to the product, but mirrors the
  existing clusters-contract pattern (Claude ⇄ extension via files under `.git`).

## UI Tweaks Log

(none yet)
