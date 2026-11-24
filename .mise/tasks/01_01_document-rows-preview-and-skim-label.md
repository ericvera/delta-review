# 01_01 Document rows open the preview; skim tag moves into the label

## Goal

In the Delta Review sidebar tree (VS Code extension):

- Clicking a **Cluster notes** row opens the markdown preview (`deltaReview.previewDocument`), as the **Branch overview** row already does.
- Both document rows (Cluster notes and Branch overview) get one inline hover action, **Open Source** (`deltaReview.openDocument`, `$(go-to-file)`), which opens the markdown file in a text editor. The Cluster notes row's inline **Open Preview** action is removed.
- The Cluster notes row shows no description (today e.g. `intro · reading order · 3 questions`). The now-unused summary computation is removed.
- Skim file rows show the tag in the label (`foo.ts · skim`), keeping the file-type icon, in tree and list mode; `skim` no longer appears in the row description. The hover tooltip line is unchanged.
- Document row tooltips are reworded to point at Open Source for leaving review notes.

## Files to modify/create

- `src/treeParents.ts`
- `src/reviewLevel.ts`
- `src/treeProvider.ts`
- `src/documents.ts`
- `package.json`

Docs (not source): `DEVELOPMENT.md`, `README.md`.
Tests: `src/treeParents.test.ts`, `src/reviewLevel.test.ts`, `src/documents.test.ts`.

## Background

- Document rows are built in `documentTreeItem` (`src/treeProvider.ts:650-701`). The click command is a ternary at `src/treeProvider.ts:687-698`: branch → `deltaReview.previewDocument`, cluster notes → `deltaReview.openDocument`. The Cluster notes description is set from `clusterNotesFor(...)?.summary` at `src/treeProvider.ts:668-674`. Tooltip text: `src/treeProvider.ts:666` (branch) and `src/treeProvider.ts:681-683` (cluster notes).
- Both commands are registered in `src/extension.ts:1767-1787` and accept a `Uri` (row click) or a `DocumentElement` (inline action) via `documentUriFor` (`src/extension.ts:1435-1447`). No change needed in `src/extension.ts`.
- `documentPathFor` (`src/treeParents.ts:222-229`, tested at `src/treeParents.test.ts:427-498`) is the pure-helper pattern to follow; `src/treeParents.ts` has no `vscode` import.
- File rows: `fileTreeItem` in `src/treeProvider.ts` builds the row from `resourceUri` (`createReviewItemUri`, `src/treeProvider.ts:556`) with no explicit label; description is `withLevelTag(file.reviewLevel, buildRowDescription({...}))` at `src/treeProvider.ts:571-582`; skim tooltip line `SKIM_TOOLTIP` at `src/treeProvider.ts:611-613`.
- `withLevelTag` and `SKIM_TOOLTIP` live in `src/reviewLevel.ts:1-16`, tested in `src/reviewLevel.test.ts`.
- Precedent for label + `resourceUri` together (label text wins, decoration color still tints it): `src/treeProvider.ts` Unclustered header (`item.resourceUri = createUnclusteredHeaderUri()` with an explicit `item.label`).
- `ClusterNotesDocument.summary` and `notesDocumentSummary` (`src/documents.ts:6-10`, `:40-76`, `:110`) exist only to feed the removed description (only consumer: `src/treeProvider.ts:668-674`). Tests: `src/documents.test.ts:79-102` and the `summary` expectation at `:151`; `src/treeParents.test.ts` fixtures carry `summary: "intro"`.
- Manifest: `deltaReview.openDocument` command at `package.json:81-85` (no icon, title `Open Document`); inline menu entry `previewDocument` for `clusterNotesDocument` at `package.json:297-301`; command palette hides both at `package.json:525-532`. `openFile` uses `$(go-to-file)` at `package.json:76-79`.
- Context values: Branch overview row `branchDocument`, Cluster notes row `clusterNotesDocument`.
- Decisions that reach this task: click → preview for both document kinds; inline action is Open Source only; Branch overview gets it too; `deltaReview.openDocument` stays hidden from the command palette; command IDs unchanged; clicking a note under REVIEW NOTES still opens the source (`openDocumentNote`, untouched); the label tag takes whatever color the label gets (git tint, or dim on reviewed/waiting rows).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `src/treeParents.ts`: add beside `documentPathFor`:
   ```ts
   // Both document kinds click to the rendered preview; the source editor is
   // the inline Open Source action
   export const documentClickCommand = (_element: DocumentElement): string =>
     "deltaReview.previewDocument";
   ```
   (Naming/shape may vary; keep it pure and keyed on the element.)
2. `src/treeProvider.ts` `documentTreeItem`:
   - Replace the ternary with `command: documentClickCommand(element)`, `title: "Open Preview"`, `arguments: [vscode.Uri.file(path)]`.
   - Delete the summary/description block (`:668-674`); drop the `clusterNotesFor` import if it becomes unused.
   - Tooltips:
     - Branch: `Branch overview, written by the agent. Click to open the preview; use Open Source to select lines and leave a review note.`
     - Cluster notes: `` `Notes document for ${escapeMarkdownText(label)}. Click to open the preview; use Open Source to select lines and leave a review note.` ``
3. `src/reviewLevel.ts`: replace `withLevelTag` with a label helper, e.g.
   ```ts
   export const withLevelLabel = (level: ReviewLevel, name: string): string =>
     level === "skim" ? `${name} · skim` : name;
   ```
   Keep `SKIM_TOOLTIP`.
4. `src/treeProvider.ts` `fileTreeItem`: `item.description = buildRowDescription({...})` (no level tag). When `file.reviewLevel === "skim"`, set `item.label = withLevelLabel(file.reviewLevel, basename(file.path))`; keep `resourceUri` so the file-type icon and M/A/D/R decoration remain. Leave `iconPath` unset. (Setting the label unconditionally is also fine as long as non-skim rows render the same basename.)
5. `src/documents.ts`: remove `summary` from `ClusterNotesDocument`, remove `notesDocumentSummary` and its now-unused `LIST_ITEM`/`HEADING` regexes; `loadReviewDocuments` still reads the file to test existence (`readText(...) !== undefined`).
6. `package.json`:
   - `deltaReview.openDocument`: title `Open Source`, add `"icon": "$(go-to-file)"`.
   - Replace the `view/item/context` `previewDocument` inline entry with `{ "command": "deltaReview.openDocument", "when": "view == deltaReview && viewItem =~ /^(branchDocument|clusterNotesDocument)$/", "group": "inline@1" }`.
   - Keep both commands hidden in `commandPalette`.
7. Docs:
   - `DEVELOPMENT.md:147`: Cluster notes row has no description; both rows click → `deltaReview.previewDocument` (via `documentClickCommand`); both rows' inline `$(go-to-file)` → `deltaReview.openDocument` (source). `:148` still holds.
   - `DEVELOPMENT.md:303` (check 31h): label reads `<name> · skim` in tree and list mode, description carries no `skim` (list mode shows just the directory), tooltip line unchanged.
   - `DEVELOPMENT.md:308-309` (31j, 31k): 31k: notes row has no description; click → the preview opens; inline `$(go-to-file)` → the source opens; 31j: Branch overview inline `$(go-to-file)` → the source opens.
   - `DEVELOPMENT.md:330` (45a): "open … from its row" → "open … with its row's inline Open Source".
   - `README.md:68`: skim files show `· skim` after their name. `README.md:69` unchanged.
   - `plugin/skills/cluster/SKILL.md` does not describe rendering; leave it.

## Gotchas

- `vscode` cannot be imported under Vitest; keep the new helpers in `src/treeParents.ts` / `src/reviewLevel.ts` free of it.
- The test hook `deltaReview.__inspect` (`src/extension.ts:2170-2195`) reports `label` from `item.label` when it is a string, else the `resourceUri` basename — so a skim row's inspected label becomes `foo.ts · skim`. No change needed there.
- Do not set `iconPath` on skim rows: that replaces the file-type icon.
- Moving `skim` out of the description changes list-mode skim rows from `skim · src` to `src`, and tree-mode skim rows from `skim` to no description.
- No `REQ-*` identifiers; comments explain why, not what.
- `yarn format` must not touch `.mise/`.

## Verification

- Run: `yarn lint`, `yarn build`, `yarn test`.
- Tests this task writes:
  - `src/treeParents.test.ts`: `documentClickCommand` returns `deltaReview.previewDocument` for the branch element and for a cluster notes element (the cluster-notes case fails against today's behavior); drop `summary` from fixtures.
  - `src/reviewLevel.test.ts`: replace `withLevelTag` tests with `withLevelLabel`: `review` → name unchanged; `skim` → `name · skim`. Keep the `SKIM_TOOLTIP` test.
  - `src/documents.test.ts`: remove the `notesDocumentSummary` describe block and the `summary` key in the `loadReviewDocuments` expectation (drop `MOCK_DOCUMENT` only if nothing else uses it).
- Scripted extension-host check (`DEVELOPMENT.md`, "Scripted extension-host checks"; launch with `env -u ELECTRON_RUN_AS_NODE` and a short `--user-data-dir`), in a temp repo with a contract that has one cluster with a `levels` skim file and a notes document plus a branch document, grouped list mode, via `deltaReview.__inspect` `treeRows`:
  - the Cluster notes row has `description` undefined;
  - the skim file row's `label` is `<name> · skim` and its `description` contains no `skim`;
  - after switching to tree mode the skim row's label still ends in ` · skim`;
  - executing `deltaReview.previewDocument` with the notes document Uri leaves no text editor for it open (`vscode.window.visibleTextEditors`), and `deltaReview.openDocument` with the document element opens it in a text editor.
- Manual (dev host, eyeball only): hovering either document row shows one `$(go-to-file)` button titled Open Source; Open Source is absent from the command palette.
