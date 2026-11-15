# Spec: carry review state across renames

## What

- A file moved on the branch (git-detected rename, or declared `origin: "repo"` move that won declaration precedence) with no snapshot of its own diffs against the old path's reviewed snapshot: only the changes since that review.
- A moved file always reads Needs Review until marked at the new path, even when its content equals the old-path snapshot.
- Its row keeps showing the previous path (existing move display). Its classification word is:
  - `unchanged` — content identical to the last reviewed snapshot (its own if it has one, else the inherited old-path one). Opening it shows an empty since-review diff.
  - `adapted` — a last reviewed snapshot exists and differs.
  - `verbatim` / `adapted` / none — today's origin comparison, only when the file has no snapshot at either path.
- Unmark (file, folder, cluster, Auto) on a moved file that has an inheritable old-path snapshot drops both the new path's and the old path's snapshots.
- Mark writes the new path only; the old path's snapshot stays.
- Out of scope: a repo move's declared `baseBlob` keeps current behaviour and precedence.

## Design

### Snapshot selection (`src/model.ts`, pure)

New exported `selectReviewSnapshot(input)`:

```ts
input: {
  path: string;
  move: ResolvedMove | undefined;          // movesByPath.get(path): the winning move only
  reviewPaths: ReadonlySet<string>;         // adjusted review set (AdjustedReviewSet.paths)
  reviewState: ReadonlyMap<string, string>; // readReviewState result
  currentSha: string;                       // working sha, or sentinel when deleted
  sentinelSha: string;
}
returns: {
  reviewed: boolean;                        // own snapshot === currentSha
  snapshotBaseSha: string | undefined;      // snapshot the diff opens against
  lastReviewedSha: string | undefined;      // own snapshot ?? inherited snapshot
  inheritedSnapshotFrom: string | undefined;
  hasReviewSnapshot: boolean;               // own !== undefined || inheritedSnapshotFrom !== undefined
}
```

Rules:
- `own = reviewState.get(path)`.
- `inheritedSnapshotFrom = move.from` iff `move.origin === "repo"`, `!reviewPaths.has(move.from)`, and `reviewState.get(move.from)` is defined and not `sentinelSha`. Otherwise undefined.
  - External moves never inherit (their `from` is a donor path).
  - A `from` that is still its own row (overwrite case keeps the origin's `D` row; an origin still on disk) keeps its snapshot to itself, so a displaced git-rename source (re-added as its own row) and a non-suppressed origin never lend their snapshot.
  - A sentinel old-path snapshot is no usable base, so nothing is inherited.
- `reviewed = own !== undefined && own === currentSha`.
- `snapshotBaseSha`: when `own !== undefined`, `own` if `!reviewed && own !== sentinelSha`, else undefined (today's rule). When `own === undefined`, the inherited sha (or undefined).
- `inheritedSnapshotFrom` is reported whether or not the file has its own snapshot, so unmark after a re-mark still clears the old key.

### Diff base and classification (`resolveFileBase`)

- Inputs `reviewedSha` + `useSnapshotBase` keep their shape; the caller passes `reviewedSha = snapshotBaseSha`, `useSnapshotBase = snapshotBaseSha !== undefined`. Precedence unchanged: snapshot (own or inherited) > merge-base blob at own path > origin base. An inherited snapshot therefore outranks a declared `baseBlob` and the origin.
- New required input `lastReviewedSha: string | undefined`.
- `diffBasePath` on any snapshot base stays the file's own (new) path — the snapshot is the reviewed version of this file; notes and base-document identity key on the new path.
- `MoveClassification` gains `"unchanged"`. Order: no move → undefined; `deleted` → `"unknown"`; `lastReviewedSha !== undefined` → `workingSha === lastReviewedSha ? "unchanged" : "adapted"`; origin base missing → `"unknown"`; else `"verbatim"`/`"adapted"`.
- `originContentUnavailable` / `originLinesOutOfRange` gating is unchanged (`originDecidesBase` already false on a snapshot base).

### ReviewFile

- New optional `inheritedSnapshotFrom?: string` (optional so existing test fixtures stay valid).
- `hasReviewSnapshot` = selection's `hasReviewSnapshot`; `diffBaseIsReviewedSnapshot` = `snapshotBaseSha !== undefined`; `status` from `reviewed`.
- New exported `reviewSnapshotPaths(file): string[]` — `[]` when `!file.hasReviewSnapshot`; else `[file.path]` plus `file.inheritedSnapshotFrom` when defined. Deleting an absent key is a no-op in `unmarkReviewed`.
- `pathsWithReviewSnapshot` = `files.flatMap(reviewSnapshotPaths)`, so folder/cluster/Auto unmark reach the old key. `src/extension.ts` file-row unmark uses `reviewSnapshotPaths(element.file)`.
- `rowContext.ts` unchanged: an inheriting row gets the `Snapshot` token via `hasReviewSnapshot`, so `−` renders on it.

### Display (`src/moveDisplay.ts`, `src/treeProvider.ts`)

- `classificationText` renders `· unchanged` as it does `verbatim`/`adapted`.
- `buildTooltipStatusLine`: `"unchanged"` pushes `Unchanged since last reviewed`.
- `treeProvider.ts`: `Changed since last reviewed` only when `diffBaseIsReviewedSnapshot && moveClassification !== "unchanged"`.
- Diff title label stays `last reviewed` (driven by `diffBaseIsReviewedSnapshot`).

### Removed

Nothing removed. Behaviour change for existing moved files with their own snapshot: they no longer show `verbatim` (Reviewed rows read `unchanged`).

### Docs

`DEVELOPMENT.md` review-state rules, unmark scope, classification bullet, diff-base bullet, manual steps 9/11/14 plus a new inherited-snapshot step; `plugin/skills/cluster/SKILL.md` "not a contract field" line names `unchanged` too.

## Hard-to-undo

- Unmark on a moved file now also deletes the old path's key from `refs/review/<branch>` (a ref write; recoverable through the ref's parent chain). No schema, migration, contract-format or public API change.

## Task index

| Task file | What | Files |
|---|---|---|
| `01_01_inherit_old_path_snapshot.md` | Snapshot selection with old-path inheritance, `unchanged` classification, unmark scope covering the old path | `src/model.ts`, `src/extension.ts` |
| `01_02_unchanged_wording.md` | Row `· unchanged`, tooltip `Unchanged since last reviewed`, suppress `Changed since last reviewed` on unchanged | `src/moveDisplay.ts`, `src/treeProvider.ts` |
| `01_03_docs_inherited_snapshot.md` | Document inheritance, `unchanged`, unmark scope, manual test steps | `DEVELOPMENT.md`, `plugin/skills/cluster/SKILL.md` |
