# 01_03 REVIEW NOTES grouping and Branch overview tooltip

## Goal

REVIEW NOTES shows Branch overview notes in their own group labeled `Branch overview` with description `branch overview · <n>`, ahead of cluster notes groups. The Branch overview row tooltip in the DELTA REVIEW tree says Open Source lets the reviewer leave a review note.

## Files to modify/create

- `src/notesGrouping.ts`
- `src/notesTreeProvider.ts`
- `src/extension.ts`
- `src/treeProvider.ts`

## Background

- Task 01_01 made `NoteDocument = "clusterNotes" | "branch"` (`src/notes.ts`). Task 01_02 made the Branch overview commentable, so notes with `document: "branch"` now exist.
- `src/notesGrouping.ts:15-46` `groupNoteThreads` groups by `(document, file)`, document groups first then code groups, each by file. `clusterNotesDocumentLabel(file, clusterLabels)` at `:48-57` labels a document group. `notesGroupCollapseKey` at `:61-67` already includes the document.
- `src/notesTreeProvider.ts:82` constructor callback `documentLabel: (file: string) => string`; `getTreeItem` at `:112-123` uses it and hard-codes `item.description = \`cluster notes · ${element.threads.length}\``.
- `src/extension.ts:211-219` constructs `NotesTreeProvider` with `(file) => clusterNotesDocumentLabel(file, clusterLabels)`; import at `:54`.
- `src/treeProvider.ts:660-666` Branch overview row tooltip: `"Branch overview, written by the agent. Click to open the preview; use Open Source to open the markdown file."`; the cluster notes row at `:677-678` is the wording to mirror.
- Design decisions: group keys and collapse keys are unchanged; click-to-preview on the Branch overview row stays.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

- `src/notesGrouping.ts`:
  - Replace `clusterNotesDocumentLabel` with `documentNoteGroupLabel(document: NoteDocument, file: string, clusterLabels: readonly string[]): string` — `"Branch overview"` for `"branch"`; today's cluster logic for `"clusterNotes"`.
  - Add `documentNoteGroupDescription(document: NoteDocument, count: number): string` — `` `branch overview · ${count}` `` / `` `cluster notes · ${count}` ``.
  - Sort rank: `"branch"` document groups 0, `"clusterNotes"` 1, code groups 2; then by file. Update the comment at `:13-14`.
- `src/notesTreeProvider.ts`: callback becomes `documentLabel: (document: NoteDocument, file: string) => string`; description via `documentNoteGroupDescription(element.document, element.threads.length)`.
- `src/extension.ts`: pass `(document, file) => documentNoteGroupLabel(document, file, clusterLabels)`; fix the import.
- `src/treeProvider.ts`: Branch overview tooltip text → `"Branch overview, written by the agent. Click to open the preview; use Open Source to select lines and leave a review note."`

## Gotchas

- `src/extension.ts` was edited by task 01_02; edit only the `NotesTreeProvider` construction and its import.
- Tooltip and label text are visual; the pure label/description/sort logic is what gets unit tests.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Update `src/notesGrouping.test.ts`: rename the `clusterNotesDocumentLabel` describe to `documentNoteGroupLabel` (pass `"clusterNotes"` in existing cases) and add: `"branch"` yields `Branch overview` regardless of cluster labels; `documentNoteGroupDescription` for both kinds; `groupNoteThreads` orders a branch group before cluster notes groups and code groups, and keeps a branch note and a cluster note with the same `file` apart; `notesGroupCollapseKey` for a branch group is `notes:branch:<file>`.
- Tooltip: visual only — check manually in the dev host (hover the Branch overview row); no test.
