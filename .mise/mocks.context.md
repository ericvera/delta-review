# Mock Context

## Original Description

is it possible to do inline comments in the diff?

## Clarifying Q&A

1. What are the comments for? → **Notes + hand-off**: take notes while reviewing, with a way to hand
   them to Claude Code to act on.
2. Where should comments persist? → **Inside `.git`, per branch** (zero-footprint, like review state);
   owning entity is (local clone, branch), stored in the git common dir so all worktrees share them.
3. What happens when the commented code changes afterward? → **Keep the note, mark it outdated**
   (GitHub-style, showing the original line text).
4. Which diff side(s)? → Initially right-only; **revised to both sides** after discussing that
   left-side (base) notes enable actionable feedback on deleted code.
5. Replies? → One human note per thread; **agent responses render as replies** in the same thread. No
   human discussion chains.
6. Agent interaction? → **Storage is the contract**: notes file under `.git/delta-review/` is read by a
   new `review-notes` companion skill; the agent writes a separate responses file (one writer per
   file); the extension's existing directory watcher shows progress live. **No ⇪/export button** —
   trigger is a plain prompt ("address my review notes").
7. Done flow? → **Open → addressed → resolved**: agent marks addressed with a response; reviewer
   resolves to confirm (or resolves directly anytime). Resolved notes leave the agent's work set.
8. Notes overview? → **Sibling REVIEW NOTES section** in the SCM sidebar at the same level as DELTA
   REVIEW (chosen over built-in Comments panel after trade-off comparison: the panel can't navigate
   into the review diff and only shows two states).

## New Concepts

- **Review note** — an inline comment on a diff line. Familiar from PR review UIs and VS Code's native
  comment widget; no new visual language introduced.
- **Outdated** — a note whose underlying line changed after it was written (scenario 4). Familiar from
  GitHub's outdated comments; badge plus the original line text.
- **Note status: open / addressed / resolved** — lifecycle (scenarios 3A, 5, 6A). "Addressed" (agent
  acted, awaiting reviewer confirmation) is the one genuinely new state; open/resolved are familiar
  from every review tool.
- **REVIEW NOTES section** — a sibling SCM sidebar section (scenario 6A); same visual grammar as the
  existing DELTA REVIEW tree.
- **Agent contract via `.git` files** — not user-visible UI; mirrors the existing clusters-contract
  pattern (Claude ⇄ extension via files under `.git/delta-review/`).

## UI Tweaks Log

- Scenario 5 clarified: an addressed response may carry an optional anchor (file/line/snapshot) to the
  new code; the thread relocates there and OUTDATED is suppressed (expected change). Fallback without
  an anchor is the normal content re-mapping.

- v1 had a ⇪ "hand off notes to Claude" title button with success/nothing toasts (scenarios 6A/6B) —
  removed: no export step exists; the storage file is the contract and the trigger is a prompt.
- v1 was right-side-only commenting — v2 shows the + gutter on both sides (scenario 1) and adds a
  left-side note on deleted code (scenario 3B).
- v2 adds lifecycle badges (OPEN/ADDRESSED/RESOLVED), a Resolve action on threads, the in-thread
  Claude reply (scenario 5), and the sibling REVIEW NOTES section with per-note status icons and an
  empty state (6A/6B), replacing v1's hand-off toasts.
