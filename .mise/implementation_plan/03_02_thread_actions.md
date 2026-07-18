# Task 3.2: Thread actions — edit, delete, resolve, unresolve, reply-to-reopen

## Goal

Complete the in-diff interaction set on note threads: edit/delete reviewer turns, delete whole
threads, resolve/unresolve, and the reply box on addressed threads that reopens the note.

## Requirements addressed

REQ-NOTE-6, REQ-NOTE-7, REQ-LIFE-3, REQ-LIFE-4, REQ-LIFE-7

## Background

The feature: inline review notes with an open → addressed → resolved lifecycle. Prior tasks:
- Task 1.1 — `src/notes.ts` types; Task 1.3 — `src/noteThreads.ts` (`mergeThreads`; status = last
  speaker, stored resolved wins).
- Task 2.1 — `src/notesStore.ts`: `appendReviewerTurn`, `editReviewerTurn`, `deleteNote`,
  `setResolved(id, resolved)`.
- Task 3.1 — `src/commentController.ts`: controller id `deltaReview.notes`, thread cache keyed by
  note id, `renderThreads`, thread `contextValue` = `openNote|addressedNote|resolvedNote`, comment
  objects per turn; `deltaReview.addNote` command; extension wiring calls render inside `refresh()`.

VS Code comment menus (all `when`-gated; see `package.json:130-259` for the project's menu style):
- `comments/comment/title` — icons on an individual comment (edit ✎ `$(edit)`, delete 🗑
  `$(trash)`); gate with `comment == reviewerTurn` (set `Comment.contextValue` on reviewer turns
  only — agent turns get none, so no edit/delete affordance on Claude's replies).
- `comments/comment/context` — Save/Cancel while a comment is in `CommentMode.Editing`.
- `comments/commentThread/title` — thread-header actions: Resolve `$(check)`, Unresolve
  `$(debug-restart)`, Delete Thread `$(trash)`; gate with
  `commentController == deltaReview.notes && commentThread =~ /openNote|addressedNote/` etc.
- `comments/commentThread/context` — the reply-submit button ("Reply & Reopen") next to the input:
  `commentController == deltaReview.notes && !commentThreadIsEmpty && commentThread == addressedNote`.
  The box's visibility itself is `thread.canReply`.

## Files to modify/create

- `src/commentController.ts` — command handlers + `canReply`/mode plumbing.
- `src/extension.ts` — register the new commands (`deltaReview.editNoteTurn`,
  `deltaReview.saveNoteTurn`, `deltaReview.cancelNoteTurn`, `deltaReview.deleteNoteTurn`,
  `deltaReview.deleteNoteThread`, `deltaReview.resolveNote`, `deltaReview.unresolveNote`,
  `deltaReview.replyReopen`).
- `package.json` — command declarations (icons per above), the four `comments/*` menu blocks,
  palette hiding.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. **Edit** (REQ-NOTE-6): `editNoteTurn(comment)` flips that comment's `mode` to
   `CommentMode.Editing` (re-assign `thread.comments` — the API requires replacing the array).
   `saveNoteTurn` persists via `editReviewerTurn` and re-renders; `cancelNoteTurn` re-renders
   (discard). Editing never changes status (status derives from last *speaker*, and outdated is
   untouched — requirements Assumptions).
2. **Delete turn / thread** (REQ-NOTE-6): `deleteNoteTurn` removes one reviewer turn — if it was the
   only reviewer turn, delete the whole note instead (a note MUST have ≥1 reviewer turn — Task 1.1
   parser invariant). `deleteNoteThread` calls `deleteNote` at any status; thread disposes on
   re-render.
3. **Resolve / unresolve** (REQ-LIFE-3/7): `resolveNote` → `setResolved(id, true)` — allowed from
   any status, sets native `CommentThreadState.Resolved` on render. `unresolveNote` →
   `setResolved(id, false)`; status re-derives from last speaker (Task 2.1 does the recompute).
   Show Resolve on `openNote|addressedNote` threads and on the addressed reply row (mock 5A shows a
   Resolve button); Unresolve only on `resolvedNote`.
4. **Reply-to-reopen** (REQ-LIFE-4): `thread.canReply = (status === "addressed")` in
   `renderThreads` (open: the reviewer edits their turn instead; resolved: unresolve first,
   REQ-LIFE-7). `replyReopen(reply: CommentReply)` → `appendReviewerTurn` → status derives back to
   open on render. Menu title: "Reply & Reopen". There is deliberately NO command that reopens
   without text.
5. Every mutation goes store → full re-render (reuse the Task 3.1 render path + generation guard);
   failures surface the REQ-NOTE-4-style error toast and leave state untouched.
6. Review-state isolation (REQ-NOTE-7): none of these handlers touch `markReviewed`/
   `unmarkReviewed`; nothing in `reviewState.ts` changes in this task.

## Testing suggestions

- Manual, F5 dev host:
  1. Edit a note's text via ✎ → save → text updates, status unchanged (open stays open).
  2. Delete a single-turn note via 🗑 → thread disappears; notes file no longer lists it.
  3. Hand-write a response entry into `.git/delta-review/responses-<branch>.json` (valid schema,
     matching noteId) → thread shows Claude reply, label "Addressed", reply box visible with
     "Reply & Reopen".
  4. Reply → status back to "Open", turn appended (mock 5B); reply box gone (open threads don't
     offer it).
  5. Resolve from open and from addressed → native resolved rendering (mock 6A ✓); Unresolve →
     status re-derives correctly (addressed if last turn was Claude's).
  6. Delete an addressed thread (agent turns included) → gone (REQ-NOTE-6).
  7. Mark a noted file reviewed → note unchanged (content/turns/status), review state unaffected by
     note actions (REQ-NOTE-7).

## Gotchas

- `thread.comments` is immutable-by-reassignment: always `thread.comments = [...]`, never mutate in
  place — edits won't render otherwise.
- `CommentReply` handlers must read `reply.thread` to find the note id — keep a
  `WeakMap<CommentThread, string>` or stash the id on the thread's `contextValue` suffix; the
  Task 3.1 cache maps id→thread, also maintain the reverse.
- Icons on comment/thread menus require the command's `icon` field in `package.json` (codicons:
  `$(edit)`, `$(trash)`, `$(check)`, `$(debug-restart)`).
- Deleting the reply-less path: do not enable `canReply` on open threads even temporarily during
  render churn — flicker invites accidental "second reviewer note" flows that the model forbids.

## Verification checklist

- [ ] Manual dev-host checks 1–7 above pass.
- [ ] `yarn lint`, `yarn build`, `yarn test` pass.
- [ ] End-to-end tests: Test exception applies (no e2e infrastructure exists — verify with unit
      tests plus manual verification in the F5 Extension Development Host): manual checks above are
      the substitute verification.
