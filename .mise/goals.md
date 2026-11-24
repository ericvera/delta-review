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

## Decisions

- Clicking a Cluster notes row opens the markdown preview (`deltaReview.previewDocument`), matching Branch overview.
- The Cluster notes row's inline action changes from "Open Preview" to "Open Source" (`deltaReview.openDocument`, go-to-file icon); the preview inline action is dropped.
- Branch overview rows get the same inline "Open Source" action.
- The Cluster notes row shows no description text beside its label (today e.g. "intro • 4 questions").
- Skim file rows carry the tag in the label (`foo.ts · skim`), keeping the file-type icon, in both tree and list mode.
- `skim` is removed from the row description; the hover tooltip still explains it.

## Assumptions

- Row tooltips are reworded: click opens the preview; use the inline "Open Source" action to select lines and leave a review note.
- Clicking a note under REVIEW NOTES keeps opening the source at the note.
- `deltaReview.openDocument` stays hidden from the command palette; it only gains an icon and inline menu entries.
- The click-command choice for a document row moves into a pure helper (src/treeParents.ts) so a unit test fails without the change.
- DEVELOPMENT.md lines 147, 309 (step 31k) and 330 (step 45a) are updated; README.md:69 unchanged.
- The label tag takes whatever color the row's label gets (git change tint, or dim on reviewed/waiting rows), since a FileDecoration colors the whole label.
- Skim docs updated: DEVELOPMENT.md:303 (check 31h), README.md:68, plugin/skills/cluster/SKILL.md:172 where they describe the rendering.
- Mock guesses: exact tooltip wording, sample cluster names/paths/content, preview tab title, add-note box look.

## Investigation: skim label

- `skim` is plain text in file-row `description` only (`withLevelTag`, src/reviewLevel.ts:6-16, test src/reviewLevel.test.ts:11-18; used at src/treeProvider.ts:571-582) plus hover tooltip `SKIM_TOOLTIP` (src/reviewLevel.ts:3-4, src/treeProvider.ts:611-613). Descriptions always render in VS Code's dim color; the API cannot recolor or bold them.
- Label comes from `resourceUri` (src/treeProvider.ts:557), no `iconPath`; M/A/D/R badge/color from src/decorations.ts:89-154. Reviewed/waiting rows in grouped mode get `DIM_COLOR` on the label (src/treeProvider.ts:546-556).
- Options: label highlights (precedent src/notesTreeProvider.ts:149); tag in label; colored `ThemeIcon` iconPath (precedent src/treeProvider.ts:724-726, replaces file-type icon); FileDecoration badge/color (competes with M/A/D/R and dim color); description glyph tweak (small gain).
- Docs stating current form: DEVELOPMENT.md:303 (check 31h), README.md:68, plugin/skills/cluster/SKILL.md:172.

## Proposal

- Issue: Cluster notes rows open the source editor and carry a "intro • 4 questions" description that adds nothing; the `skim` tag fades into the dim description.
- Approach: both document rows click to the markdown preview with an inline "Open Source" (go-to-file) action; drop the Cluster notes description; move `skim` from description into the label (`foo.ts · skim`); pure helpers + unit tests; docs updated.
- Skips: spec and critic (one module, no schema or API change).
