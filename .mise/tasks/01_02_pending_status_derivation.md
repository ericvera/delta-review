# 01_02 Pending thread status: type, derivation, persistence, base UI

## Goal

Introduce a fourth derived thread status, `pending`, which is "the agent answered but the work is still queued." Derive it from a `pending` flag on agent turns. Store it back into the notes file as `"addressed"`. Give it a reply box and a base rendering: a purple clock, the label "Pending", and the context values `pendingNote` and `noteRow-pending`. No input produces the flag until task 01_03, so behavior is unchanged at runtime after this task.

## Files to modify/create

- src/noteThreads.ts
- src/threadRender.ts
- src/notesStore.ts
- src/commentController.ts
- src/notesTreeProvider.ts

## Background

- Task 01_01 already made turn bodies render as markdown in `commentsFor` and the tree tooltip. Leave that as is.
- Notes-file status type: `NoteStatus = "open" | "addressed" | "resolved"` (`src/notes.ts:14`). It is the notes-file schema, and the parser (`src/notes.ts:185-193`) rejects anything else. Do not change it.
- Derivation today is in `mergeThreads` (`src/noteThreads.ts:83-88`): resolved wins, then the last speaker decides (agent → addressed, reviewer → open). `workSet` (`:114-115`) is open-only.
- Persistence of derived status:
  - `refreshDerived` writes `note.status = thread.status` at `src/notesStore.ts:715-718`.
  - `recomputeStatus` (`:482-500`) writes `note.status = thread.status`.
- Reply box: `canReplyFor` (`src/threadRender.ts:10-11`) is addressed-only. `shouldRecreateThread` (`:17-21`) disposes and recreates a thread on a false→true `canReply` flip.
- Hard-coded statuses:
  - `statusLabels` and `statusContextValues` at `src/commentController.ts:40-51`, used at `:300-320`.
  - Eager restyles copy `note.status` into `entry.noteThread.status` at `src/commentController.ts:822-823` (deleteNoteTurn), `:879-880` (setNoteResolved), and `:921-922` (replyReopen).
  - `noteIcon` switch at `src/notesTreeProvider.ts:45-60`, tooltip status at `:152`, row `contextValue` at `:159`.
- Design decisions:
  - Pending persists as `"addressed"` in the notes file, so older extensions keep parsing it. This keeps the no-version-bump promise.
  - `ThreadStatus` lives in `src/noteThreads.ts`, and `NoteThread.status` becomes `ThreadStatus`.
  - A pending note keeps the reply box ("Reply & Reopen"), is unresolved, and is resolvable.
  - Thread context value `pendingNote`, row context value `noteRow-pending`, icon `clock` in `charts.purple`, tooltip "Status: pending".

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

1. `src/noteThreads.ts`:
   - `export type ThreadStatus = NoteStatus | "pending";`
   - `ThreadTurn` gains an optional `pending?: true` with the comment "agent turns only: the reply leaves work queued".
   - `NoteThread.status: ThreadStatus`. Update its comment: resolve wins, then last speaker (pending agent → pending, agent → addressed, reviewer → open).
   - `export const deriveThreadStatus = (noteStatus: NoteStatus, turns: readonly ThreadTurn[]): ThreadStatus`, holding the logic now inline in `mergeThreads`, plus the pending case when the last turn is an agent turn with `pending === true`. `mergeThreads` calls it.
   - `export const persistedStatus = (status: ThreadStatus): NoteStatus => status === "pending" ? "addressed" : status;` with a comment explaining why: older extensions reject unknown status values in the notes file.
   - `workSet` keeps open or pending threads. Update its comment to say it mirrors the contract's actionable rule.
   - `mergeThreads` does not yet read any pending flag from responses (that is 01_03).
2. `src/threadRender.ts`: `canReplyFor(status: ThreadStatus)` returns true for `"addressed"` and `"pending"`. `shouldRecreateThread` takes `ThreadStatus`. Update the comment at `:7-9`. Import the type with `import type` from `./noteThreads`.
3. `src/notesStore.ts`: at `:715-718` and in `recomputeStatus`, assign `persistedStatus(thread.status)`.
4. `src/commentController.ts`:
   - `statusLabels` and `statusContextValues` become `Record<ThreadStatus, string>`, adding `pending: "Pending"` and `pending: "pendingNote"`. The `state` stays Unresolved for pending, since only resolved is Resolved.
   - At the three eager-restyle sites, set `entry.noteThread.status = deriveThreadStatus(note.status, entry.noteThread.turns)` (using `remaining` or `note` as named at each site). Keep the `entry.noteThread.note.status = …status` assignment as the persisted value.
   - Update the restyle comments that say "addressed" (e.g. `:316-319`, `:412-415`) to "replyable (addressed or pending)".
5. `src/notesTreeProvider.ts`:
   - `noteIcon(status: ThreadStatus)` adds `case "pending": new vscode.ThemeIcon("clock", new vscode.ThemeColor("charts.purple"))`, and updates the comment.
   - The tooltip line and `contextValue` already interpolate `thread.status`, so they yield "Status: pending" and `noteRow-pending` with no change. Confirm that they type-check.

## Gotchas

- Do not widen `NoteStatus` or the notes parser. Writing `"pending"` into the notes file would make older extensions reject the whole file.
- Existing tests use `toEqual` on merged turns. Never set `pending: undefined` explicitly on a turn object; omit the key.
- `setNoteResolved` unresolve: the store returns `"addressed"` for a pending note, so you must re-derive from the turns, or the thread briefly shows Addressed.
- An open → pending transition flips `canReply` false→true, and the existing `restyle` path recreates the thread for it. No new code is needed there, but `shouldRecreateThread` must accept pending.

## Verification

- Run `yarn lint`, `yarn build` and `yarn test`. All must pass.
- New tests:
  - `src/noteThreads.test.ts`:
    - `deriveThreadStatus` cases: resolved wins over a pending last turn; pending agent last → pending; non-pending agent last → addressed; reviewer last after a pending agent turn → open.
    - `persistedStatus` maps pending → addressed and leaves the others unchanged.
    - Extend the `workSet` test so a pending thread, built by constructing a `NoteThread` with a pending agent turn through `deriveThreadStatus`, is kept.
  - `src/threadRender.test.ts`:
    - Update "is true only for addressed" (`:31`) to cover pending → true.
    - Add `shouldRecreateThread(false, "pending") === true` and `shouldRecreateThread(true, "pending") === false`.
- Existing `src/notesStore.test.ts` status tests must stay green unchanged. The pending persistence test is written in 01_03, once the parser carries the flag.
