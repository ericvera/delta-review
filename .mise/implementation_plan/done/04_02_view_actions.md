# Task 4.2: View actions — navigation, clear resolved, live updates, branch switching

## Goal

Finish the REVIEW NOTES view: click-to-diff navigation revealing the thread (with plain-file
fallback), a Clear Resolved title action, verified live updates, and branch/repo switching.

## Requirements addressed

REQ-VIEW-4, REQ-VIEW-5, REQ-VIEW-6, REQ-VIEW-8, REQ-LIFE-6

## Background

The feature: inline review notes overseen from the REVIEW NOTES SCM section. Prior tasks:
- Task 4.1 — `src/notesTreeProvider.ts` (elements `fileGroup`/`note`), view `deltaReviewNotes`,
  stub command `deltaReview.openNoteInDiff`, badge, welcome state.
- Task 2.1 — `src/notesStore.ts`: `deleteNote`; notes are per-branch (`notesFileName(branch)`).
- Task 3.x — extension `refresh()` merges threads and re-renders controller + view together.

Existing navigation machinery:
- `openDiff` `src/extension.ts:371-399`: takes a `ReviewFile`, builds left
  `createReviewBaseUri(leftPath, diffBaseSha)` / right `Uri.file(join(git.repoRoot, path))`, runs
  `vscode.commands.executeCommand("vscode.diff", left, right, title)`. `vscode.diff` accepts a 4th
  `TextDocumentShowOptions` argument — pass `{ selection: new vscode.Range(line, 0, line, 0) }` to
  reveal a line.
- The current `ReviewModel` (`model` variable, `extension.ts:41`) maps `note.file` → `ReviewFile`
  (fields `src/model.ts:17-35`).
- Branch/repo switching: `refresh()` recomputes `model.branch` and the notes portion loads
  `notes-<branch>.json` per run — switching is free if the notes state is keyed off the refreshed
  branch (verify, don't cache branch anywhere else). Repo switching flows through `setActiveRepo`
  `extension.ts:356-369`.
- Title menus: `view/title` pattern `package.json:131-157` with `when: "view == deltaReviewNotes"`.

## Files to modify/create

- `src/extension.ts` — real `deltaReview.openNoteInDiff`, `deltaReview.clearResolvedNotes`
  registration.
- `src/notesTreeProvider.ts` — context values already set (Task 4.1); no structural change
  expected.
- `package.json` — command declarations (`clearResolvedNotes` icon `$(clear-all)`), `view/title`
  entry, palette hiding for `openNoteInDiff`.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. **`openNoteInDiff(thread)`** (REQ-VIEW-4):
   - Find `ReviewFile` for `thread.note.file` in the current `model`.
   - Found → run the same flow as `openDiff` (`extension.ts:371-399`) with the selection option at
     `currentStartLine - 1`; after the diff opens, set that note's `vscode.CommentThread`
     `collapsibleState = Expanded` (thread cache from Task 3.1) — the approximated reveal
     (overview Assumption; no stable `thread.reveal()` in 1.90).
   - Base-side notes: selection targets the left document's line — `vscode.diff` selection applies
     to the modified (right) side; acceptable approximation: still pass the line, the expanded
     thread on the left is the visible cue. Note this in a code comment.
   - Deleted file still in the review set → open its deletion diff (right side
     `createReviewBaseUri(path, undefined)`, as `openDiff` does `extension.ts:382-384`); the thread
     attaches to that same URI (Task 3.1's deleted-file rule), so it renders and expands there.
   - Not in the review set (file left the set — requirements Assumption) → open the plain file via
     `vscode.window.showTextDocument(Uri.file(join(git.repoRoot, file)), { selection })`; deleted
     from disk too → info toast "file no longer exists; note kept".
2. **Clear Resolved** (REQ-VIEW-6, REQ-LIFE-6): `clearResolvedNotes` deletes every note with
   status resolved for the current branch (store `deleteNote` batch — add a
   `deleteNotes(git, branch, ids)` helper if single-delete looping would rewrite the file N times),
   then refresh. No confirmation modal (matches mock 6A 🧹; resolved notes are already confirmed
   twice).
3. **Live updates** (REQ-VIEW-5): nothing new — verify the Task 3.3/4.1 wiring covers: reviewer
   actions (create/edit/resolve), agent responses (watcher), and re-anchoring after edits
   (repo-root watcher → refresh). Fix anything that only updates the controller but not the view.
4. **Branch/repo switching** (REQ-VIEW-8): verify the notes load path derives branch from the
   *current* refresh's `computed.branch` (`extension.ts:202-256` flow) and repo from the current
   `git` — no stale caches. Multi-repo: `setActiveRepo` already funnels through `refresh()`.

## Testing suggestions

- Manual, F5 dev host:
  1. Click an open note in REVIEW NOTES → review diff opens, cursor at the note's line, thread
     expanded (REQ-VIEW-4).
  2. Click a note on a file that left the review set (revert its change) → plain file opens at the
     line.
  3. Click a base-side note → diff opens, thread visible on the left.
  4. Resolve two notes, Clear Resolved (🧹) → both gone from view, diff, and notes file; open notes
     untouched.
  5. Agent appends a response (hand-edit responses file) → row icon flips to addressed without any
     manual refresh (REQ-VIEW-5).
  6. Switch branches (`git switch` other branch with its own notes) → view swaps note sets;
     switch repos in the SCM REPOSITORIES picker (if multi-repo workspace available) → same
     (REQ-VIEW-8).

## Gotchas

- `vscode.diff`'s options argument is positional 4th — passing it as part of the title breaks the
  command silently.
- Expanding the thread must happen *after* the diff editor exists; a short
  `onDidChangeVisibleTextEditors`-based wait or a `setTimeout(0)` after the await is acceptable —
  do not busy-wait.
- `clearResolvedNotes` must skip the anchor-ref rewrite when no notes were deleted (idempotence
  guard from Task 2.1 covers the file; the ref helper should early-return on unchanged blob sets).
- Branch switch fires multiple refreshes (HEAD change + watcher burst) — the generation counter
  (`extension.ts:183-205`) already serializes; don't add locks.

## Verification checklist

- [ ] Manual dev-host checks 1–6 above pass.
- [ ] `yarn lint`, `yarn build`, `yarn test` pass.
- [ ] End-to-end tests: Test exception applies (no e2e infrastructure exists — verify with unit
      tests plus manual verification in the F5 Extension Development Host): manual checks above are
      the substitute verification.
