# Goals — Inline review notes in the diff

Original description: "is it possible to do inline comments in the diff?" — Answer: yes, via VS Code's
native Comments API (`vscode.comments.createCommentController` + `commentingRangeProvider`), which works
in diff editors including the extension's virtual `delta-review-base` left side. This work builds it.

## Goals

- While reviewing a diff opened from the Delta Review panel, the reviewer can add an inline note on a
  line or range of the **right (working-tree) side only**, using VS Code's native comment UI (the `+`
  gutter and thread widget).
- One note per thread — no reply chains. Notes can be edited and deleted.
- Notes persist **per branch inside `.git`** (zero footprint, like review state): they survive window
  reloads, commits/amends/rebases, and travel across worktrees; never in the working tree, never pushed.
- When the underlying content of a noted line changes afterward, the note is **kept and marked
  outdated** (GitHub-style), not dropped or silently drifted.
- **Hand-off**: notes are both personal review notes and feedback to hand to Claude Code — there is an
  explicit hand-off mechanism that exposes all current notes (file, line, text, outdated flag) in a form
  Claude Code can act on.
- **Ownership**: a note is owned by (local clone, branch) — same owning entity as review state
  (`refs/review/<branch>`). Notes are keyed by branch name (not commit), anchor to file path + line +
  a snapshot of the line content (the basis for outdated detection), and live in the git common dir so
  every worktree of the clone sees the same notes for a branch. Not per-user, not per-machine-synced:
  never pushed, gone if the clone is deleted.

## Decisions (from clarifying Q&A)

1. Purpose: notes + hand-off to Claude Code (not personal-only, not hand-off-only).
2. Storage: inside `.git`, per branch.
3. Content drift: keep the note, mark it outdated.
4. Surface: right side only; single note per thread, no replies.

## Out of scope

- Comments on the base (left) side of the diff.
- Reply threads / multi-user discussion.
- Syncing to GitHub PR comments or any remote service.
