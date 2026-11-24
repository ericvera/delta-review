# 01_06 Branch overview and cluster notes rows

## Goal

The DELTA REVIEW tree shows a "Branch overview" row first when the branch document exists, and a "Cluster notes" row first inside each real cluster whose notes document exists. Clicking opens the document (preview for the branch row, source for the notes row); the notes row has an inline preview action. Documents appear and disappear live.

## Files to modify/create

- `src/treeProvider.ts`
- `src/treeParents.ts`
- `src/extension.ts`
- `package.json`
- `DEVELOPMENT.md`

## Background

- Task 01_05 added `src/documents.ts`: `deltaReviewDirFor(git)`, `loadReviewDocuments(dir, branch, labels)` → `ReviewDocuments { clusterNotesDir; branchDocument?: string; clusterNotes: Map<number, { path; fileName; summary }> }` (key = cluster index, matching cluster key `c<index>`).
- Tree structure: element union `ReviewTreeElement` (`src/treeProvider.ts:94-101`), `CollapsibleElement` (`:103-108`), root children (`:183-211`), cluster children `clusterChildren` (`:282-320`), `getTreeItem` (`:385+`), message rows have no icon/command (`:463-470`). Provider constructor (`:158-168`) is built in `src/extension.ts:184-192`.
- Parent chain for `TreeView.reveal`: `parentOf` in `src/treeParents.ts:134-173`.
- Inline and context menu actions in `view/item/context` invoke their command with the tree element, not `item.command.arguments`: see inline `deltaReview.openFile` (`package.json:286-289`) whose handler takes `element?: ReviewTreeElement` (`src/extension.ts:1638-1644`). Row clicks pass `item.command.arguments`.
- Collapse persistence handlers skip non-collapsible kinds by `element.kind === "file" || element.kind === "message"` (`src/extension.ts:230-252`).
- Refresh: contract loaded at `src/extension.ts:413`; cluster model set at `:502-512`; `treeProvider.setModel` at `:516`; no-repo reset at `:380-391`.
- Contract-dir watcher: `watchContractDir` (`src/extension.ts:787-814`) watches `*.json` only.
- `package.json`: commands, `view/item/context` (`:285+`) with `inline@N` groups, `commandPalette` hides internal commands with `"when": "false"` (`:500+`). Existing `viewItem` regexes (`needsReviewFile`, `reviewedFile`, `needsReviewFolder`, …) must not match the new context values.
- Design decisions:
  - `DocumentElement = { kind: "document"; document: "branch" } | { kind: "document"; document: "clusterNotes"; clusterKey: string }`, added to `ReviewTreeElement`, not collapsible.
  - Branch row: root, first, in grouped and ungrouped modes and both layouts. Label `Branch overview`, icon `book`, no description, id `document:branch`, contextValue `branchDocument`, tooltip = path code block + `Branch overview, written by the agent.`, command `deltaReview.previewDocument` with the file `Uri`.
  - Cluster notes row: first child of a real cluster (`c<n>`) in every body state (files, `All files reviewed.`, empty-cluster message), grouped mode only, both layouts. Label `Cluster notes`, icon `note`, description = the document's `summary` (omit when empty), id `document:clusterNotes:<clusterKey>`, contextValue `clusterNotesDocument`, tooltip = path code block + `Notes document for <label>. Click to open it; select lines to leave a review note.`, command `deltaReview.openDocument` with the file `Uri`. Never under Unclustered, Auto or Reviewed.
  - Both commands take `target?: vscode.Uri | ReviewTreeElement`: a `Uri` (row click) is used as is; a `DocumentElement` (the inline `$(open-preview)` action passes the element) resolves via `documentPathFor(reviewDocuments, element)`; anything else or an unresolvable element is a no-op.
  - `documentPathFor(documents: ReviewDocuments | undefined, element: DocumentElement): string | undefined` lives in `src/treeParents.ts` (type-only imports keep it vscode-free): branch → `documents.branchDocument`; clusterNotes with key `c<n>` → `documents.clusterNotes.get(n)?.path`; any other key or missing document → undefined.
  - Document rows have no review state, no dim, no resourceUri decoration.
  - Labels come from the contract only when it is `ok`; otherwise no cluster notes (the branch document is still looked up).
  - Watcher glob widens to `{*.json,*.md,cluster-notes-*/*.md}`.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `src/treeProvider.ts`: add `DocumentElement`; constructor parameter `getDocuments: () => ReviewDocuments | undefined` (last parameter); prepend rows in root (both modes) and `clusterChildren` (real clusters only); `getTreeItem` branch for `document`. Use `vscode.Uri.file(path)` for command arguments and `appendCodeblock(path, "text")` for the tooltip, like file rows.
2. `src/treeParents.ts` `parentOf`: `document` → branch: `undefined`; clusterNotes: `{ kind: "cluster", clusterKey }`. Add `documentPathFor` (above); type-only import of `ReviewDocuments` from `./documents`.
3. `src/extension.ts`: `let reviewDocuments: ReviewDocuments | undefined`; in refresh, after the contract load and before `setModel`, `reviewDocuments = await loadReviewDocuments(await deltaReviewDirFor(git), branch, labels)` (with the usual `generation !== refreshGeneration` bail-out); reset in the no-repo path; pass `() => reviewDocuments` to the provider; skip `document` in the collapse/expand handlers; register `deltaReview.openDocument` (`vscode.window.showTextDocument(uri)`) and `deltaReview.previewDocument` (`vscode.commands.executeCommand("markdown.showPreview", uri)`), each resolving its argument through a local `documentUriFor(target)` (`target instanceof vscode.Uri` → itself; `target?.kind === "document"` → `documentPathFor(reviewDocuments, target)` wrapped in `vscode.Uri.file`; else undefined → return); widen the watcher glob.
4. `package.json`: contribute both commands (titles `Open Document`, `Open Preview`; icon `$(open-preview)` on the preview command); `view/item/context` inline entry for `deltaReview.previewDocument` when `view == deltaReview && viewItem == clusterNotesDocument`; hide both from `commandPalette`.
5. `DEVELOPMENT.md`: a "Documents" subsection under "How it works" (paths, slug, discovery per refresh, watcher glob, row placement, no review state); update the watcher bullet in "ClusterModel flow" and the Review notes "watcher" bullet; manual steps (no documents → tree as today; branch doc → first row in all four layouts, opens preview; notes doc for one cluster only; fully reviewed cluster keeps the notes row; rename the file → row disappears live).

## Gotchas

- Adding `document` to `ReviewTreeElement` breaks the exhaustive `switch` in `parentOf` and the collapse handlers' narrowing to `CollapsibleElement` until handled — handle, do not cast.
- The document load must not throw a refresh: `loadReviewDocuments` never throws for missing files; keep `deltaReviewDirFor` inside the refresh's try.
- Do not type the handler parameter as `vscode.Uri` only: the inline action passes a `DocumentElement`, and `markdown.showPreview` given a non-Uri silently previews the active editor instead.
- `markdown.showPreview` is provided by the built-in markdown extension; pass the `Uri` as the first argument.
- The selection-sync listener (`onDidChangeActiveTextEditor`) only handles repo files; a document outside the repo must be a no-op there (it is today — verify, do not change).

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Write in `src/treeParents.test.ts`: `parentOf` for both document kinds; `documentPathFor` for branch present/absent, clusterNotes present, clusterNotes key with no document, non-`c<n>` key, and `undefined` documents.
- Scripted extension-host check (`DEVELOPMENT.md`, "Scripted extension-host checks"; `env -u ELECTRON_RUN_AS_NODE`, short `--user-data-dir`, throwaway repo, `DELTA_REVIEW_TEST=1`): with a v4 contract of two clusters, a branch document and a notes document for one cluster, assert `treeRows` from `deltaReview.__inspect` in grouped list mode — first row `document:branch` (`book`), the first child of the documented cluster `document:clusterNotes:c0` (`note`, summary description), no notes row in the other cluster; ungrouped — branch row first; invoke `deltaReview.previewDocument` with the element `{ kind: "document", document: "clusterNotes", clusterKey: "c0" }` (the inline-action path) and assert a tab opened whose `input` is a `vscode.TabInputWebview` with `viewType` containing `markdown.preview` and label containing the notes file's name (`Preview <file>`); invoke `deltaReview.openDocument` with the same element and assert `vscode.window.activeTextEditor.document.uri.fsPath` is the notes file; invoke `deltaReview.previewDocument` with the notes file `Uri` (row-click path) and assert the same preview tab; delete the branch document → after the watcher refresh it is gone. Harness in the session scratchpad.
