is it possible when tapping on the cluster notes to default to the markdown reader rather than the editor?

## Investigation

- Cluster notes row click runs `deltaReview.openDocument` → `showTextDocument` (src/treeProvider.ts:694-698, src/extension.ts:1767-1776). Branch overview row already runs `deltaReview.previewDocument` → `markdown.showPreview` (src/treeProvider.ts:688-693, src/extension.ts:1778-1787).
- Core change: drop the ternary at src/treeProvider.ts:687-698 so both document kinds click to `previewDocument`.
- Cluster row's only inline action is `previewDocument` `$(open-preview)` (package.json:297-301). `openDocument` has no menu entry or icon (package.json:81-85, hidden at 525-528). Once preview is the click default, the source editor is unreachable from the row unless the inline action becomes `openDocument` (icon e.g. `$(go-to-file)` as `openFile` uses, package.json:76-79). Button change matches Mock condition "new commands/buttons".
- Tooltip "Click to open it; select lines to leave a review note" (src/treeProvider.ts:681-683) becomes wrong: notes need a text editor (src/commentController.ts:197-227), not the preview.
- Unaffected: clicking a note under REVIEW NOTES still opens the source at the note (`openDocumentNote`, src/extension.ts:1308-1329).
- Docs: DEVELOPMENT.md:147, :309 (step 31k), :330 (step 45a). README.md:69 neutral.
- Tests: `treeProvider.ts` imports `vscode`; extract the DocumentElement click-command choice into a pure helper beside `documentPathFor` in src/treeParents.ts:222-229, tested in src/treeParents.test.ts:417-460. Click itself → scripted test-electron check (DEVELOPMENT.md:241).
- Nothing hard to undo; no data, schema or contract change; command IDs unchanged.
- Branch overview rows have no inline source action (no menu entry targets `branchDocument`).

## Open questions

1. How does the reviewer reach the source editor (to leave line notes) once click opens the preview?
2. Should Branch overview rows get the same inline "open source" action?
