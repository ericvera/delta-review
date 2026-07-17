# Task 1.2: Wire rename detection into `computeReviewModel`

## Goal

Switch the model's tracked-changes command to rename-aware `git diff --name-status --find-renames -z`, add `movedFrom` to `ReviewFile`, and point a move's diff base at the old path's merge-base blob. After this task a detected move produces exactly one review entry whose diff shows only the edits on top of the move (still badged `A` until Task 2.1 restyles it).

## Requirements addressed

REQ-DET-1, REQ-DET-2, REQ-DET-3, REQ-DET-4, REQ-DIFF-1, REQ-DIFF-3, REQ-STATE-1, REQ-STATE-2, REQ-STATE-3, REQ-STATE-4, REQ-PRES-1, REQ-PRES-2

## Background

Delta Review is a VS Code extension showing files changed between a branch's merge base and the working tree, each with a reviewed/needs-review status. The feature being built: files git detects as moved should render as a single entry at the new path diffing old content ↔ new working file.

Task 1.1 added `parseNameStatusOutput(output)` to `src/git.ts`, returning `{ paths: string[]; movedFrom: Map<string, string> }` — every changed path (rename **destinations** included, rename **sources** excluded) plus a destination → source map for detected renames.

`computeReviewModel` in `src/model.ts` (lines 81–172) currently:

- runs `git diff --name-only --no-renames -z <mergeBase>` (lines 97–103) and unions those paths with untracked files (`ls-files --others --exclude-standard -z`), deduped and sorted (lines 110–115);
- builds `baseBlobs` (path → blob sha at the merge base) from `git ls-tree -r -z <mergeBase>` (lines 125–127);
- assembles each `ReviewFile` (lines 148–169): `deleted` = file missing from the working tree; `reviewed` = reviewed-snapshot sha (from `readReviewState`, keyed by path) equals current content sha; `useSnapshotBase` = unreviewed but a usable snapshot exists; `diffBaseSha` = snapshot sha when `useSnapshotBase`, else `baseBlobs.get(path)`.

Review state (`src/reviewState.ts`) is a path → blob-sha map on `refs/review/<branch>`; it needs **no changes** — a moved file's snapshot is written and read under its new path automatically, and stale old-path entries are simply never consulted again.

## Files to modify/create

- `src/model.ts` — diff command, `ReviewFile.movedFrom`, diff-base selection
- `src/clusters.test.ts` — its `ReviewFile` object literals (around lines 21–29) gain the new required field (`movedFrom: undefined`)
- `src/model.test.ts` — only if you extract pure helpers worth testing (see Testing)

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. In `computeReviewModel`, change the tracked-changes command (lines 97–103) to `["diff", "--name-status", "--find-renames", "-z", mergeBase]` and parse with `parseNameStatusOutput` (import from `./git`). Use its `paths` where `splitNulTerminated(trackedOutput)` is used today; keep the untracked union, dedupe, and sort exactly as they are (`movedFrom` destinations ride through like any path).
2. Add to the `ReviewFile` interface (lines 12–27): `movedFrom: string | undefined` with a comment ("Old repo-relative path when git detected this file as a rename/move of it; undefined otherwise"). Follow the interface's existing comment style — the required-with-undefined form matches `diffBaseSha`. Because the field is required, the `ReviewFile` object literals in `src/clusters.test.ts` must gain `movedFrom: undefined` or `yarn build` breaks.
3. In the per-file assembly (lines 148–169), having destructured the parser result as `const { paths: trackedPaths, movedFrom: movedFromByPath } = …`:
   - set `movedFrom: movedFromByPath.get(path)`;
   - change the merge-base branch of `diffBaseSha` from `baseBlobs.get(path)` to `baseBlobs.get(movedFromByPath.get(path) ?? path)` — this is what makes a pure move diff empty and a move+edit diff only its edits (REQ-DIFF-1). The `useSnapshotBase` branch stays `reviewedSha` untouched (REQ-DIFF-3).
   - leave `existsInMergeBase: baseBlobs.has(path)` as is — for a move destination it stays `false`; Task 2.1 makes the decoration check `movedFrom` before it.
4. Explicit `--find-renames` (not relying on `diff.renames` config) keeps behavior identical across user git configs (REQ-DET-3). Do not pass `--find-copies`.

## Testing suggestions

- `computeReviewModel` needs a real git repo, so it has no unit tests today; keep it that way. The parsing is covered by Task 1.1's tests. If you extract any new pure decision helper, colocate tests in `src/model.test.ts` following its fixture style — otherwise no new tests.
- Quick live check (full pass happens in Task 2.2): in a repo with a feature branch, `git mv` one file and edit another, F5 the extension (see DEVELOPMENT.md), confirm: one row at the new path (badge will still read `A`), no row at the old path, its diff is empty for a pure move, and the counts dropped by one.

## Gotchas

- `movedFrom` is both the parser-result map's property name and a `ReviewFile` field — the `movedFromByPath` rename in the destructuring above exists to keep the file-assembly closure unambiguous; don't shadow it.
- A moved-then-reviewed-then-re-edited file must keep using its snapshot (keyed by the **new** path) as diff base — only the non-snapshot branch switches to the old path's blob.
- The old path must not reach `computeTriage`, `fetchGeneratedPaths`, or the hashing of existing paths — it flows nowhere once the parser drops rename sources; don't reintroduce it.
- A rename destination is present in the working tree by definition, so it can never be `deleted`; no special-casing needed — just don't add any.

## Verification checklist

- [ ] `yarn test`, `yarn lint`, `yarn build` all pass
- [ ] Live spot-check in the dev host: a `git mv`'d file shows one row (new path), no old-path row, empty diff for a pure move
- [ ] End-to-end tests: none automated — extension-host behavior; config Test exception applies (no e2e infrastructure), substitute is the dev-host spot-check above plus Task 2.2's full manual pass
