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
- Design decisions (spec): the combined diff holds every file of the cluster that needs review, in the cluster's (path) order. The tab title is `Cluster Changes: <label>`, made unique when labels collide (cluster labels may repeat: `src/clusters.ts:76-80` keeps identical labels distinct by index key), and the empty-click message is `No files in '<label>' need review.` The title-bar "Mark Cluster Reviewed" (task 02_03) must never write review state for a cluster or files the user did not see in that tab: it marks only the tab's paths that still need review, and refuses when the cluster behind the tab's key no longer has the label and title it opened with (the contract can be rewritten while the tab is open, and keys are indices), or when the active repo root or branch differs from the one the tab was opened from (synthetic bucket titles such as `Cluster Changes: Unclustered` repeat across repos and branches).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

Export from `src/clusterChanges.ts`:

1. `clusterLabelForKey(model: ClusterModel, clusterKey: string): string` returns `"Unclustered"` for `"unclustered"`, `"Auto"` for `"auto"`, the bucket label for a real key, and `""` for an unknown key.
2. `clusterChangesFiles(files: readonly ReviewFile[]): ReviewFile[]` returns the files with `status === FileReviewStatus.NeedsReview`, order and identity preserved (can reuse `filterByStatus` from `src/clusters.ts`).
3. `clusterChangesTitle(model: ClusterModel, clusterKey: string): string` returns the title assigned to `clusterKey` by one deterministic pass over the whole model (an internal helper may compute the full `key -> title` map; call it per invocation, no caching):
   - A label is *colliding* when it equals the label of any other key of the model: another real cluster, `"Unclustered"`, or `"Auto"` (the two synthetic labels always count).
   - First reserve the unsuffixed titles `` `Cluster Changes: ${label}` `` of both synthetic keys and of every real cluster whose label is not colliding; those keys get exactly that title. Synthetic keys never get a suffix.
   - Then, for each real cluster `c<i>` with a colliding label, in index order: start at `n = i + 1`, increment `n` while `` `Cluster Changes: ${label} (${n})` `` is already taken (reserved or assigned earlier in this pass), assign it, and mark it taken.
   - Result: titles are unique within one model, even when a label itself looks like a suffixed title (clusters `c0 "Foo"`, `c1 "Foo"`, `c2 "Foo (2)"` get `Foo (1)`, `Foo (3)`, `Foo (2)`).
   - An unknown key returns `` `Cluster Changes: ${clusterLabelForKey(model, key)}` `` (i.e. `"Cluster Changes: "`).
3a. `changedClusterMessage(label: string): string` returns `` `Cluster '${label}' changed since this diff opened. Reopen it from the Delta Review pane.` ``.
3c. (used by 3b) `sameClusterChangesSource(entry: { repoRoot: string; branch: string }, current: { repoRoot: string; branch: string }): boolean` returns `entry.repoRoot === current.repoRoot && entry.branch === current.branch`. The tab records the repo root and branch it was opened from; the active SCM repo or the checked-out branch can change while it stays open, and repo-relative paths and labels can coincide across repos and branches.
3b. `clusterChangesMarkPaths(entry: { title: string; label: string; paths: readonly string[]; repoRoot: string; branch: string }, current: { title: string; label: string; repoRoot: string; branch: string }, clusterFiles: readonly ReviewFile[]): { paths: string[] } | { message: string }`:
   - When `!sameClusterChangesSource(entry, current)`, or `current.label !== entry.label`, or `current.title !== entry.title`, return `{ message: changedClusterMessage(entry.label) }`.
   - Otherwise return `{ paths }`: the paths of `clusterChangesFiles(clusterFiles)` that are in `entry.paths`, in `clusterFiles` order. When that is empty, return `{ message: nothingToReviewMessage(entry.label) }` instead.
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
  - Title and message strings exactly. `clusterChangesTitle`: a unique label gets no suffix; two real clusters labeled `Foo` at `c0` and `c2` get `Cluster Changes: Foo (1)` / `Cluster Changes: Foo (3)`; a real cluster labeled `Auto` gets a suffix while the `auto` key does not; clusters `c0 "Foo"`, `c1 "Foo"`, `c2 "Foo (2)"` get `Cluster Changes: Foo (1)`, `Cluster Changes: Foo (3)`, `Cluster Changes: Foo (2)`, and all titles of that model are distinct.
  - `sameClusterChangesSource`: true on match; false when only `repoRoot` differs; false when only `branch` differs.
  - `clusterChangesMarkPaths`: label changed → changed message; same label but title changed (suffix appeared) → changed message; label, title and paths all match but `repoRoot` differs → changed message (e.g. `Unclustered` opened in repo X, pressed with repo Y active, overlapping paths); same but `branch` differs → changed message; match → only entry paths that still need review (a reviewed entry path and a needs-review path not in the entry are both excluded); match with nothing left → nothing-to-review message.
  - `fileForDiffDocument`: a working-side match; a left-side match by path and sha; a left-side miss when the sha differs; a left side with an empty base (`diffBaseSha` undefined, query `"empty"`); a deleted file's right side; a deleted file's path with scheme `"file"` does not match; first match wins.
  - `isRowAlreadySelected`.
