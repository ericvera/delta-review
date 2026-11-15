# 02_01 Pure helpers for the combined cluster diff

## Goal

Add a VS Code-free module with the pure logic behind the upcoming "Open Cluster Changes" feature of Delta Review. That feature opens every needs-review file of a cluster in VS Code's multi-diff editor, offers a "Mark Cluster Reviewed" title button, and selects a file's sidebar row when the user clicks into it. This task builds only the helpers and their unit tests; nothing calls them yet.

## Files to modify/create

- `src/clusterChanges.ts` (new)
- (tests) `src/clusterChanges.test.ts` (new)

## Background

- `ReviewFile` and `FileReviewStatus` are in `src/model.ts` (interface at `:30-93`). The relevant fields are `path`, `status`, `deleted`, `diffBasePath` (repo-relative path naming the left document) and `diffBaseSha` (left blob; undefined means empty).
- `ClusterModel`, `clusterBucketForKey`, `clusterFilesForKey` are in `src/clusters.ts:60-106`. Cluster keys are `"c<index>"` for real clusters plus the synthetic `"unclustered"` and `"auto"`. The tree labels the synthetic buckets `"Unclustered"` and `"Auto"` (`src/treeProvider.ts:590,595`).
- Diff documents (`openDiff`, `src/extension.ts:697-734`):
  - The left side is `createReviewBaseUri(file.diffBasePath, file.diffBaseSha)`, scheme `delta-review-base`, path `/<diffBasePath>`, query `<sha>` or `"empty"` (`src/baseDocument.ts:39-45` `reviewBaseUriParts`).
  - The right side is `Uri.file(<repoRoot>/<path>)`, or for a deleted file `createReviewBaseUri(file.path, undefined)` (query `"empty"`).
- Pattern for a pure module with colocated test: `src/rowContext.ts` + `src/rowContext.test.ts`, `src/clusters.test.ts`. Import types only from modules that import `vscode` (see `src/treeParents.ts:1-13`).
- Design decisions (spec): the combined diff holds every file of the cluster that needs review, in the cluster's (path) order. The tab title is `Cluster Changes: <label>`, and the empty-click message is `No files in '<label>' need review.`

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

Export from `src/clusterChanges.ts`:

1. `clusterLabelForKey(model: ClusterModel, clusterKey: string): string` returns `"Unclustered"` for `"unclustered"`, `"Auto"` for `"auto"`, the bucket label for a real key, and `""` for an unknown key.
2. `clusterChangesFiles(files: readonly ReviewFile[]): ReviewFile[]` returns the files with `status === FileReviewStatus.NeedsReview`, order and identity preserved (can reuse `filterByStatus` from `src/clusters.ts`).
3. `clusterChangesTitle(label: string): string` returns `` `Cluster Changes: ${label}` ``.
4. `nothingToReviewMessage(label: string): string` returns `` `No files in '${label}' need review.` ``.
5. `type DiffDocument = { scheme: "file"; path: string } | { scheme: "base"; path: string; query: string }`, where `path` is repo-relative with no leading `/`.
6. `fileForDiffDocument(files: readonly ReviewFile[], doc: DiffDocument): ReviewFile | undefined` returns the first match in list order:
   - `"file"`: `!file.deleted && file.path === doc.path`.
   - `"base"`: either `file.diffBasePath === doc.path && (file.diffBaseSha ?? "empty") === doc.query` (left side), or `file.deleted && file.path === doc.path && doc.query === "empty"` (a deleted file's right side).
7. `isRowAlreadySelected(selectedPaths: readonly string[], path: string): boolean` is a trivial predicate that keeps the skip rule testable.

Header comment: one or two lines on what the module is for and why it is VS Code-free.

## Gotchas

- No `vscode` import, even indirectly at runtime. Use `import type` for anything from `./treeProvider`.
- A file can be both a moved file's left side (`diffBasePath` = old path) and its own row elsewhere, so left-side matching must require the query (sha) to match, not the path alone.
- Run `yarn format` before finishing.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- `src/clusterChanges.test.ts` covers:
  - The label for each key kind, including an unknown and an out-of-range `c9`.
  - `clusterChangesFiles` keeps order and drops reviewed files.
  - Title and message strings exactly.
  - `fileForDiffDocument`: a working-side match; a left-side match by path and sha; a left-side miss when the sha differs; a left side with an empty base (`diffBaseSha` undefined, query `"empty"`); a deleted file's right side; a deleted file's path with scheme `"file"` does not match; first match wins.
  - `isRowAlreadySelected`.
