# 03_05 Notes v3 docs: review-notes skill, README, DEVELOPMENT.md

## Goal

Document file notes and general notes:

- the notes contract (version 3), so agents read and answer them correctly
- the pane workflow in README.md
- the internals in DEVELOPMENT.md

## Files to modify/create

- plugin/skills/review-notes/SKILL.md
- README.md
- DEVELOPMENT.md

## Background

- Tasks 03_01 to 03_04 implemented:
  - Notes file version 3 (`src/notes.ts`), written only when a scoped note exists. Optional `scope` is `"file"` or `"general"`.
    - File note: `id, scope, file, contentBlob, turns, status, outdated, createdAt`, with no `side`, lines, `snapshot`, `document` or `appliedAnchorAt`.
    - General note: `id, scope, turns, status, outdated, createdAt`, with no `file` or `contentBlob`.
  - A file note is outdated when its file left the review diff. A general note is never outdated.
  - A response `anchor` on either kind is ignored.
  - The responses file is unchanged (version 1, keyed by `noteId`).
  - Clear Resolved archives file and general notes verbatim (with `scope`, no `snapshot`) into `archive-<branch>.json`, which stays `version: 1` (spec decision: archive entries follow the notes-file schema).
  - UI:
    - The Review Notes title `+` offers File note / General note.
    - File notes render as a whole-file thread above line 1 of the diff, and as `file` rows first in their group.
    - General notes sit in a "General notes" group above the files and open in their own conversation tab (reply, resolve, delete, mark read; draft mode). Clear Resolved covers them.
- Current docs to update:
  - `plugin/skills/review-notes/SKILL.md`:
    - `:71` (`snapshot` is the authoritative locator)
    - `:72-77` (side/document semantics, `version` is 1 or 2)
    - `:118-122` "Archive file (read-only history)", esp. `:121` (an archived note's `snapshot` is the text record)
    - `:147` "Schema changes" (accepted versions)
    - `:154` workflow step 2 (order by file/line)
    - the intro loop line (reviewer notes diff lines)
  - README.md:75-96 ("Review notes").
  - DEVELOPMENT.md:
    - `:151-235` ("Review notes" subsections)
    - `:175`, `:204` ("Where a note's thread lives")
    - `:226` (notes on review documents)
    - `:315-318` (manual script)
    - the `__inspect` field list at `:248` (add `noteThreads`, `generalNotePanels`, `allNoteThreads`, `notesRows`, `base`, `baseStatus`, `publishCount`, as added by earlier tasks; check `src/extension.ts`'s `__inspect` for the exact final set)
- CLAUDE.md doc rules:
  - Skill docs and DEVELOPMENT.md: a binding Contract plus an overridable Default workflow that references it. Terse and normative. Each rule stated once, in the Contract.
  - README: one-liner plus bullets. No `REQ-*` ids.

## Guides

- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format
- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- SKILL.md Contract "Notes file":
  - State that `version` is 1, 2 or 3, and that version 3 adds `scope`. Show a compact JSON example of one file note and one general note.
  - File note: concerns `file` as a whole. There is no locator, and `outdated: true` means the file left the diff. Address it by editing the file or replying.
  - General note: concerns the branch or change as a whole, not a file. Address it by code changes wherever needed, or by reply.
  - Restrict the existing `snapshot` / `side` / line bullets to notes without `scope`.
  - Add to the "Silent failures" list (or a sibling bullet) that a response `anchor` on a scoped note is ignored, so omit it.
- Contract "Archive file": entries are notes in any notes-file shape (line, document, file, general) plus `deletedAt`. A note without `scope` keeps `snapshot` as its text record; a scoped note has no `snapshot`, so its record is `turns` (and `file` for a file note).
- "Schema changes": the extension accepts notes `version` 1, 2 and 3. Add that archive entries follow the notes-file schema, so a notes-file version bump needs no archive bump; only a change to the archive shell does.
- Workflow step 2 order: within each class, general notes first, then by file, with file notes before that file's line notes, then by line. Keep this in the workflow; the Contract work-set rule is unchanged.
- README "Review notes":
  - Bullets: the pane `+` (File note / General note), where each renders, and that Clear Resolved includes general notes.
  - Update the empty-state wording if it is quoted.
- DEVELOPMENT.md:
  - Under "Review notes", add a `#### File and general notes` subsection covering:
    - storage (v3, `scope`, anchoring only blob-bearing notes)
    - the outdated rule (`isInReviewSet`)
    - rendering: range-less thread, `fileNoteDraft` and Cancel, the general-note webview (one per note, CSP nonce, acts on its own repo/branch, closes on delete)
  - Update "Where a note's thread lives" for file notes (`fileNoteTargetFor`).
  - Add manual-script steps:
    - `+` with the active file in the diff → File note thread above line 1
    - `+` → General note → tab, Add Note, row under General notes, reply, resolve, Clear Resolved, and the tab closes on delete
    - the disabled File note reason when the active file is unchanged
  - Update the `__inspect` field list.

## Gotchas

- Do not restate rules across Contract and workflow. The workflow references Contract sections by name.
- Keep the example JSON valid and matching the parser exactly: key names and which keys are absent.
- The cluster skill is unaffected by this task.

## Verification

- No test covers docs. Substitute checks:
  - Extract each JSON example from SKILL.md and parse it with `parseNotesFile` from `src/notes.ts` via a throwaway Vitest file in the scratchpad (not committed). Each must parse `ok`.
  - `grep -n "snapshot" plugin/skills/review-notes/SKILL.md`: no line claims every archived note has a `snapshot`.
  - `grep -n "version" plugin/skills/review-notes/SKILL.md`: every accepted-version statement says 1, 2 or 3 for notes and 1 for responses/archive.
  - Compare the `__inspect` list in DEVELOPMENT.md with the object literal in `src/extension.ts`.
- Run `yarn lint` and `yarn build`.
