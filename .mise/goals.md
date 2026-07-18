# Goals — Inline review notes in the diff

Original description: "is it possible to do inline comments in the diff?" — Answer: yes, via VS Code's
native Comments API (`vscode.comments.createCommentController` + `commentingRangeProvider`), which works
in diff editors including the extension's virtual `delta-review-base` left side. This work builds it.

## Goals

- While reviewing a diff opened from the Delta Review panel, the reviewer can add an inline note on a
  line or range of **either side**: the right (working-tree) side anchors to file + line; the left
  (base) side anchors to the base blob — enabling notes on deleted/old code.
- One human note per thread (editable, deletable). The agent's responses render as replies in the same
  thread; no human-to-human discussion model.
- Notes persist **per branch inside `.git`** (zero footprint, like review state): they survive window
  reloads, commits/amends/rebases, and travel across worktrees; never in the working tree, never pushed.
- **Ownership**: a note is owned by (local clone, branch) — same owning entity as review state
  (`refs/review/<branch>`). Notes are keyed by branch name (not commit), anchor to file path + side +
  line + a snapshot of the line content (the basis for outdated detection), and live in the git common
  dir so every worktree of the clone sees the same notes for a branch. Not per-user, not
  per-machine-synced: never pushed, gone if the clone is deleted.
- When the underlying content of a noted line changes afterward, the note is **kept and marked
  outdated** (GitHub-style), not dropped or silently drifted.
- **Anchoring is content-based, not line-based.** A right-side note stores its line number, the line's
  text (`lineSnapshot`), and the blob sha of the file at note time (written to the git object store via
  `hash-object -w`, like review snapshots — deduped across notes). On every refresh the extension
  diffs the creation blob against the current file and maps each note's line through the hunks
  independently: notes above/below edits shift correctly, notes whose anchored line was itself edited
  or deleted become OUTDATED (pinned near the closest surviving line, snapshot shown). This keeps
  multiple notes in one file correct across agent edits, reloads, and edits made while no editor was
  open. Left-side notes anchor to the immutable base blob and never move. The agent likewise locates
  targets by `lineSnapshot` content, not raw line numbers, and responds by note id.
- **Lifecycle**: open → addressed → resolved. The agent marks a note *addressed* with a response when it
  acts on it; the reviewer *resolves* it to confirm (or resolves directly at any time). Resolved notes
  drop out of the agent's work set. Rendered with VS Code's native resolved/unresolved thread states
  plus an addressed indicator.
- **Agent interface — the storage is the contract** (no export step, no hand-off button):
  - The extension persists notes to a versioned JSON file under `<git-common-dir>/delta-review/`
    (exact filename decided in requirements; the extension already watches this directory).
  - A new companion skill **`review-notes`** (in `plugin/skills/`, alongside `cluster-review`, same
    marketplace) documents the contract for agents: where the notes file is, its schema, how to act on
    open notes, and how to respond.
  - The agent writes to a **separate responses file** it owns in the same directory (per note id:
    status + response text). One writer per file — no conflicts. The extension merges by note id and
    the existing directory watcher makes agent progress appear **live**: threads grow the agent's
    reply, statuses flip to addressed as it works.
  - Trigger is a plain prompt to Claude Code ("address my review notes") — the skill description
    matches it. No button in the extension.
- **Sibling REVIEW NOTES view**: a second section in the SCM sidebar at the same level as DELTA REVIEW
  (second entry under `contributes.views.scm`): notes grouped by file, open/addressed/resolved status
  icons and counts, click a note → opens the review diff at that note's line. This is where agent
  progress is watched. The existing tree keeps small 💬 counts on file rows. (VS Code's built-in
  Comments panel also lists the threads automatically — free, untouched.)

## Decisions (from clarifying Q&A)

1. Purpose: notes + hand-off to Claude Code (not personal-only, not hand-off-only).
2. Storage: inside `.git`, per branch, in the git common dir.
3. Content drift: keep the note, mark it outdated.
4. Sides: **both** — right side anchors to working tree, left side to the base blob (notes on deleted
   code are actionable by the agent). [Revised from an earlier right-side-only pick.]
5. Lifecycle: open → addressed → resolved (two-step confirmation).
6. Agent interface: always-live storage-as-contract, **no ⇪/export button**; `review-notes` companion
   skill; agent-owned responses file merged by id.
7. Notes overview: dedicated sibling REVIEW NOTES SCM section (chosen over relying on the built-in
   Comments panel, which can't navigate into the review diff or show the addressed state).

## Out of scope

- Human reply chains / multi-user discussion (threads hold one human note + agent responses).
- Syncing to GitHub PR comments or any remote service.
- Cross-machine sync of notes.
