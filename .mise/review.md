# Review

## Tasks

- 01_01 Document rows preview and skim label: Cluster notes and Branch overview rows click to the markdown preview (`documentClickCommand`, src/treeParents.ts); both get an inline "Open Source" (go-to-file) action (package.json); Cluster notes row has no description (`notesDocumentSummary` removed, src/documents.ts); skim files read `name · skim` in the label (`withLevelLabel`, src/reviewLevel.ts) with no `skim` in the description; tooltips reworded; DEVELOPMENT.md/README.md updated. Verify: F5, click each document row → preview opens; hover → Open Source opens the editor and line notes work on Cluster notes; skim files show `· skim` in tree and list modes.
- Fix round 1: Branch overview tooltip no longer claims review notes can be left on it (src/treeProvider.ts:665).

## Open assumptions

- The `· skim` tag takes the row's label color (git tint, dim on reviewed/waiting rows).
- Clicking a note under REVIEW NOTES still opens the source at the note.
- `deltaReview.openDocument` retitled "Open Source"; stays hidden from the palette.
- Not done: manual hover and command-palette check in the dev host.

## Amendments

- none
