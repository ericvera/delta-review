# Progress

## Task 1.1 — Notes contract: types, parse/validate, load results in `src/notes.ts`

- Key changes: new `src/notes.ts` (types `NoteSide`, `NoteStatus`, `ReviewerTurn`, `Note`,
  `NotesFile`, `ResponseAnchor`, `ResponseEntry`, `ResponsesFile`; result unions
  `ParseNotesResult`/`ParseResponsesResult`/`LoadNotesResult`/`LoadResponsesResult`; filename
  helpers `notesFileName`/`responsesFileName` reusing `sanitizeBranchForFilename` from
  `./clusters`; parsers `parseNotesFile`/`parseResponsesFile` with a shared
  `parseVersionedFile` top-level validator in clusters style). New `src/notes.test.ts`
  (round-trips, version rejection, per-field `it.each` error tables, unknown-key tolerance,
  filename sanitization/prefix tests).
- Deviations from plan: also validates `currentEndLine >= currentStartLine` (plan only named
  `endLine >= startLine`; applied the same ordering rule to the derived pair for consistency).
  `turns[].text`/`turns[].at` and `anchor.snapshot` accept empty strings (plan required
  non-empty only for `id`/`file`/`contentBlob`/`createdAt`/`noteId`/`response`/`at`/`anchor.file`).
