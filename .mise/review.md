# Review

## Tasks

- 01_01 (483ca09) Notes contract accepts `document: "branch"`; `documentNoteRefFor` + `canonicalDir` resolve symlinked paths. Verify: `src/notes.test.ts`, `src/documents.test.ts` (symlink alias both ways).
- 01_02 (15d78c5) Branch overview commentable in source mode; notes saved as `document: "branch"`, re-anchor, open from REVIEW NOTES. Verify: Open Source on the Branch overview row, select lines, `+` gutter, add a note; scripted check in scratchpad `vstest/` (passed 3 of 4 runs).
- 01_03 (2d477ac) REVIEW NOTES lists a `Branch overview` group first; Branch overview tooltip mentions Open Source. Verify: `src/notesGrouping.test.ts`; hover the tooltip in the dev host (not yet eyeballed).
- 01_04 (02ab2e2) review-notes SKILL.md, DEVELOPMENT.md (new step 45b), README notes bullets; plugin 0.13.0, extension 0.18.0.

## Open assumptions

- Markdown preview unchanged; notes are added and shown only in the source editor.
- Notes file stays at version 2; extension 0.17.0 and earlier reject (but never overwrite) files containing branch notes.
- Branch overview click still opens the preview.

## Observed, unresolved

- Scripted check failed once in 4 runs: a second note had not reached the notes file within 20s. Suspected pre-existing race (no write serialization in `notesStore.ts`); unconfirmed.

## Amendments

- None.
