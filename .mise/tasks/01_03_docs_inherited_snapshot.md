# 01_03 Document inherited review snapshots and the "unchanged" word

## Goal

Update the Delta Review developer and skill docs to describe how a moved file inherits its old path's review snapshot, the new `unchanged` classification, the narrowed `verbatim` rule, and the widened unmark scope, including manual test steps.

## Files to modify/create

- `DEVELOPMENT.md`
- `plugin/skills/cluster/SKILL.md`

## Background

Behaviour shipped by tasks 01_01 and 01_02 (`src/model.ts`: `selectReviewSnapshot`, `resolveFileBase`, `ReviewFile.inheritedSnapshotFrom`, `reviewSnapshotPaths`, `pathsWithReviewSnapshot`; `src/moveDisplay.ts`: `classificationText`, `buildTooltipStatusLine`; `src/treeProvider.ts` tooltip):

- A moved file (git rename or declared `repo` move that won precedence) with no snapshot of its own diffs against the snapshot at its old path (`last reviewed ↔ working tree`). Not inherited when: the move is `external`; the old path is still its own row in the review set (overwrite case, displaced git-rename source, origin still on disk); the old-path snapshot is the deleted sentinel. A file's own snapshot outranks the inherited one; an inherited one outranks the own merge-base blob, a declared `baseBlob` and the origin base. `diffBasePath` stays the file's own path.
- Status depends on the own snapshot only: a moved file stays Needs Review until marked at the new path. Mark writes the new path only.
- Classification: deleted → none; a last reviewed snapshot (own, else inherited) exists → `unchanged` if identical, else `adapted`; otherwise today's `verbatim`/`adapted`/none against the origin base. Row `· unchanged`; tooltip `Unchanged since last reviewed`, and no `Changed since last reviewed` line for an unchanged file. `verbatim` therefore only appears with no snapshot at either path.
- Unmark (every scope that goes through `pathsWithReviewSnapshot`, and the file row) drops the moved file's own snapshot and the inherited old-path snapshot; the row offers `−` (`Snapshot` context token) when it only inherits.
- No contract or snapshot-storage format change.

Current doc locations: `DEVELOPMENT.md:24-37` (status rules and `−` scope), :82 (verbatim/adapted bullet), :83 (diff-base bullet), :81 (description/tooltip stack list), manual Moves steps 9-14 (:224-231). `plugin/skills/cluster/SKILL.md:113` (`note` bullet: "verbatim/adapted is not a contract field").

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/cluster/SKILL.md (doc): the clusters contract file — read before changing cluster generation or its file format

## Implementation details

1. `DEVELOPMENT.md` "How it works" status bullets: add the inherited-snapshot rule (one bullet: moved file with no own snapshot diffs against the old path's snapshot, stays Needs Review, with the not-inherited conditions and precedence).
2. `−` scope bullet: unmark also drops an inherited old-path snapshot; inheriting rows count as holding a snapshot.
3. Moves section: description form becomes `· verbatim|adapted|unchanged`; the tooltip stack list gains `Unchanged since last reviewed` as the status line for unchanged and notes `Changed since last reviewed` is omitted then; the derived-classification bullet states the snapshot-first order; the diff-base bullet notes snapshot (own or inherited) precedes everything, with `diffBasePath` the file's own path.
4. Manual steps: step 9/11 wording stays true for files with no snapshot; amend step 11 (a Reviewed move row reads `· unchanged`); add a new step after 14: mark a file reviewed, `git mv` it and stage → one R row in Needs Review reading `← <old dir> · unchanged`, tooltip `Unchanged since last reviewed`, title `… (moved from <old> — last reviewed ↔ working tree)`, empty diff; edit it → `· adapted`, diff shows only the edit, tooltip `Changed since last reviewed`; press `−` → `git ls-tree -r refs/review/<branch>` lists neither path and the diff is back to the origin base with `· verbatim|adapted`. Renumber later steps and any in-doc references to them (e.g. "contrast step 17").
5. `plugin/skills/cluster/SKILL.md:113`: name `unchanged` alongside verbatim/adapted as computed, not a contract field.
6. Follow CLAUDE.md: Contract-style, terse, each rule stated once; skill doc Contract vs Default workflow structure untouched.

## Gotchas

- Do not run `yarn format` over `.mise/` or `.claude/` (kept in `.prettierignore`); only format the two edited docs if needed.
- Step renumbering: grep `DEVELOPMENT.md` for `step 1[0-9]`/`step 2[0-9]` references before and after.
- No source file changes in this task.

## Verification

- No tests cover docs. Substitute check: `yarn lint`, `yarn build`, `yarn test` stay green; `npx prettier --check DEVELOPMENT.md plugin/skills/cluster/SKILL.md` passes; grep confirms every step cross-reference in `DEVELOPMENT.md` points at the right renumbered step; every statement in the new text matches `selectReviewSnapshot`/`resolveFileBase` in `src/model.ts` and `buildTooltipStatusLine` in `src/moveDisplay.ts`.
