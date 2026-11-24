# 01_07 Notes file version 2: notes on cluster notes documents

## Goal

The notes file can hold a review note anchored to a cluster notes document: a version 2 `document` key, store support for creating and re-anchoring such notes against the document's content, and a note target that resolves to the document. The review-notes skill documents the format in the same commit.

## Files to modify/create

- `src/notes.ts`
- `src/notesStore.ts`
- `src/noteTarget.ts`
- `src/extension.ts`
- `plugin/skills/review-notes/SKILL.md`

## Background

- Notes contract (`src/notes.ts`): `Note` (`:22-47`), `NotesFile.version: 1` (`:49-52`), `parseNote` (`:130-238`), shared `parseVersionedFile` enforcing version 1 for notes, responses and archive (`:299-330`), `parseNotesFile` (`:334-348`).
- Store (`src/notesStore.ts`): `saveNotes` (`:202-224`), `loadNotesForMutation` default `{ version: 1, notes: [] }` (`:397-408`), `NoteDraft` and `createNote` (`:418-462`), `RefreshOptions` (`:624-638`), `refreshDerived` (`:648-765`: anchor application loop `:666-713`, working content read `:720-727`).
- Target (`src/noteTarget.ts`): `NoteTarget` union (`:17-34`), `noteTargetFor(model, note, workingFileExists)` (`:51-87`).
- Refresh caller: `src/extension.ts:549-557` (`readWorkingContent`) and `:641-657` (`refreshDerived` options).
- Task 01_06 keeps `reviewDocuments: ReviewDocuments | undefined` in `src/extension.ts`, whose `clusterNotesDir` is the absolute `<common dir>/delta-review/cluster-notes-<sanitized branch>`. Task 01_05's `CLUSTER_NOTES_FILE_PATTERN` (`src/documents.ts`) is `/^[a-z0-9-]+\.md$/`.
- Design decisions:
  - `Note.document?: "clusterNotes"`. With it, `file` is the document's file name inside the cluster notes dir and must match `CLUSTER_NOTES_FILE_PATTERN`, and `side` must be `"working"`; violations reject the file (`note N ("id"): "document" must be "clusterNotes"`, `…: a document note's "file" must be a cluster notes file name`, `…: a document note's "side" must be "working"`).
  - `document` is parsed only at version 2; at version 1 it is an unknown key and ignored.
  - The notes file accepts versions 1 and 2 (`(extension supports 1 and 2)`); responses and archive stay version 1 only (`(extension supports 1)`).
  - Written version: `2` when any note has `document`, else `1` — `export const notesFileVersion = (notes: readonly Note[]): 1 | 2`; `saveNotes` applies it to the serialized object. Files without document notes stay readable by older extensions.
  - Serialized key order: `document` right after `file`, present only when set (parse output too).
  - A document note's current content comes from `RefreshOptions.readDocumentContent(fileName)` (optional; absent → the document reads as missing → outdated, last position kept). Response anchors are never applied to a document note.
  - Target: `DocumentNoteTarget { kind: "document"; file: string; lines: "current" }` for a document note whose document exists. A missing document falls back to `{ kind: "base", path: note.file, sha: note.contentBlob, lines: "creation" }`. The third parameter of `noteTargetFor` becomes "the note's working document exists" (the working file, or the document for a document note).
  - Until task 01_08, no code path creates document notes, and the controller does not yet render `document` targets.

## Guides

- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

1. `src/notes.ts`: add the field, `NotesFile.version: 1 | 2`, `notesFileVersion`; give `parseVersionedFile` an accepted-versions argument; validate `document` in `parseNote` when the file is version 2 (pass the version in). Import the pattern from `./documents` (vscode-free).
2. `src/notesStore.ts`: `saveNotes` serializes `{ ...file, version: notesFileVersion(file.notes) }`; `NoteDraft.document?` copied by `createNote`; `RefreshOptions.readDocumentContent?`; in `refreshDerived` skip anchor application when `thread.note.document !== undefined`, and read a document note's content through `readDocumentContent`.
3. `src/noteTarget.ts`: new target kind and branch at the top of `noteTargetFor`; update the module comment's case list.
4. `src/extension.ts`: pass `readDocumentContent` reading `join(reviewDocuments.clusterNotesDir, fileName)` (undefined when `reviewDocuments` is undefined, the name fails the pattern, or the read fails). Existing `noteTargetFor` callers (`src/commentController.ts:340-351`, `src/extension.ts:1519`) compile unchanged; do not touch `src/commentController.ts` in this task.
5. `plugin/skills/review-notes/SKILL.md` (same commit, per its "Schema changes"): Notes file section — versions 1 and 2, the `document` key, how to locate a document note's file (`<COMMON_DIR>/delta-review/cluster-notes-<sanitized-branch>/<file>`), that `side` is always `working` for it, that fixing such a note means editing that markdown file, and that a response `anchor` on a document note is ignored. Schema changes section: the extension now accepts notes versions 1 and 2.

## Gotchas

- `parseArchiveFile` shares `parseVersionedFile`; archive must stay version 1 only.
- `structuredClone` in `refreshDerived` keeps `document`; make sure `parseNote` copies it into the returned note or a load→save cycle strips it.
- `recomputeStatus` builds `{ version: 1, notes: [note] }` — still valid with the widened type.
- A document file name could equal a repo-root file name; never look a document note up in `model.files` (only `noteTargetFor`'s document branch decides).

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Write in `src/notes.test.ts`: v2 file with a document note parses and keeps the key; invalid `document` value, bad file name (`../x.md`, `a/b.md`), `side: "base"` each reject; v1 file ignores a `document` key; v3 notes file rejected with the new message; responses v2 still rejected with `(extension supports 1)`; `notesFileVersion` cases.
- Write in `src/notesStore.test.ts`: `saveNotes` writes version 2 only with a document note and 1 after it is deleted; `createNote` stores `document`; `refreshDerived` shifts a document note through `readDocumentContent`, marks it outdated when the reader is absent or returns undefined, and ignores a resolving response anchor on it.
- Write in `src/noteTarget.test.ts`: document note with existing document → `document` target; missing → base fallback at `contentBlob` with `creation` lines; a repo file with the same name in `model.files` is not consulted.
