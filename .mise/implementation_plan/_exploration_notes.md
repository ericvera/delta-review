# Exploration Notes

Verified against source on 2026-07-16 (branch `agentic-change-review`).

## Module map (all in `src/`)

- `git.ts` — `Git` interface (`repoRoot`, `run(args, {stdin, env})` via execFile, stderr in rejection). Helpers: `splitNulTerminated`, `parseLsTreeOutput` (path → blob sha).
- `model.ts` — `FileReviewStatus` enum (`NeedsReview`/`Reviewed`), `ReviewFile` (`path`, `status`, `deleted`, `existsInMergeBase`, `diffBaseIsReviewedSnapshot`, `diffBaseSha`), `ReviewModel` (`branch`, `mergeBase`, `files`). `computeReviewModel(git, baseBranch)` (model.ts:35): branch via `rev-parse --abbrev-ref HEAD`; mergeBase via `merge-base baseBranch HEAD` (throws user-facing error); paths = `diff --name-only --no-renames -z <mergeBase>` ∪ `ls-files --others --exclude-standard -z`, sorted; review state compared by blob sha (`hash-object --stdin-paths` for existing files, sentinel sha for deleted).
- `reviewState.ts` — `DELETED_SENTINEL_CONTENT`, `reviewRefForBranch` (`refs/review/<branch>`), `readReviewState` (ls-tree of ref → Map), `writeReviewState` (temp GIT_INDEX_FILE → write-tree → commit-tree with parent → update-ref), `markReviewed(git, branch, paths)` (hash-object -w current content; sentinel for deleted), `unmarkReviewed`.
- `treeProvider.ts` — `ViewMode = 'list' | 'tree'`. Elements: `GroupElement {kind:'group', status}`, `FolderElement {kind:'folder', status, path}`, `FileElement {kind:'file', file}`. `collapseKeyFor(element)` (treeProvider.ts:29): group → bare status string, folder → `folder:<status>:<path>`. `ReviewTreeProvider` ctor takes `(isCollapsed(key), getViewMode())`. `getChildren`: root → two groups; group → list files or `treeChildren(status, '')`; folder → `treeChildren(status, path)`. `treeChildren` (treeProvider.ts:83): folders-then-files alphabetical, NO compaction. `getTreeItem`: groups = label + count in `description` + `id: group:<status>` + contextValue `needsReviewGroup`/`reviewedGroup`; folders = `createReviewFolderUri(path)` resourceUri (no decoration), contextValue `needsReviewFolder`/`reviewedFolder`; files = `createReviewItemUri(file)` resourceUri (M/A/D decoration via query), contextValue `needsReviewFile`/`reviewedFile` (+`Deleted` suffix), `description` = dirname in list mode only, MarkdownString tooltip, click command `deltaReview.openDiff`.
- `decorations.ts` — scheme `delta-review-item`. `createReviewItemUri(file)` carries change kind in query (`modified|added|deleted`); `createReviewFolderUri(path)` no query → no decoration. `createReviewDecorationProvider` maps query → FileDecoration (letter badge + gitDecoration ThemeColor). **Pattern to reuse for Unclustered warning color and any new colored rows: new query values → new FileDecorations.** TreeItem can set both `label` and `resourceUri`; explicit label wins, decoration still applies.
- `contentProvider.ts` — scheme `delta-review-base`; blob sha in query; `cat-file blob` renders diff left side.
- `extension.ts` — activation wires everything:
  - Collapse persistence: `deltaReview.collapsedGroups` workspaceState set (extension.ts:36-41), fed to provider; `onDidCollapseElement`/`onDidExpandElement` update it for non-file elements (extension.ts:73-84).
  - View mode: `deltaReview.viewMode` workspaceState + setContext `deltaReview.viewMode` (extension.ts:45-51); `setViewMode` (extension.ts:61); commands `viewAsTree`/`viewAsList` (extension.ts:85-90). package.json `view/title` menus swap the button via `when: view == deltaReview && deltaReview.viewMode == list|tree`, `group: navigation@0`.
  - `refresh()` (extension.ts:114): generation counter; reads `deltaReview.baseBranch` config (default `main`, extension.ts:125-128); sets `treeProvider.setModel`, `treeView.badge` (needs-review count), `treeView.message` (error text slot), status bar `$(checklist) Review n/m`.
  - `scheduleRefresh` debounce 400ms (extension.ts:165).
  - Repo watcher: `createFileSystemWatcher(RelativePattern(Uri.file(repoRoot), "**/*"))` (extension.ts:184) — **event delivery under `.git` is not guaranteed (varies by watcher type and `files.watcherExclude`); contract-file watching gets its own watcher on the `.git/delta-review` directory (non-workspace dirs are polled) AND a re-read on every refresh as fallback (focus/save/config triggers already exist).**
  - `setActiveRepo` (extension.ts:196), `openDiff` (extension.ts:210).
  - Commands: markFileReviewed/unmark (element.kind === 'file'), markFolderReviewed/unmark (filter `path.startsWith(element.path + '/')` + status), markAllReviewed/unmarkAll (all files by status), clearReviewState (modal confirm + update-ref -d).
  - Refresh triggers: onDidSaveTextDocument, window focus, onDidChangeConfiguration('deltaReview') (extension.ts:387-398), git repo `state.onDidChange` per repository (extension.ts:422).
  - Git extension API selection (`repo.ui.selected`) with fallback to first workspace folder.

## package.json anchors

- `contributes.commands` / `menus.view/title` / `menus.view/item/context` (inline `+`/`−` via contextValue regex matches) / `menus.commandPalette` (hides element-bound commands with `when: false`).
- `configuration.properties`: only `deltaReview.baseBranch` today — add `deltaReview.autoReview.globs` (array, default []) and `deltaReview.autoReview.markAutomatically` (boolean, default false) here.
- Scripts: `build` = `tsc -p .`, `package` = `vsce package -o delta-review.vsix --allow-missing-repository --no-dependencies`, `format`/`lint`/`test` (prettier/eslint/vitest, added at setup). `main`: `./out/extension.js`.
- devDependencies only (no `dependencies` yet). Yarn 3.3.1, nodeLinker: node-modules.
- tsconfig: ES2022/commonjs, rootDir src, outDir out, strict.

## Key implementation facts

- **`.git` dir**: use `git rev-parse --git-common-dir` (relative to repoRoot when inside; make absolute) so the contract lives in the shared `.git` across worktrees, same as review refs. Contract dir: `<common-dir>/delta-review/`.
- **linguist-generated**: `git check-attr --stdin -z linguist-generated` with NUL-joined paths on stdin; -z output is NUL-separated triplets `path attr value`; treat value `set` or `true` as generated.
- **Context keys** available for new buttons: add `deltaReview.clustersAvailable` (valid contract exists) and `deltaReview.grouped` (lever state). Grouping preference persists in workspaceState like `deltaReview.viewMode`.
- **treeView.message** accepts string; used today for errors — reuse for the invalid-contract warning (prefix ⚠, keep it while contract invalid).
- **Vitest cannot import `vscode`** — pure logic must live in modules with no vscode import (model.ts/git.ts/reviewState.ts are already vscode-free; keep triage + cluster logic that way).
- **esbuild**: bundle `src/extension.ts` → `out/extension.js`, `--external:vscode --platform=node --format=cjs`; keep `tsc --noEmit` as typecheck in Check. `.vscodeignore` must keep excluding sources; vsce `--no-dependencies` stays (deps are bundled).
- Existing tree mode does NOT compact single-child folder chains — clustered tree layout must match.
- Ordering conventions: groups fixed; folders-then-files alphabetical; `model.files` pre-sorted by path.
