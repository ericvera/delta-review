# Exploration Notes — inline review notes

Key codebase facts for planning/executing; re-read this instead of re-reading source.

## Files & roles

- `src/extension.ts` — activation, all command registration, refresh pipeline, watchers, repo tracking.
- `src/treeProvider.ts` — DELTA REVIEW tree (pattern for the new notes view).
- `src/model.ts` — review-set computation (`computeReviewModel`).
- `src/reviewState.ts` — content snapshots on `refs/review/<branch>` (pattern for gc-safe blob anchoring).
- `src/clusters.ts` — per-branch JSON contract load/parse pattern (pattern for notes/responses contracts).
- `src/contentProvider.ts` — `delta-review-base` scheme; blob sha in `uri.query`; `cat-file blob`.
- `src/decorations.ts` — `delta-review-item` scheme FileDecorationProvider (M/A/D/R badges).
- `src/git.ts` — `Git` interface + parsers.

## Load-bearing details (verified)

- `Git` interface `src/git.ts:3-9`: `{ repoRoot, run(args, {stdin?, env?}) => Promise<string> }`; `createGit` `git.ts:13-40` (execFile, stderr in rejection). Helpers: `splitNulTerminated` `git.ts:42`, `parseNameStatusOutput` `git.ts:55`, `parseLsTreeOutput` `git.ts:88`.
- `ReviewFile` `src/model.ts:17-35`: `path`, `status` (`FileReviewStatus` `model.ts:12-15`), `deleted`, `existsInMergeBase`, `diffBaseIsReviewedSnapshot` (:26), `diffBaseSha` (:28, blob sha of diff left side; undefined = empty), `movedFrom` (:31), `triage` (:34). `ReviewModel` `model.ts:37-41` `{branch, mergeBase, files}`.
- Diff-base rule `model.ts:155-179`: reviewed snapshot exists & != current → left = snapshot (`diffBaseIsReviewedSnapshot=true`); else left = merge-base blob at `movedFrom ?? path`.
- `openDiff` `src/extension.ts:371-399`: builds `createReviewBaseUri(leftPath, diffBaseSha)` left, `file://` right (or empty base URI when deleted), title with `basename (label ↔ label)`, executes `vscode.diff`. Registered `extension.ts:471`, hidden from palette `package.json:262-264`.
- `createReviewBaseUri(path, sha)` `src/contentProvider.ts:8-16`: scheme `delta-review-base`, `path:/`+path, `query: sha ?? "empty"`.
- Review state ref write pattern `src/reviewState.ts:38-87` (`writeReviewState`): temp `GIT_INDEX_FILE`, `read-tree --empty`, `update-index -z --index-info` with `100644 <sha> 0\t<path>`, `write-tree`, `commit-tree` (parent = old ref tip), `update-ref refs/review/<branch>`. `markReviewed` `reviewState.ts:90-120` hashes via `hash-object -w --stdin-paths`. `reviewRefForBranch` `reviewState.ts:13`.
- Clusters contract pattern `src/clusters.ts`: result unions :39-45 (`{state:"missing"|"invalid"|"ok"}`); `sanitizeBranchForFilename` :137-138 (`replace(/[^A-Za-z0-9._-]/g, "-")`); `loadClustersContract` :286-317 — `rev-parse --git-common-dir`, relative→`join(repoRoot,…)` (isAbsolute check :290-295), path `join(commonDir, "delta-review", "clusters-<sanitized>.json")`, ENOENT→missing, read err/parse err→invalid with one-line user-facing error strings; `version === 1` integer check; unknown keys ignored.
- Refresh pipeline `extension.ts:184-287`: generation counter guards stale async; contract reloaded every refresh (correctness never depends on watcher delivery); `treeView.message` for warnings; badge + status bar update. `scheduleRefresh` 400ms debounce `extension.ts:290-295`.
- Watchers: repo-root recursive `extension.ts:307-318`; **`<commonDir>/delta-review/*.json` watcher `extension.ts:325-353`** (`watchContractDir`) — already fires refresh for ANY json in that dir, so notes/responses files are covered with no new watcher.
- Repo/branch switching: `setActiveRepo` `extension.ts:356-369`; SCM selection sync `extension.ts:686-748`.
- Tree provider pattern `src/treeProvider.ts`: element union :74-81; `collapseKeyFor` :98-114; `isDefaultCollapsed` :120-122; provider class :124-573 with injected callbacks :131-141, `EventEmitter<Element|undefined>` :126-129, `refresh()` fires undefined :148-150; `getTreeItem` sets `id`, `contextValue`, `description`, `tooltip` (MarkdownString for files :489-502); file click command attach :503-507 (`deltaReview.openDiff`, args [file]). Collapse persistence wiring `extension.ts:124-148`.
- Menus: all row actions via `package.json` `view/item/context` with `viewItem =~ /…/` regexes (package.json:158-259); title buttons `view/title` with `view ==` + context keys (:131-157); `setContext` pattern `extension.ts:55-59`.
- Config surface `package.json:303-325`: `deltaReview.baseBranch`, `autoReview.globs`, `autoReview.markAutomatically`.

## Test conventions (from existing tests)

- Vitest, colocated `src/*.test.ts`, `describe` per exported function, lowercase `it` sentences, `it.each` for tabular error cases. `vscode` module CANNOT be imported in tested files.
- `clusters.test.ts:558-641` precedent for file-loading tests: `mkdtemp`/`rm` temp dir, fake `Git` object with canned `run` responses, write fixture into `<tmp>/.git/delta-review/`.

## VS Code Comments API notes (for the controller tasks)

- `vscode.comments.createCommentController(id, label)`; `controller.commentingRangeProvider = { provideCommentingRanges(document) }` → ranges get the `+` gutter. Works per-document URI (both `file://` and virtual schemes).
- Creating: `+` opens an empty thread with the built-in input; a command contributed to `comments/commentThread/context` menu (`when: commentController == <id> && commentThreadIsEmpty`) receives `vscode.CommentReply { thread, text }`. Reply on existing threads: same menu, `!commentThreadIsEmpty`, gated by `commentThread =~ /<contextValue>/`; `thread.canReply` toggles the box.
- `CommentThread`: `label`, `contextValue`, `state` (`vscode.CommentThreadState.Resolved|Unresolved`), `collapsibleState`, `comments: Comment[]`, `dispose()`.
- `Comment`: `body` (string|MarkdownString), `mode` (`Editing|Preview`), `author: {name}`, `contextValue`, `timestamp?: Date`. Edit flow: set `comment.mode = Editing`, save/cancel commands in `comments/comment/context`, edit/delete buttons in `comments/comment/title`, all `when`-gated by `comment =~ /…/`.
- Empty-view message: `contributes.viewsWelcome` `[{view, contents}]` renders when the provider returns no children.
- `vscode.diff` accepts a 4th `TextDocumentShowOptions` arg (use `selection` to reveal a line).

## Contract decisions (from design)

- Notes file: `<commonDir>/delta-review/notes-<sanitized>.json` (extension-owned). Responses: `<commonDir>/delta-review/responses-<sanitized>.json` (agent-owned). Both version 1. No collision with `clusters-*.json`.
- gc-safety: every note's `contentBlob` anchored in a commit-tree on `refs/review-notes/<branch>` (paths = note ids), mirroring `writeReviewState` — left-side base blobs included (Clear Review State can delete `refs/review/<branch>`, so reviewed-snapshot blobs are not safe to lean on).
- Anchoring diffs: `git diff -U0 <blobA> <blobB>` on blob shas; parse `@@ -a,b +c,d @@` hunks (pure), map ranges through hunks (pure).
