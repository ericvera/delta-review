# Review

## Tasks

- 01_01 (0869e5c) Note turns (reviewer + agent) render as markdown in threads and the REVIEW NOTES tooltip. Verify: add a note with `**bold**` and `` `code` ``; DEVELOPMENT.md step 46.
- 01_02 (d91bdda) Derived `pending` thread status: Pending label, `pendingNote` context, purple clock, reply box kept, stays in agent work set; persisted to notes file as "addressed". Verify: src/noteThreads.test.ts, src/threadRender.test.ts.
- 01_03 (15e7ab6) Responses entries accept optional `pending: true` (non-boolean rejected); Resolve/Reply/Delete menus gate on pending. Verify: append a response with `"pending": true` → thread shows Pending; Resolve and Reply & Reopen available.
- 01_04 (a723da4) Read/unread for pending: "Pending • Unread" thread label, bold (theme highlight, usually blue) row, Mark as Read ($(eye)) on thread title and row; dimmed clock once read; marks in workspace state `deltaReview.pendingReadMarks` per repo/branch, pruned on load. Verify: Mark as Read, reload window → stays read; new pending reply → unread again; badge counts both.
- 01_05 (1756c38) Contract (plugin/skills/review-notes/SKILL.md): `pending` key, Work set includes own pending replies, skip rules, responses-only schema exemption, markdown note; plugin 0.9.0; DEVELOPMENT.md (step 36a) and README updated. Verify: read SKILL.md Work set / Channel discipline / Schema changes.

## Open assumptions

- Pending clears on a non-pending agent reply, reviewer resolve, or reviewer reply (→ Open).
- Notes file stores pending as "addressed"; old extensions show Addressed.
- No purple thread accent, no unread dot (VS Code API limits); unread row label uses list.highlightForeground.
- No Mark as Unread; opening a thread does not mark it read.
- Reply button stays "Reply & Reopen" on pending notes.
- Blocked queued work: agent appends nothing and skips the note for the rest of the run (implementer addition).
- Raw markdown loses the hard-line-break height trick.
- Not verified in a running VS Code; prettier check on docs not run (permission denied on node_modules/.bin/prettier).
- Reviewer flagged the trimmed .claude/mise-config.md as a minor; declined — owner chose removal.

## Amendments

None.
