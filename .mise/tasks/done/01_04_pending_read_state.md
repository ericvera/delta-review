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
- Command palette hiding: the `"commandPalette"` array in `package.json` (`:473-574`, entries with `"when": "false"`).
- Repo switching: `setActiveRepo` at `src/extension.ts:703-719` swaps `git` to the SCM-selected repo and refreshes; all repos share one `context.workspaceState`. At the load site, `gitForNotes` (`src/extension.ts:497`) is the repo being loaded and `gitForNotes.repoRoot` its root.
- Non-pruning restyle precedent: `reclampThreadsFor` at `src/commentController.ts:629-` iterates `threadCache` without disposing anything. `renderThreads` (`src/commentController.ts:556-616`) disposes cached threads absent from its array (`:611-615`), which is why DEVELOPMENT.md:190 and the comment at `src/extension.ts:285-289` forbid calling it outside `refresh()`.

Design decisions:
- Read state is never written to the notes or responses files.
- Key `deltaReview.pendingReadMarks`, value `Record<repoRoot, Record<branch, Record<noteId, agentTurnAt>>>`. Keyed per repo because the extension follows the SCM-selected repo and branch-only keys would let one repo's pruning wipe another's marks.
- A note is unread iff its status is `pending` and its mark is not equal to its newest agent turn's `at`.
- Prune only inside the loaded repo's map. Prune the current branch's marks to note ids present in the thread set, on a successful notes load only (including a load with zero notes, which prunes to empty), and write only when something changed.
- The unread row has no dot: a `ThemeIcon` cannot carry an overlay. Unread is the bright purple clock, read the dimmed clock.
- On the same load, drop that repo's entries for branches that no longer exist locally in that repo, so the map does not grow across deleted branches. Only run the git branch listing when that repo's map has a key other than the current branch. Empty per-branch and per-repo maps are dropped. Other repos' maps are never touched.
- Mark as Read re-styles in place and never prunes: it must not call `renderNoteThreads` or `renderThreads`.
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
   - `export type RepoReadMarks = Readonly<Record<string, BranchReadMarks>>` (repoRoot → branch marks).
   - `marksFor(all: RepoReadMarks, repo: string, branch: string): PendingReadMarks` returns `all[repo]?.[branch] ?? {}`.
   - `withRepoReadMark(all: RepoReadMarks, repo: string, branch: string, thread: NoteThread): RepoReadMarks` sets the mark via `withReadMark` inside `all[repo][branch]`, returning `all` unchanged when `withReadMark` returns its input.
   - `prunedRepoMarks(all: RepoReadMarks, repo: string, branch: string, threads, liveBranches): RepoReadMarks` applies `prunedBranchMarks` to `all[repo] ?? {}` only, drops the `repo` key when its result is empty, leaves every other repo key untouched, and returns the same object when nothing changed.
2. `src/commentController.ts`:
   - Add a fourth factory parameter `pendingRead: { isUnread: (thread: NoteThread) => boolean; markRead: (thread: NoteThread) => void }`.
   - In `styleThread`, let `unread = pendingRead.isUnread(thread)`. The label is `statusLabels[status] + (unread ? " • Unread" : "") + (outdated ? " • Outdated" : "")`. The contextValue is `unread ? "pendingNoteUnread" : statusContextValues[status]`.
   - Add `markNoteRead: (target: vscode.CommentThread) => void` to the `NoteCommentController` interface and the returned object. It finds the note id via `threadNoteIds`, the entry via `threadCache`, and calls `pendingRead.markRead(entry.noteThread)`.
   - Add `restyleThreads: () => void` to the interface and the returned object. It runs `styleThread(entry.thread, entry.noteThread)` for each `threadCache` entry, using each entry's own cached `noteThread`. It never disposes, recreates, sweeps, or touches ranges, and it does not take a thread array (follow `reclampThreadsFor`).
3. `src/notesTreeProvider.ts`:
   - Add a constructor parameter `isUnread: (thread: NoteThread) => boolean`.
   - For a pending note: unread → icon `clock` in `charts.purple`, label `{ label, highlights: [[0, label.length]] }` (a `vscode.TreeItemLabel`, which VS Code renders bold in `list.highlightForeground`, usually blue, not white; accepted), contextValue `noteRow-pendingUnread`, tooltip status line `Status: pending (unread)`. Read → icon `clock` in `ThemeColor("disabledForeground")`, plain label, `noteRow-pending`, `Status: pending`.
   - `noteIcon` needs the unread flag. Change its signature accordingly and update its comment.
4. `src/extension.ts`:
   - Load the marks near the other workspace-state reads (`:113-140`) under key `deltaReview.pendingReadMarks`.
   - Keep `let notesKey: { repo: string; branch: string } | undefined`, set to `{ repo: gitForNotes.repoRoot, branch: computed.branch }` immediately before `renderNoteThreads(threads)` at the `:569` render — after the pruning helper (below) has returned and its own stale return has been taken, never before its `await` — and likewise immediately before `renderNoteThreads([])` on the zero-notes `ok` path, after that path's helper call returns (`styleThread` and the tree call `isUnread` during render, so the key must be current first). Set it to `undefined` at every other `renderNoteThreads([])` site.
   - `isUnread = (thread) => isPendingUnread(thread, notesKey === undefined ? {} : marksFor(marks, notesKey.repo, notesKey.branch))`. Pass it to `NotesTreeProvider` and the controller.
   - `markRead(thread)`: return if `notesKey` is undefined. Otherwise set `marks = withRepoReadMark(marks, notesKey.repo, notesKey.branch, thread)`; if unchanged by identity, return. Call `void context.workspaceState.update(...)`, then `commentController.restyleThreads()` and `notesTreeProvider.setThreads(currentNoteThreads)`. Do not call `renderNoteThreads` (the badge is unchanged by read state).
   - At `:569`, before rendering, bind `const threads = mergeThreads(refreshed, responses, anchorResolves)`, replace `marks` with `prunedRepoMarks(marks, gitForNotes.repoRoot, computed.branch, threads, liveBranches)`, then `renderNoteThreads(threads)`. Persist only if the result differs by identity.
   - `liveBranches`: when `Object.keys(marks[gitForNotes.repoRoot] ?? {}).some((key) => key !== computed.branch)`, run `gitForNotes.run(["for-each-ref", "--format=%(refname)", "refs/heads"])` and build a set of each line with the `refs/heads/` prefix stripped (do not use `%(refname:short)`; it can print `heads/<name>` for ambiguous names). Otherwise pass `undefined`. Wrap that call in its own `try/catch` that falls back to `undefined`, so a git failure never reaches the notes-warning `catch`. Check `generation !== refreshGeneration` after the `await` and return if stale, as the surrounding code does.
   - Put the `liveBranches` lookup, the stale check, the `prunedRepoMarks` call and the identity-gated persist in one local async helper inside `refresh` (for example `pruneReadMarks(threads): Promise<boolean>`, returning false when stale) so both prune sites share it.
   - In the `else` branch at `:570-573` ("Missing or empty"), when `notesResult.state === "ok"` (the file loaded with zero notes), call the helper with `[]` before `renderNoteThreads([])`, and return if stale. This drops the current branch's marks for a branch whose last note was deleted (and drops the branch key, and the repo key if empty). Do not prune when the state is `missing`; the `invalid` path returns earlier at `:511-521` and must stay untouched.
   - Hold `marks` in a `let` (`RepoReadMarks`) so pruning can replace it.
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
- Prune only on a successful notes load (the `:569` render and the zero-notes `ok` path). A broken notes file renders `[]` and must not wipe the marks; a missing file is not pruned either.
- `markRead` must not call `renderNoteThreads` or `renderThreads`: a Mark as Read clicked before a just-added note's refresh lands would dispose that note's thread. `restyleThreads` and `setThreads` never prune.
- Switching repos must not drop another repo's marks: pruning touches only `marks[gitForNotes.repoRoot]`. `liveBranches` comes from the loaded repo's `refs/heads`, so it must never be applied to another repo's branches.
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
  - `prunedBranchMarks` with an empty `threads` array drops the current branch's key entirely.
  - `prunedRepoMarks`: leaves another repo's map untouched even when it holds a branch of the same name with ids absent from `threads` and branches absent from `liveBranches`; drops the repo key when its map becomes empty; returns the same object when nothing changed.
  - `withRepoReadMark` / `marksFor`: a mark set in one repo is not visible under another repo with the same branch name.
- Build threads with `mergeThreads` from `src/noteThreads.ts`, using fixtures like `src/noteThreads.test.ts:12-41`.
- Substitute check: `grep -n "markNoteRead\|markNoteRowRead" package.json src/extension.ts` shows the command, menu, palette and registration entries.
- Do not launch a VS Code test instance.
