# Spec: review notes on the Branch overview document

## What

- The Branch overview document (`<common dir>/delta-review/branch-<sanitized branch>.md`) takes review notes in the source (text) editor, like cluster notes documents already do: `+` gutter over the whole document, multi-line selection drives the range.
- Cluster notes documents keep taking notes in source mode; a scripted extension-host check confirms both document kinds are commentable when opened through `deltaReview.openDocument` (Open Source).
- The built-in markdown preview is unchanged: no custom webview, notes are not rendered in the preview.
- Branch-document notes are stored in the notes file with a new `document` value `"branch"`; the notes file stays at `"version": 2` (no version bump). Existing notes files stay readable.
- REVIEW NOTES lists branch-document notes in their own group labeled `Branch overview`.
- The Branch overview row tooltip says Open Source lets the reviewer select lines and leave a review note; click still opens the preview.
- Public contract `plugin/skills/review-notes/SKILL.md` documents the new value; plugin bumps to `0.13.0`, extension to `0.18.0`.

## Design

### Contract layer (pure)

- `src/notes.ts`: `NoteDocument = "clusterNotes" | "branch"`. `parseNote` (version 2 only, as today) accepts either value; the file-name check becomes per-document via `isDocumentNoteFileName(document, file)`; `side` must still be `"working"`. Error for an unknown value: `"document" must be "clusterNotes" or "branch"`. File error for branch: `a branch document note's "file" must be a branch document file name` (the cluster message is unchanged). `notesFileVersion` is unchanged (any document note → 2).
- `src/documents.ts` gains:
  - `BRANCH_DOCUMENT_FILE_PATTERN = /^branch-[A-Za-z0-9._-]+\.md$/` (the output alphabet of `sanitizeBranchForFilename`, no path separators).
  - `isDocumentNoteFileName(document: NoteDocument, file: string): boolean` — cluster pattern for `"clusterNotes"`, branch pattern for `"branch"`.
  - `ReviewDocuments` gains `deltaReviewDir: string` (the `dir` passed to `loadReviewDocuments`) and `branchDocumentFileName: string` (`branchDocumentFileName(branch)`, set even when the file is missing).
  - `type DocumentNoteLocations = Pick<ReviewDocuments, "deltaReviewDir" | "clusterNotesDir" | "branchDocumentFileName">`.
  - `documentNotePath(locations, document, file): string` — `join(clusterNotesDir, file)` for `"clusterNotes"`, `join(deltaReviewDir, file)` for `"branch"`.
  - `documentNoteRefFor(fsPath, locations, normalizeDir): { document: NoteDocument; file: string } | undefined` — cluster notes doc when `normalizeDir(dirname(fsPath)) === normalizeDir(clusterNotesDir)` and the name matches the cluster pattern; branch doc when the directory equals `normalizeDir(deltaReviewDir)` and the name equals `branchDocumentFileName` (only the current branch's document). `normalizeDir` is injected (the controller passes `(p) => vscode.Uri.file(p).fsPath`) so the module stays vscode-free.
  - Type-only import of `NoteDocument` from `./notes` (notes.ts already value-imports from documents.ts; a type-only import adds no runtime cycle).

### Plumbing

- `src/noteTarget.ts`: `DocumentNoteTarget` gains `document: NoteDocument`; `noteTargetFor` copies `note.document` into it. The missing-document fallback (creation blob, `kind: "base"`) is unchanged for both kinds.
- `src/notesStore.ts`: `RefreshOptions.readDocumentContent` becomes `(document: NoteDocument, fileName: string) => Promise<string | undefined>`; `refreshDerived` passes `note.document`.
- `src/commentController.ts`: the last factory parameter `getClusterNotesDir` becomes `getReviewDocuments: () => ReviewDocuments | undefined`. `clusterNotesFileName` is replaced by `documentNoteRef(uri)` (file scheme only, delegates to `documentNoteRefFor`). It drives `provideCommentingRanges`, `addNote` (stores `document: ref.document`, `file: ref.file`, `side: "working"`), `threadTargetFor` (existence via `documentNotePath`) and `uriForTarget` (`documentNotePath` with `target.document`). New inspection accessor `commentableDocuments(): string[]` — `toString()` of every open text document whose `provideCommentingRanges` result is non-empty.
- `src/extension.ts`: passes `() => reviewDocuments`; `readDocumentContent(document, fileName)` guards with `isDocumentNoteFileName` and reads `documentNotePath(...)`; `noteTargetUri` and `openDocumentNote` resolve through `documentNotePath`; `__inspect` adds `commentableDocuments`.
- No realpath canonicalisation: the tree opens documents with the exact path string the controller compares against. If the scripted check shows a cluster notes doc not commentable, the implementer reports it rather than guessing a fix.

### Surfaces

- `src/notesGrouping.ts`: `clusterNotesDocumentLabel` is replaced by `documentNoteGroupLabel(document, file, clusterLabels)` — `"Branch overview"` for `"branch"`, today's cluster behaviour otherwise — and `documentNoteGroupDescription(document, count)` — `branch overview · <n>` / `cluster notes · <n>`. Sort: document groups first with the `"branch"` group ahead of cluster notes groups, then code groups; within a kind, by file. Group keys and `notesGroupCollapseKey` are unchanged (already `(document, file)`).
- `src/notesTreeProvider.ts`: `documentLabel` callback takes `(document, file)`; description from `documentNoteGroupDescription`.
- `src/treeProvider.ts`: Branch overview tooltip text becomes `Branch overview, written by the agent. Click to open the preview; use Open Source to select lines and leave a review note.`

### Docs and versions

- `plugin/skills/review-notes/SKILL.md`: the `version`/`document` bullet and Document note bullet cover both values and the branch document path `<COMMON_DIR>/delta-review/<file>`.
- `DEVELOPMENT.md`: "Notes on cluster notes documents" becomes "Notes on review documents", covering both kinds; the noteTarget paragraph mentions both.
- `plugin/.claude-plugin/plugin.json` `0.12.0` → `0.13.0`; `package.json` `0.17.0` → `0.18.0`.

### Removed

- `clusterNotesFileName` (commentController.ts) and `clusterNotesDocumentLabel` (notesGrouping.ts), replaced in the tasks that introduce their successors.

## Hard-to-undo

- Public notes contract change: notes files may now contain `"document": "branch"` at `"version": 2`; extension 0.17.0 and earlier reject such files (accepted per goals). Documented in `plugin/skills/review-notes/SKILL.md`.
- Version bumps: plugin `0.13.0` (`plugin/.claude-plugin/plugin.json`), extension `0.18.0` (`package.json`).

## Task index

| Task file | What | Files |
| --- | --- | --- |
| `01_01_branch-note-contract.md` | Accept `document: "branch"` in the notes parser; add document-note path/detection helpers and new `ReviewDocuments` fields | `src/notes.ts`, `src/documents.ts` |
| `01_02_branch-note-plumbing.md` | Make the Branch overview commentable in source mode; route document notes by kind through target, store, controller and extension; add `commentableDocuments` inspection | `src/noteTarget.ts`, `src/notesStore.ts`, `src/commentController.ts`, `src/extension.ts` |
| `01_03_branch-note-surfaces.md` | REVIEW NOTES label/description/order for branch-document notes; Branch overview row tooltip | `src/notesGrouping.ts`, `src/notesTreeProvider.ts`, `src/extension.ts`, `src/treeProvider.ts` |
| `01_04_branch-note-docs.md` | Update the public notes contract, DEVELOPMENT.md, and bump plugin and extension versions | `plugin/skills/review-notes/SKILL.md`, `DEVELOPMENT.md`, `plugin/.claude-plugin/plugin.json`, `package.json` |
