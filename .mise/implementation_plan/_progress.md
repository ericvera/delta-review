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

## Task 1.2 — Anchor mapping: hunk parsing and line-range re-mapping in `src/noteAnchor.ts`

- Key changes: new `src/noteAnchor.ts` (`DiffHunk`, `parseUnifiedDiffHunks` extracting
  `@@ -a[,b] +c[,d] @@` headers with omitted counts defaulting to 1; `MappedRange`;
  `mapRangeThroughHunks` — any-line intersection marks outdated, pure insertions outdate only
  when strictly inside the range, clean ranges shift by the net delta of hunks above). New
  `src/noteAnchor.test.ts` (header parsing incl. zero-count/omitted-count/garbage cases;
  `it.each` mapping table for shifts, boundaries, outdated positioning, clamping; independent
  per-note mapping over one shared diff).
- Deviations from plan: none. Collapse rule chosen per the plan's offered "simplest honest
  rule": an outdated range collapses to a single line at the mapped start (start shifted by
  hunks above when the start line survives; offset into the replacement capped at its last
  line when rewritten; deletion hunk's `newStart` clamped to >= 1 when deleted outright).
