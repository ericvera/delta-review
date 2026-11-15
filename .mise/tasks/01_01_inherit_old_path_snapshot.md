# 01_01 Inherit the old path's review snapshot on a moved file

## Goal

In the Delta Review VS Code extension, a file moved on the branch (git-detected rename or declared repo move) that has no review snapshot of its own diffs against the snapshot recorded at its old path, always reads Needs Review until marked at the new path, gets a new `"unchanged"` classification when its content equals its last reviewed snapshot, and unmark drops both the new and the old path's snapshots.

## Files to modify/create

- `src/model.ts`
- `src/extension.ts`

## Background

- Review state is a path -> blob sha map in `refs/review/<branch>`, read by `readReviewState` (`src/reviewState.ts:18`). `markReviewed`/`unmarkReviewed` (`src/reviewState.ts:90-132`) only touch the keys they are given, so an old path's snapshot survives a rename.
- `computeReviewModel` (`src/model.ts:~555-617`) builds each `ReviewFile`: today `reviewedSha = reviewState.get(path)` (:575), `reviewed`, `snapshotUsable`, `useSnapshotBase` (:576-581), then `resolveFileBase` (:584).
- `adjustReviewSetForMoves` (`src/model.ts:162-230`) returns `paths` (the adjusted review set) and `movesByPath: Map<string, ResolvedMove>` holding only the winning move per destination. `ResolvedMove.origin` is `"repo"` for git renames and repo declarations, `"external"` for donor-project moves (their `from` is not a repo path).
- A declaration that displaces a git rename re-adds the detected source as its own row (`src/model.ts:198-203`); a repo move whose destination existed at the merge base keeps the origin's row too (:215-223).
- `resolveFileBase` (`src/model.ts:251-317`): diff-base precedence snapshot > own merge-base blob > origin base; `diffBasePath` stays `path` on a snapshot base; `moveClassification` computed at :293-300.
- `pathsWithReviewSnapshot` (`src/model.ts:102-105`) feeds folder/cluster/Auto unmark in `src/extension.ts:1135,1188,1242`. File-row unmark is `src/extension.ts:886-907`, guarded by `hasReviewSnapshot` and unmarking `[element.file.path]`.
- `src/rowContext.ts:25` adds the `Snapshot` context token (which shows `−`) from `hasReviewSnapshot`; no change needed there.
- Design decisions (from spec):
  - Only the winning move's `from` is followed; external moves never inherit; extractions (`fromLines` declared) never inherit (the old snapshot is the whole old file, not the slice); a `from` shared by more than one `movesByPath` entry lends to none (so unmarking one file never deletes a key a sibling inherits); an origin still on disk never lends (whether or not it is in the review set); a `from` that is itself in the adjusted review set never lends its snapshot; a sentinel old-path snapshot is not inherited.
  - Extractions are repo moves (`DEVELOPMENT.md:115`); only duplicate destination `path`s are dropped, duplicate `from`s are allowed (`DEVELOPMENT.md:117`).
  - A file's own snapshot outranks an inherited one. An inherited snapshot outranks merge-base and origin bases, like an own snapshot.
  - `diffBasePath` on an inherited snapshot base is the file's own (new) path.
  - Status (`reviewed`) depends on the own snapshot only.
  - `verbatim` is shown only when the file has no snapshot at either path.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `MoveClassification` (`src/model.ts:35`): add `"unchanged"`; update its comment.
2. Add exported `selectReviewSnapshot` near `resolveFileBase`:
   ```ts
   export interface SnapshotSelection {
     reviewed: boolean;
     snapshotBaseSha: string | undefined;
     lastReviewedSha: string | undefined;
     inheritedSnapshotFrom: string | undefined;
     hasReviewSnapshot: boolean;
   }
   export const selectReviewSnapshot = (input: {
     path: string;
     move: ResolvedMove | undefined;
     originDeleted: boolean; // move's `from` is absent from the working tree
     originShared: boolean;  // more than one movesByPath entry has this `from`
     reviewPaths: ReadonlySet<string>;
     reviewState: ReadonlyMap<string, string>;
     currentSha: string;   // working sha, or the sentinel when deleted
     sentinelSha: string;
   }): SnapshotSelection
   ```
   - `own = reviewState.get(path)`.
   - `inheritedSha = reviewState.get(move.from)`; `inheritedSnapshotFrom = move.from` only when `move?.origin === "repo"`, `move.fromLines === undefined`, `!originShared`, `originDeleted`, `!reviewPaths.has(move.from)`, `inheritedSha !== undefined`, `inheritedSha !== sentinelSha`.
   - `reviewed = own !== undefined && own === currentSha`.
   - `snapshotBaseSha = own !== undefined ? (!reviewed && own !== sentinelSha ? own : undefined) : (inheritedSnapshotFrom !== undefined ? inheritedSha : undefined)`.
   - `lastReviewedSha = own ?? (inheritedSnapshotFrom !== undefined ? inheritedSha : undefined)`.
   - `hasReviewSnapshot = own !== undefined || inheritedSnapshotFrom !== undefined`.
3. `resolveFileBase`: add required input `lastReviewedSha: string | undefined`. Classification order: no move → `undefined`; `deleted` → `"unknown"`; `lastReviewedSha !== undefined` → `workingSha === lastReviewedSha ? "unchanged" : "adapted"`; `originBaseSha === undefined` → `"unknown"`; else `"verbatim"`/`"adapted"`. Update the doc comment above it (classification is against the last reviewed snapshot when there is one, else the origin base). Leave diff-base and `originDecidesBase` logic unchanged.
4. `computeReviewModel`: build `const reviewPaths = new Set(paths)` and a `fromCounts: Map<string, number>` counting `move.from` over `movesByPath.values()` once; per file call `selectReviewSnapshot` with `originDeleted: move !== undefined && isDeletedFromWorkingTree(move.from)` (existing helper, `src/model.ts:538`), `originShared: move !== undefined && (fromCounts.get(move.from) ?? 0) > 1`, `currentSha` (already computed as working sha or `sentinelSha`), then call `resolveFileBase` with `reviewedSha: selection.snapshotBaseSha`, `useSnapshotBase: selection.snapshotBaseSha !== undefined`, `lastReviewedSha: selection.lastReviewedSha`. Set `status` from `selection.reviewed`, `diffBaseIsReviewedSnapshot` from `snapshotBaseSha !== undefined`, `hasReviewSnapshot` from the selection, and `inheritedSnapshotFrom`.
5. `ReviewFile`: add optional `inheritedSnapshotFrom?: string` with a comment (old path whose snapshot this moved file inherits; the diff base only when the file has no snapshot of its own; unmark drops it too). Update the `hasReviewSnapshot` comment: own path or inherited old path.
6. Add exported `reviewSnapshotPaths(file: ReviewFile): string[]` — `[]` when `!file.hasReviewSnapshot`; else `[file.path]` plus `file.inheritedSnapshotFrom` if defined. Rewrite `pathsWithReviewSnapshot` as `files.flatMap(reviewSnapshotPaths)`; update its comment.
7. `src/extension.ts` `deltaReview.unmarkFileReviewed`: `const paths = reviewSnapshotPaths(element.file);` (import it from `./model`). Keep the `hasReviewSnapshot` guard.

## Gotchas

- `src/moveDisplay.ts` compares classification with `===`, so the new union member compiles; it just renders no word until task 01_02. Do not edit display files here.
- Keep `src/model.ts` free of `vscode` imports (Vitest cannot load it).
- `inheritedSnapshotFrom` must be reported even when the file has its own snapshot (so an unmark after a re-mark still clears the old key), but it is the diff base only when there is no own snapshot.
- An own sentinel snapshot counts as "has its own snapshot": no inheritance into the base, classification `adapted` (or `unknown` if deleted).
- Existing `resolveFileBase` tests pass `reviewedSha`/`useSnapshotBase` via the `resolve` helper (`src/model.test.ts:287-307`); add `lastReviewedSha?: string` to the helper and pass it through. Existing expectations must stay green as-is.
- `computeReviewModel` tests: `originDeleted` comes from `existsSync` on the temp repo; the fixture (`src/model.test.ts:692-707`) writes only paths listed in `workingShas`, so leave the old path out of `workingShas` for inheritance cases.
- `pathsWithReviewSnapshot` may now return an old path outside the files' own paths; existing tests at `src/model.test.ts:1371-1385` must still pass.

## Verification

- Run: `yarn lint`, `yarn build`, `yarn test`.
- Write in `src/model.test.ts`:
  - `describe("selectReviewSnapshot")`: inherits from a repo move's old path when no own snapshot (base = old sha, not reviewed, `hasReviewSnapshot` true); own snapshot outranks inherited (base = own, `inheritedSnapshotFrom` still reported); reviewed own snapshot gives no base; external move never inherits; repo move with `fromLines` defined does not inherit; `originShared: true` does not inherit; `originDeleted: false` (origin on disk, not in `reviewPaths`, stale snapshot at its path) does not inherit; `from` present in `reviewPaths` does not inherit; sentinel old-path snapshot does not inherit; no move → no inheritance.
  - `describe("resolveFileBase")`: `lastReviewedSha` equal to working sha → `"unchanged"`; differing → `"adapted"` even when working sha equals the origin base; deleted → `"unknown"`; inherited snapshot base keeps `diffBasePath` as the file's own path and outranks an own merge-base blob and the origin.
  - `describe("computeReviewModel")` (fake-repo fixture at :690-780, R100 rename pattern at :787): R100 rename `src/old.ts` → `src/renamed.ts` with `reviewState: { "src/old.ts": X }` and working sha X → NeedsReview, `diffBaseIsReviewedSnapshot` true, `diffBaseSha` X, `diffBasePath` `"src/renamed.ts"`, `moveClassification` `"unchanged"`, `inheritedSnapshotFrom` `"src/old.ts"`, `pathsWithReviewSnapshot` = `["src/renamed.ts", "src/old.ts"]`; same with working sha differing → `"adapted"`; a declaration displacing the git rename does not inherit the displaced source's snapshot (the source row keeps its own); two repo declarations sharing one deleted `from` with a snapshot at `from` → neither has `inheritedSnapshotFrom` and `pathsWithReviewSnapshot` excludes `from`.
  - `describe("reviewSnapshotPaths")`: empty without a snapshot; own path only; own path plus inherited old path.
