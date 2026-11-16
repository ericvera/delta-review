# 01_04 Read/unread for pending notes (Mark as Read)

## Goal

Give pending notes a workspace-local read/unread state.
- A new pending reply is unread: a purple clock, a bold row label, the thread label "Pending • Unread", and the tooltip "Status: pending (unread)".
- The reviewer marks it read with **Mark as Read** (`$(eye)`), offered on the thread title bar and on the REVIEW NOTES row only while unread.
- Once read: a dimmed clock, the label "Pending", and the tooltip "Status: pending".
- Opening or expanding a thread never marks it read.
- A later pending reply is unread again.

## Files to modify/create

- src/pendingRead.ts (new)
- src/extension.ts
- src/commentController.ts
- src/notesTreeProvider.ts
- package.json

## Background

Prior tasks produced:
- `src/noteThreads.ts`: `ThreadStatus` (includes `"pending"`), `ThreadTurn.pending?: true`, `deriveThreadStatus`, `NoteThread.status: ThreadStatus`. `mergeThreads` derives pending from `ResponseEntry.pending` (01_03).
- `src/commentController.ts`:
  - `statusLabels` and `statusContextValues` are `Record<ThreadStatus, string>`, with `pending → "Pending" / "pendingNote"`.
  - `styleThread` (around `:285-321`) composes the label as `statusLabels[status] + (outdated ? " • Outdated" : "")` and writes only the fields that changed.
- `src/notesTreeProvider.ts`: `noteIcon` has a pending case (purple `clock`). The tooltip line is `Status: ${thread.status}` and the row `contextValue` is `noteRow-${thread.status}`.
- `package.json` `when` clauses already accept `pendingNoteUnread` and `noteRow-pendingUnread` for Resolve, Delete and Reply & Reopen (01_03).

Existing patterns:
- Workspace state use: `src/extension.ts:113-120` (collapsed set: `context.workspaceState.get` / `update`).
- Controller construction: `src/extension.ts:276-281` (`createNoteCommentController(() => git, () => model, () => void refresh())`). Factory signature at `src/commentController.ts:136-140`.
- Tree provider construction: `src/extension.ts:175` (`new NotesTreeProvider((key) => collapsed.has(key))`).
- `renderNoteThreads` at `src/extension.ts:290-306` fans out to both surfaces and the badge. `currentNoteThreads` holds the last render.
- The only successful-load render is `src/extension.ts:569` (`renderNoteThreads(mergeThreads(refreshed, responses, anchorResolves))`), with `computed.branch` in scope.
- Thread-level command pattern: `resolveNote` registered at `src/extension.ts:1280-1284`, delegating to the controller, whose `setNoteResolved` looks up `threadNoteIds.get(threadOf(target))`.
- Row command pattern: `resolveNoteRow` at `src/extension.ts:1419-1422` (element `NotesTreeElement`, guard `element?.kind === "note"`).
- Command palette hiding: the `"commandPalette"` array in `package.json` (around `:520-575`, entries with `"when": "false"`).

Design decisions:
- Read state is never written to the notes or responses files.
- Key `deltaReview.pendingReadMarks`, value `Record<branch, Record<noteId, agentTurnAt>>`.
- A note is unread iff its status is `pending` and its mark is not equal to its newest agent turn's `at`.
- Prune the current branch's marks to note ids present in the thread set, on a successful notes load only, and write only when something changed.
- On the same load, drop the entries of branches that no longer exist locally, so the map does not grow across deleted branches. Only run the git branch listing when the map has a key other than the current branch. Empty per-branch maps are dropped.
- The badge rule stays "not resolved", so every pending note counts, read or unread.
- No Mark as Unread.
- The context values are `pendingNote` (read), `pendingNoteUnread`, `noteRow-pending` (read) and `noteRow-pendingUnread`.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

1. `src/pendingRead.ts`: a pure module with no vscode import. Give it a header comment like the other pure modules.
   - `export type PendingReadMarks = Readonly<Record<string, string>>` (noteId → `at` of the agent turn the reviewer marked read).
   - `newestAgentTurnAt(thread: NoteThread): string | undefined` returns the `at` of the last agent turn in `thread.turns`.
   - `isPendingUnread(thread, marks): boolean` returns `thread.status === "pending" && marks[thread.note.id] !== newestAgentTurnAt(thread)`.
   - `withReadMark(marks, thread): PendingReadMarks` returns a new object with that note's entry set to `newestAgentTurnAt(thread)`. If there is none, it returns `marks` unchanged.
   - `prunedReadMarks(marks, threads): PendingReadMarks` keeps only entries whose id is a note in `threads`, and returns the same object when nothing was dropped.
   - `export type BranchReadMarks = Readonly<Record<string, PendingReadMarks>>` (branch → marks).
   - `prunedBranchMarks(all: BranchReadMarks, branch: string, threads: readonly NoteThread[], liveBranches: ReadonlySet<string> | undefined): BranchReadMarks` prunes `all[branch]` with `prunedReadMarks`, drops every other key not in `liveBranches` (when `liveBranches` is undefined, other keys are kept), and drops any key whose map is empty (including `branch`). It returns the same object when nothing changed.
2. `src/commentController.ts`:
   - Add a fourth factory parameter `pendingRead: { isUnread: (thread: NoteThread) => boolean; markRead: (thread: NoteThread) => void }`.
   - In `styleThread`, let `unread = pendingRead.isUnread(thread)`. The label is `statusLabels[status] + (unread ? " • Unread" : "") + (outdated ? " • Outdated" : "")`. The contextValue is `unread ? "pendingNoteUnread" : statusContextValues[status]`.
   - Add `markNoteRead: (target: vscode.CommentThread) => void` to the `NoteCommentController` interface and the returned object. It finds the note id via `threadNoteIds`, the entry via `threadCache`, and calls `pendingRead.markRead(entry.noteThread)`.
3. `src/notesTreeProvider.ts`:
   - Add a constructor parameter `isUnread: (thread: NoteThread) => boolean`.
   - For a pending note: unread → icon `clock` in `charts.purple`, label `{ label, highlights: [[0, label.length]] }` (a `vscode.TreeItemLabel`, which renders bold), contextValue `noteRow-pendingUnread`, tooltip status line `Status: pending (unread)`. Read → icon `clock` in `ThemeColor("disabledForeground")`, plain label, `noteRow-pending`, `Status: pending`.
   - `noteIcon` needs the unread flag. Change its signature accordingly and update its comment.
4. `src/extension.ts`:
   - Load the marks near the other workspace-state reads (`:113-140`) under key `deltaReview.pendingReadMarks`.
   - Keep `let notesBranch: string | undefined`, set to `computed.branch` at the `:569` render and to `undefined` at every `renderNoteThreads([])` site.
   - `isUnread = (thread) => isPendingUnread(thread, notesBranch === undefined ? {} : marks[notesBranch] ?? {})`. Pass it to `NotesTreeProvider` and the controller.
   - `markRead(thread)`: return if `notesBranch` is undefined. Otherwise set `marks = { ...marks, [notesBranch]: withReadMark(marks[notesBranch] ?? {}, thread) }`, call `void context.workspaceState.update(...)`, then `renderNoteThreads(currentNoteThreads)`.
   - At `:569`, before rendering, bind `const threads = mergeThreads(refreshed, responses, anchorResolves)`, replace `marks` with `prunedBranchMarks(marks, computed.branch, threads, liveBranches)`, then `renderNoteThreads(threads)`. Persist only if the result differs by identity.
   - `liveBranches`: when `Object.keys(marks).some((key) => key !== computed.branch)`, run `gitForNotes.run(["for-each-ref", "--format=%(refname)", "refs/heads"])` and build a set of each line with the `refs/heads/` prefix stripped (do not use `%(refname:short)`; it can print `heads/<name>` for ambiguous names). Otherwise pass `undefined`. Wrap that call in its own `try/catch` that falls back to `undefined`, so a git failure never reaches the notes-warning `catch`. Check `generation !== refreshGeneration` after the `await` and return if stale, as the surrounding code does.
   - Hold `marks` in a `let` (`BranchReadMarks`) so pruning can replace it.
   - Register `deltaReview.markNoteRead` (`(thread: vscode.CommentThread) => commentController.markNoteRead(thread)`) and `deltaReview.markNoteRowRead` (`(element?: NotesTreeElement) => element?.kind === "note" && markRead(element.thread)`).
   - Update the badge comment at `:295` to "Open, addressed and pending (read or unread) are not done; resolved notes are."
5. `package.json`:
   - Commands: `deltaReview.markNoteRead` and `deltaReview.markNoteRowRead`, each with title "Mark as Read", icon `$(eye)`, category "Delta Review".
   - Menus:
     - `comments/commentThread/title`: markNoteRead, when `commentController == deltaReview.notes && commentThread == pendingNoteUnread`, group `inline@0`.
     - `view/item/context`: markNoteRowRead, when `view == deltaReviewNotes && viewItem == noteRow-pendingUnread`, as both an `inline@0` entry and a `navigation` entry (mirror the resolveNoteRow pair).
     - `commandPalette`: hide both commands (`"when": "false"`).

## Gotchas

- Do not mark read on `expandThread`, `openNoteInDiff`, or tree selection.
- Branch keys are `computed.branch` (the abbreviated branch name), and they must match the stripped `refs/heads/` names. A detached HEAD or a branch whose ref is missing simply has its marks dropped.
- `renderNoteThreads(currentNoteThreads)` must not prune. Prune only at the successful-load site, because a broken notes file renders `[]` and must not wipe the marks.
- `styleThread` already skips unchanged writes. A label or contextValue change on mark-read does not touch `canReply`, so no recreate happens.
- The `TreeItem` constructor accepts `string | TreeItemLabel`. Keep `item.id` unchanged, so the row identity stays stable across read/unread.
- Never `await` the workspace-state update in a render path.

## Verification

- Run `yarn lint`, `yarn build` and `yarn test`. All must pass.
- New test `src/pendingRead.test.ts`:
  - `isPendingUnread`: unmarked pending → true; marked at the newest agent `at` → false; marked at an older agent `at` (a newer pending reply arrived) → true; non-pending statuses → false.
  - `withReadMark`: sets the newest agent `at`; a thread with no agent turn returns the input.
  - `prunedReadMarks`: drops ids absent from the threads, and returns the same object when nothing was dropped.
  - `prunedBranchMarks`: drops a branch absent from `liveBranches`; keeps other branches when `liveBranches` is undefined; drops a branch whose map becomes empty; prunes the current branch's ids; returns the same object when nothing changed.
- Build threads with `mergeThreads` from `src/noteThreads.ts`, using fixtures like `src/noteThreads.test.ts:12-41`.
- Substitute check: `grep -n "markNoteRead\|markNoteRowRead" package.json src/extension.ts` shows the command, menu, palette and registration entries.
- Do not launch a VS Code test instance.
