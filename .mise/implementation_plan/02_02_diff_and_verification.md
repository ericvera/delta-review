# Task 2.2: Diff origin labeling, docs, and full manual verification

## Goal

The diff editor for a move opens with the old path on the left side and a title naming the origin (`config.ts (moved from src/utils/config.ts — merge base ↔ working tree)`); DEVELOPMENT.md's manual test script covers moves; the whole feature passes the full dev-host manual pass.

## Requirements addressed

REQ-DIFF-1, REQ-DIFF-2, REQ-DIFF-3, REQ-REND-6, REQ-PRES-1

## Background

Delta Review is a VS Code extension reviewing changes since the merge base. Prior tasks: `ReviewFile` (`src/model.ts`) carries `movedFrom: string | undefined` and, for moves without a reviewed snapshot, `diffBaseSha` already holds the **old** path's merge-base blob (Task 1.2); rows render with an R badge and origin descriptions (Task 2.1).

Diff opening today — `openDiff` in `src/extension.ts` (lines 371–390):

- `leftUri = createReviewBaseUri(file.path, file.diffBaseSha)` — `createReviewBaseUri(path, sha)` (`src/contentProvider.ts`) puts the sha in the URI query (content comes from `git cat-file blob <sha>`; the path only affects the editor's label and language detection).
- `rightUri` = the working-tree file (or an empty-content URI when deleted).
- Title: `` `${basename(file.path)} (${baseLabel} ↔ ${workingLabel})` `` with `baseLabel` = `"last reviewed"` when `file.diffBaseIsReviewedSnapshot`, else `"merge base"`; `workingLabel` = `"deleted"` or `"working tree"`.

Design decisions from the overview:

- When the base is the **merge base**, the left URI should use `file.movedFrom` so the left editor is labeled with the true origin path. When the base is the **reviewed snapshot** (`file.diffBaseIsReviewedSnapshot`), the snapshot was captured from the new path — keep `file.path` on the left.
- The title includes ` (moved from <old path> — …)` whenever `movedFrom` is set, with the full old repo-relative path (a same-directory rename must still show a meaningful origin), on both base kinds.

## Files to modify/create

- `src/extension.ts` — `openDiff` left URI + title
- `DEVELOPMENT.md` — extend the manual test script with move scenarios

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. In `openDiff` (`src/extension.ts:371-390`):
   - Left path: `const leftPath = file.diffBaseIsReviewedSnapshot ? file.path : (file.movedFrom ?? file.path);` then `createReviewBaseUri(leftPath, file.diffBaseSha)`.
   - Title: when `file.movedFrom` is defined, `` `${basename(file.path)} (moved from ${file.movedFrom} — ${baseLabel} ↔ ${workingLabel})` ``; otherwise unchanged. Keep the existing `baseLabel`/`workingLabel` computation as the single source for those words (REQ-DIFF-2/3).
2. In `DEVELOPMENT.md`:
   - Fix the now-false internals note: line 55 states "Renames are not detected (`--no-renames`)" and the surrounding "File status letters" section enumerates only `M`/`A`/`D` — update both to describe rename detection and the `R` letter.
   - Extend the manual test script with move steps: `git mv` a file (pure move), `git mv` + edit another, confirm single R rows, empty vs edits-only diffs, and the unstaged-Finder-move fallback (two rows until staged).

## Testing suggestions

Full manual pass in the F5 Extension Development Host (per DEVELOPMENT.md), on a scratch branch of any repo:

1. **Pure move** (`git mv src/a.ts src/moved/a.ts`): one R row at the new path, no old-path row; diff opens "files are identical"; title reads `a.ts (moved from src/a.ts — merge base ↔ working tree)`; left editor labeled with the old path.
2. **Move + edit**: diff shows only the edited lines (mock 4B); same title shape.
3. **Mark reviewed** on a move row (inline ✓): row moves to Reviewed, counts and status bar treat it as one file; then edit the file again → back to needs-review with title `… (moved from … — last reviewed ↔ working tree)` and the diff showing only the post-review edit.
4. **Open File** inline action works on a move row (REQ-REND-6).
5. **Fallback**: move a file with plain `mv` (unstaged): old path D row + no new row beyond untracked A row, exactly as before (mock 5, REQ-PRES-1); `git add -A` then refresh → collapses to one R row.
6. **Non-move regression**: modified/added/deleted files render and diff exactly as before (REQ-PRES-1).

## Gotchas

- Don't derive `leftPath` from `movedFrom` unconditionally: on the snapshot base the blob came from the new path; labeling it with the old path would be wrong (REQ-DIFF-3).
- `createReviewBaseUri`'s path lands in the editor tab/label — verify the old path renders there for the merge-base case; content correctness is independent of the path (sha in the query).
- The title's em-dash/arrow format should match the mock's tab title (`moved from … — merge base ↔ working tree`) — format only: the mock abbreviates the origin to the old directory, but REQ-DIFF-2 requires the full old path.

## Verification checklist

- [ ] `yarn test`, `yarn lint`, `yarn build` all pass
- [ ] Manual pass steps 1–6 above all confirmed in the dev host
- [ ] DEVELOPMENT.md manual test script includes the move scenarios
- [ ] End-to-end tests: none automated — extension-host behavior; config Test exception applies (no e2e infrastructure), the six-step manual pass above is the substitute verification
