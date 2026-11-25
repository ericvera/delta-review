# 03_01 Notes contract v3: file notes and general notes (data layer)

## Goal

Teach the notes contract layer, thread merge and store about two new note kinds:

- **file notes**: a whole-file note with no line range
- **general notes**: no file at all

They are written at notes-file version 3. Existing line and document notes behave exactly as before. The UI does not show the new kinds yet: the extension keeps rendering line/document notes only.

## Files to modify/create

- src/notes.ts (tests: src/notes.test.ts)
- src/noteThreads.ts (tests: src/noteThreads.test.ts)
- src/notesStore.ts (tests: src/notesStore.test.ts)
- src/pendingRead.ts (tests: src/pendingRead.test.ts)
- src/extension.ts

## Background

- The notes contract (`plugin/skills/review-notes/SKILL.md`, read it) is a per-branch JSON file `<common dir>/delta-review/notes-<branch>.json`, extension-written and agent-read.
  - Any notes-file change needs a `version` bump plus a parser update in the same commit (SKILL.md "Schema changes").
  - Older extensions reject unknown versions. They also rebuild notes from known keys, so they would strip new ones.
- `src/notes.ts`:
  - `Note` interface (`:25-55`), `NotesFile { version: 1 | 2; notes: Note[] }` (`:57-60`).
  - `parseNote(value, index, version)` (`:138+`) requires `file`, `side`, line numbers, `snapshot` and `contentBlob`. `document` is read only at version 2.
  - `notesFileVersion` (`:375-376`). `parseNotesFile` accepts `[1, 2]` (`:380-396`).
- `src/noteThreads.ts`: `NoteThread { note: Note; turns; status; effectiveAnchor? }` (`:27-36`). `mergeThreads(notes, responses, anchorResolves): NoteThread[]` (`:70-129`).
- `src/notesStore.ts`:
  - `createNote(git, branch, draft: NoteDraft)` (`:444-472`, generates `randomUUID()` ids).
  - `anchorBlobs` (`:336-395`) anchors every note's `contentBlob`.
  - `refreshDerived` (`:664+`) does anchor application and the per-note position/outdated pass. Its `RefreshOptions` is at `:634+`.
  - `archiveNotes(git, branch, notes: readonly Note[], deletedAt)` (`:272`), called by `deleteNotes` (`:589-611`, Clear Resolved), appends removed notes verbatim plus `deletedAt` to `archive-<branch>.json`, whose shell stays `{ version: 1, notes: unknown[] }` (`ArchiveShell`, `src/notes.ts:88`).
  - Mutations (`appendReviewerTurn`, `editReviewerTurn`, `deleteReviewerTurn`, `deleteNote`, `deleteNotes`, `setResolved`) only touch `id`, `turns` and `status`, so they work on any kind.
- `src/pendingRead.ts` takes `NoteThread` values and uses only the note id and turns.
- `src/extension.ts`: the notes block in `refresh()` (around `:716-747` before earlier tasks) calls `refreshDerived(...)` with `readWorkingContent`, `readDocumentContent`, `baseBlobFor` and `anchorResolves`, then `mergeThreads(...)`, `pruneReadMarks(threads)` and `renderNoteThreads(threads)`.
- Design decisions (spec "Notes from the pane"):
  - `Note` keeps its name and shape (line/document note).
  - New `FileNote = { scope: "file"; id; file; contentBlob; turns; status; outdated; createdAt }`.
  - New `GeneralNote = { scope: "general"; id; turns; status; outdated; createdAt }`.
  - `AnyNote = Note | FileNote | GeneralNote`. `NotesFile = { version: 1 | 2 | 3; notes: AnyNote[] }`.
  - Only version 3 reads `scope`. A scoped note has no `side`, `startLine`, `endLine`, `snapshot`, `currentStartLine`, `currentEndLine`, `document` or `appliedAnchorAt`.
  - `notesFileVersion`: 3 if any scoped note, else 2 if any document note, else 1.
  - File note `outdated` = not in the review set. General note `outdated` is always false.
  - A response `anchor` on a scoped note is ignored.

## Guides

- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format
- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `notes.ts`:
  - Add the types. `parseNote(value, index, version: 1 | 2 | 3)` returns `{ note: AnyNote }`.
    - At version 3, `scope` absent means today's validation (document allowed).
    - `scope: "file"` requires non-empty `file` and `contentBlob`, plus the shared fields.
    - `scope: "general"` requires only the shared fields.
    - Any other `scope` errors with `"scope" must be "file" or "general"`.
    - Shared fields are `id`, `turns`, `status`, `outdated` and `createdAt`, validated exactly as today. Factor out the shared validation.
    - Scoped notes are re-serialized with only their own keys: build the object explicitly, so stray keys never survive.
  - `parseNotesFile` accepts `[1, 2, 3]`. Update the module header comment.
  - Export guards `isFileNote`, `isGeneralNote`, `isLineNote(note): note is Note`.
- `noteThreads.ts`:
  - `export interface NoteThread<N extends AnyNote = Note> { note: N; … }` and `export type AnyNoteThread = NoteThread<AnyNote>`.
  - `mergeThreads(...)` returns `AnyNoteThread[]`. `effectiveAnchor` is computed only for line notes; scoped threads never carry it.
  - Guards: `isLineThread(t): t is NoteThread<Note>`, `isFileThread`, `isGeneralThread`.
  - `workSet` takes and returns `AnyNoteThread[]`.
- `notesStore.ts`:
  - `createNote(git, branch, draft: NoteDraft | FileNoteDraft | GeneralNoteDraft)`.
    - `FileNoteDraft = { scope: "file"; file; content; text; id? }`: `contentBlob = writeContentBlob(content)`.
    - `GeneralNoteDraft = { scope: "general"; text; id? }`.
    - `NoteDraft` gains optional `id?`.
    - Use `draft.id ?? randomUUID()`. Reject a duplicate id with `note "<id>" already exists`.
    - Return type `AnyNote`. Keep an overload or generic so existing callers passing `NoteDraft` still get `Note`.
  - `anchorBlobs` anchors notes that have a `contentBlob` (line and file notes). With none left, it deletes the ref as today.
  - `RefreshOptions.isInReviewSet?: (file: string) => boolean`.
  - `refreshDerived`:
    - Anchor application skips scoped notes.
    - The per-note pass: a general note keeps `outdated: false`. A file note sets `outdated = !(options.isInReviewSet?.(file) ?? (await readWorkingContent(file)) !== undefined)`, with no position fields.
    - Line notes are unchanged.
  - `findNote` and the other mutations work on `AnyNote`. Adjust types only.
  - `archiveNotes` takes `readonly AnyNote[]`; `deleteNotes` passes removed notes of any kind. Scoped notes are archived exactly as they stand (no `snapshot`), and the archive stays `version: 1` (spec decision: entries follow the notes-file schema; 03_05 documents it). Update the `deleteNotes`/`archiveNotes` comments only where they imply every entry is a line note.
- `pendingRead.ts`: widen parameter types from `NoteThread` to `AnyNoteThread` (it only reads `note.id` and turns).
- `extension.ts`:
  - Pass `isInReviewSet: (path) => computed.files.some((f) => f.path === path)` to `refreshDerived`.
  - Pass all merged threads to `pruneReadMarks`. Pass `threads.filter(isLineThread)` to `renderNoteThreads`.
  - The badge count stays on rendered threads for now (03_02 broadens it).
  - Nothing else changes.

## Gotchas

- `saveNotes` writes `version: notesFileVersion(file.notes)`. A v2 or v1 file containing only line notes must still be written at v1/v2: existing tests assert this. Keep them passing.
- `deleteReviewerTurn` deleting the only turn deletes the note: this works for scoped notes unchanged.
- `mergeThreads` is also called inside `recomputeStatus` (`notesStore.ts:~505`) with a single-note file. Make sure the types flow for scoped notes.
- Don't change the responses file format: it stays version 1, keyed by `noteId`.
- No UI or package.json changes here.

## Verification

- `src/notes.test.ts`:
  - v3 file with a file note, a general note, a line note and a document note parses
  - at v2, `scope` is ignored, so a `scope: "general"` note without lines fails with the existing `"file" must be a non-empty string` (or `"startLine"`) error; assert that error
  - bad `scope` value is rejected
  - file note missing `file` or `contentBlob` is rejected
  - stray `startLine` on a general note is dropped on parse
  - `notesFileVersion` returns 3/2/1 across combinations
- `src/noteThreads.test.ts`: scoped threads merge responses by `noteId` and never get `effectiveAnchor` even with a resolving anchor. Status derivation is unchanged.
- `src/notesStore.test.ts` (temp repo, existing pattern):
  - `createNote` with a file draft writes v3, anchors its blob on `refs/review-notes/<branch>`, and respects a pre-allocated id
  - general draft has no blob, and the ref tree lists only blob-bearing notes
  - duplicate id is rejected
  - `refreshDerived` sets a file note outdated when `isInReviewSet` is false and not outdated when true, keeps a general note not outdated, and ignores an agent anchor on both
  - `deleteNotes` / `setResolved` / `appendReviewerTurn` work on scoped notes
  - `deleteNotes` on a resolved file note and a resolved general note appends both to the archive verbatim (with `scope`, no `snapshot`, plus `deletedAt`), and the archive file stays `version: 1`
- Run `yarn test`, `yarn lint`, `yarn build`.
