# 01_03 Parse `pending` on response entries and gate menus on pending notes

## Goal

Let an agent's responses-file entry carry an optional `pending: true`. Parse it, carry it onto the merged agent turn so the thread derives `pending`, and make every thread and row menu that applies to addressed notes also apply to pending notes, both read and unread.

## Files to modify/create

- src/notes.ts
- src/noteThreads.ts
- package.json

## Background

- From task 01_02, `src/noteThreads.ts` already has:
  - `ThreadStatus` (includes `"pending"`).
  - `ThreadTurn.pending?: true`.
  - `deriveThreadStatus(noteStatus, turns)`, which yields `pending` when the last turn is an agent turn with `pending === true`.
  - `persistedStatus` (pending → `"addressed"`), used by `refreshDerived` and `recomputeStatus` in `src/notesStore.ts`.
  - `canReplyFor("pending") === true` in `src/threadRender.ts`.
  - Thread context value `pendingNote` and row context value `noteRow-pending`.
- Task 01_04 adds the unread variants `pendingNoteUnread` and `noteRow-pendingUnread`. This task's `when` clauses already include them, so 01_04 only adds its new commands.
- `ResponseEntry` is at `src/notes.ts:61-66`, and `parseResponseEntry` at `:240-285`. The parser rebuilds each entry from known keys only, so unknown keys are dropped. That is why older extensions ignore `pending`.
- Pattern to follow for an optional boolean flag: clusters `wait` at `src/clusters.ts:260-261` (reject non-boolean with `"wait" must be a boolean`) and `:276` (keep the key only when `true`).
- In `mergeThreads`, agent turns are built at `src/noteThreads.ts:56-62`.
- Menus in `package.json`:
  - Row: `view/item/context` entries at `:384-391` (`resolveNoteRow`, regex `^noteRow-(open|addressed)$`).
  - Thread title: `comments/commentThread/title` at `:439-453` (`resolveNote` regex `^(openNote|addressedNote)$`; `deleteNoteThread` regex `^(openNote|addressedNote|resolvedNote)$`).
  - Thread context: `comments/commentThread/context` at `:461-470` (`replyReopen` and `resolveNote` gated on `commentThread == addressedNote`).
  - Row delete gates on `^noteRow-` and needs no change.
- Design decisions:
  - No schema `version` bump.
  - A non-boolean `pending` rejects the responses file. A one-line error is consistent with the other entry checks.
  - `pending: false` is accepted and treated as absent.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

1. `src/notes.ts`:
   - `ResponseEntry` gains `pending?: true` with the comment "the reply leaves work queued; the note derives pending."
   - In `parseResponseEntry`, after the `at` check: if `value.pending !== undefined && typeof value.pending !== "boolean"`, return `{ error: \`${where2}: "pending" must be a boolean\` }`.
   - After building `entry`, `if (value.pending === true) entry.pending = true;`.
2. `src/noteThreads.ts`: in `mergeThreads`, `if (entry.pending === true) turn.pending = true;` beside the anchor copy.
3. `package.json` `when` clauses:
   - Row `resolveNoteRow` (both entries): `viewItem =~ /^noteRow-(open|addressed|pending|pendingUnread)$/`.
   - Thread title `resolveNote`: `commentThread =~ /^(openNote|addressedNote|pendingNote|pendingNoteUnread)$/`.
   - Thread title `deleteNoteThread`: `/^(openNote|addressedNote|pendingNote|pendingNoteUnread|resolvedNote)$/`.
   - Thread context `replyReopen` and `resolveNote`: `commentThread =~ /^(addressedNote|pendingNote|pendingNoteUnread)$/`.

## Gotchas

- Keep the parse output free of `pending: false` and `pending: undefined`. The round-trip tests use `toEqual`.
- The `version` check stays `=== 1`. Do not bump it.
- `package.json` is JSON. Escape nothing extra, since the regexes use `/.../` literals inside `when` strings, as the existing ones do.

## Verification

- Run `yarn lint`, `yarn build` and `yarn test`. All must pass.
- New tests:
  - `src/notes.test.ts` (`describe("parseResponsesFile")`, `:343`):
    - Round-trips an entry with `pending: true`.
    - `pending: false` parses to an entry without the key.
    - `pending: "yes"` is rejected with an error containing `"pending" must be a boolean`.
  - `src/noteThreads.test.ts`:
    - `mergeThreads` with a `response({ pending: true })` as the last turn → status `pending` and the agent turn has `pending: true`.
    - A later non-pending response → `addressed`.
    - A later reviewer turn → `open`.
    - A resolved note with a pending response → `resolved`.
  - `src/notesStore.test.ts` (`describe("refreshDerived")`, `:861`, using `writeResponseEntries([{ noteId, pending: true }])` from `:111`):
    - The persisted notes-file status is `"addressed"` while the merged thread status is `pending`.
    - Add a `setResolved(..., false)` case (near `:559`) showing that unresolve over a pending response persists `"addressed"`.
- Substitute check for the menus: `grep -n "pendingNote" package.json` shows the four updated thread clauses, and `grep -n "pendingUnread" package.json` shows the two row clauses.
