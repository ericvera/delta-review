# 02_04 Clicking into a file in the combined diff selects its sidebar row

## Goal

While a Delta Review combined cluster diff (`Cluster Changes: <label>`) is the active tab, moving the cursor into a file's text on either side (click or keyboard) selects that file's row in the Delta Review pane without taking keyboard focus, so its existing Mark Reviewed button is one click away. Skip when:

- the pane is not visible (hidden or collapsed);
- the row is already selected;
- the active tab is anything other than one of our combined diffs (an ordinary editor or a single-file diff);
- the active repo root or branch is not the one the tab was opened from.

## Files to modify/create

- `src/extension.ts`
- `DEVELOPMENT.md`

## Background

- Task 02_02 added `type ClusterChangesEntry = { clusterKey; label; paths; leftSides; repoRoot; branch }` (`leftSides: { path; basePath; baseQuery }[]`: per shown file, its path plus the left URI's path without leading `/` and its query exactly as opened; the tab's left documents keep that sha even after the model's `diffBaseSha` changes from a sidebar mark or re-snapshot; `repoRoot`/`branch`: the repo and branch the tab was opened from) and `clusterChangesTabs: Map<title, ClusterChangesEntry>` (the paths shown in the one open combined diff per title). Task 02_03 added `activeClusterChanges(): ClusterChangesEntry | undefined`, which returns the active combined diff's full entry or undefined.
- Task 02_01 added in `src/clusterChanges.ts`:
  - `fileForDiffDocument(files, doc)`, where `doc` is `{ scheme: "file"; path }` or `{ scheme: "base"; path; query }` with a repo-relative path and no leading `/`;
  - `isRowAlreadySelected(selectedPaths, path)`;
  - `sameClusterChangesSource(entry, current)` (both `{ repoRoot; branch }`).
- VS Code facts (VS Code `main`): the inner editors of a multi-diff are registered code editors, so `window.onDidChangeActiveTextEditor` fires when the user clicks into a file's text. A left-side click makes the base editor active, whose `document.uri` has scheme `REVIEW_BASE_SCHEME` (`delta-review-base`, `src/contentProvider.ts:5`), path `/<diffBasePath>` and query `<sha>|empty`. A right-side click gives `file:` URIs under `git.repoRoot`, or for a deleted file a base URI with query `empty`. A click only on a file's header fires nothing; that is accepted.
- `revealFileRow(file)` (`src/extension.ts:740-751`) calls `treeView.reveal(fileElementFor(...), { select: true, focus: false })` and swallows errors. The review-notes click handlers (`src/extension.ts:952, 984`) are its only callers. Those open single-file diffs, so they never coincide with an active combined diff, and no extra coordination is needed beyond the active-tab check.
- `treeView` is created at `src/extension.ts:153`. `treeView.visible` and `treeView.selection` (`ReviewTreeElement[]`; file elements are `{ kind: "file", file }`) are stable API.
- Existing scheme check precedent: `src/extension.ts:1323-1324`.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Add a `vscode.window.onDidChangeActiveTextEditor((editor) => …)` subscription (push it into `context.subscriptions`):
   - Return when `editor` is undefined, `git`/`model` is undefined, or `!treeView.visible`.
   - Set `entry = activeClusterChanges()` and return when it is undefined.
   - Return when `!sameClusterChangesSource(entry, { repoRoot: git.repoRoot, branch: model.branch })`, before mapping any URI: after an SCM repo switch or a branch checkout, the tab's repo-relative paths would otherwise resolve against another repo's or branch's files.
   - Map `editor.document.uri`. For scheme `file`, compute `relative(git.repoRoot, uri.fsPath)` with posix separators and return when it starts with `..`; this gives `{ scheme: "file", path }`. For scheme `REVIEW_BASE_SCHEME`, this gives `{ scheme: "base", path: uri.path.replace(/^\//, ""), query: uri.query }`. For any other scheme, return.
   - Set `files = model.files.filter(f => entry.paths.includes(f.path))`.
   - For a `"base"` doc, first look for `side = entry.leftSides.find(s => s.basePath === doc.path && s.baseQuery === doc.query)`; when found, `file = files.find(f => f.path === side.path)`. Do not match left sides against the current model's `diffBaseSha`: it moves on when the file is marked or re-snapshotted while the tab stays open.
   - Otherwise (a `"file"` doc, or a `"base"` doc matching no recorded left side, i.e. a deleted file's right side) set `file = fileForDiffDocument(files, doc)`.
   - Return when there is no file.
   - Set `selected = treeView.selection.flatMap(e => e.kind === "file" ? [e.file.path] : [])`. Return when `isRowAlreadySelected(selected, file.path)`.
   - Run `void revealFileRow(file)`.
2. A file that is now Reviewed (marked from the sidebar while the diff stays open) still reveals: `fileElementFor` places it in the Reviewed bucket. That is fine.
3. `DEVELOPMENT.md`: add manual step `31d.`, covering:
   - In a combined diff, click into the second file's right side, and its row is selected in the pane while the cursor stays in the diff. Click its left side, and the same row stays selected.
   - Arrow-key down into the next file, and its row follows.
   - Collapse the Delta Review view, and clicks change nothing.
   - In an ordinary editor or a single-file diff, the selection does not follow.
   - Switch the active SCM repo (or check out another branch) with the combined diff still open, and clicks in it change nothing.
   - After a per-file `+` from the sidebar, the combined diff tab stays as it is, and clicking that file's left side still selects its row.

## Gotchas

- Use `uri.fsPath` plus `path.relative`, and normalize `\` to `/` so Windows paths match repo-relative `ReviewFile.path`.
- Do not call `treeView.reveal` when `!treeView.visible`: reveal would force the view open.
- `revealFileRow` must not be awaited in a way that blocks the event; fire and forget (it already catches).
- Keyboard navigation between files inside the multi-diff also changes the active text editor, and that is intended.
- Run `yarn format` before finishing.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`. 02_01's tests cover `fileForDiffDocument` and `isRowAlreadySelected`.
- Scripted extension-host check (DEVELOPMENT.md recipe; scratchpad harness): driving a click inside a multi-diff is not reliably scriptable. Assert the negative path instead: with the combined diff open, then `showTextDocument` on a cluster file in a normal editor (the active tab is now a text tab), `treeView` selection is unchanged. Check via `deltaReview.__inspect` only if it already exposes selection; otherwise skip this. Record the positive path as eyeball-only in the task's handoff.
