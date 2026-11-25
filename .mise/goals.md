would it be possible to add comments to the markdown preview? Like the branch notes? Today it seems like it is not possible to add notes even when in edit mode

## Investigation

- Not reproduced live (extension-host launch steals focus); findings from code.
- The preview cannot take comments: `deltaReview.previewDocument` runs `markdown.showPreview` (src/extension.ts:1785), a webview; the Comments API (src/commentController.ts:184) only gives commenting ranges on text documents. Notes in the preview need a custom webview or preview script.
- Edit-mode failure is likely the Branch overview document: the commenting range provider accepts `file:`/review-base URIs (commentController.ts:216-251), and outside the diff only names matching `CLUSTER_NOTES_FILE_PATTERN` directly inside `clusterNotesDir` (commentController.ts:197-208, 227). The branch doc lives one level up at `<common>/delta-review/branch-<branch>.md` (src/documents.ts:22-23, 53), so no `+` gutter in source mode.
- Cluster notes docs are already commentable in source mode (tooltip treeProvider.ts:677-678; branch tooltip treeProvider.ts:664-665 does not say so). Unverified suspect if a cluster doc failed: exact `dirname` equality (commentController.ts:204) vs symlink/realpath mismatch between repoRoot and git common dir (documents.ts:29-36).
- Data model has no branch-document note: `NoteDocument` is only `"clusterNotes"` (src/notes.ts:17); validator rejects other values (notes.ts:155-166); creation tags only cluster notes (commentController.ts:870, 901); targets resolve under `clusterNotesDir` (extension.ts:1299-1316; noteTarget.ts:35-43, 67-69); REVIEW NOTES grouping keys on `document` (notesGrouping.ts:13-23, 62-67).
- Hard to undo: notes contract is public — plugin/skills/review-notes/SKILL.md:75-77 fixes `document` to `"clusterNotes"`. A new value is a contract change needing a notes-file version decision (notes.ts:367-369) and plugin bump (plugin 0.12.0, extension 0.17.0).
- Patterns: branch-doc detection like `clusterNotesFileName` (commentController.ts:197); parse rules in notes.ts (+notes.test.ts); target resolution in noteTarget.ts (+test); grouping/labels in notesGrouping.ts (`clusterNotesDocumentLabel` :48, +test); extension-host checks via `deltaReview.__inspect` (DEVELOPMENT.md:238-251).
- Open: which doc "branch notes" means; whether source-mode notes should render in the preview; tooltip/click behaviour of the branch row (treeProvider.ts:661-688); preview UI change matches Mock conditions.

## Open questions

1. Which document should take notes?
2. How should notes show up while previewing?
3. Contract value for branch-doc notes?
