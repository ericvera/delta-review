# Exploration Notes — move detection

## Key files

- `src/model.ts` — `computeReviewModel(git, baseBranch, options)` builds the review set.
  - Lines 97–103: the tracked-changes command: `git diff --name-only --no-renames -z <mergeBase>` — **the `--no-renames` here is why moves render as D+A today**. Untracked files come from `ls-files --others --exclude-standard -z` (104–109); both lists are unioned, deduped, sorted (110–115).
  - `ReviewFile` interface (12–27): `path`, `status`, `deleted`, `existsInMergeBase`, `diffBaseIsReviewedSnapshot`, `diffBaseSha`, `triage`.
  - Per-file assembly (148–169): `deleted` = not in `currentShaByPath` (filesystem check); `reviewed` = snapshot sha equals current content sha; `useSnapshotBase` = unreviewed + usable snapshot; `diffBaseSha` = snapshot sha or `baseBlobs.get(path)` (merge-base blob for the SAME path — for a move this must become the OLD path's blob).
  - `baseBlobs` = `parseLsTreeOutput(git ls-tree -r -z <mergeBase>)` — map path → blob sha at merge base.
- `src/git.ts` — `createGit`, `splitNulTerminated` (42–43), `parseLsTreeOutput` (46–61). New NUL-format parsers belong here or in model.ts (both are vscode-free, unit-testable).
- `src/decorations.ts` — `ChangeKind = "modified" | "added" | "deleted"` (8); `changeKindFor` (10–11): `deleted ? … : existsInMergeBase ? "modified" : "added"`; kind travels in the tree-row URI query (`createReviewItemUri`, 15–20); `DECORATIONS` map (49–65) with badge letter + `gitDecoration.*ResourceForeground` colors.
- `src/treeProvider.ts` — file-row `getTreeItem` branch (385–431):
  - contextValue (392–396): `needsReviewFile`/`reviewedFile` + `Deleted` suffix hides Open File.
  - Description (399–414): list mode / `alwaysFlat` rows show `dirname(file.path)` (hidden when `"."`); grouped+reviewed appends `✓`.
  - Tooltip (417–425): `MarkdownString`, leads with `appendCodeblock(file.path, "text")`, then `appendMarkdown` note lines ("Deleted from the working tree", "Changed since last reviewed").
  - Row command → `deltaReview.openDiff` with the `ReviewFile` (426–430).
- `src/extension.ts` — `openDiff` (371–390): `leftUri = createReviewBaseUri(file.path, file.diffBaseSha)`; right = working file (or empty for deleted); title `` `${basename(file.path)} (${baseLabel} ↔ ${workingLabel})` `` where baseLabel is "last reviewed" | "merge base".
- `src/contentProvider.ts` — `createReviewBaseUri(path, sha)`: sha in query drives content (`cat-file blob`); the path is only for language detection/labeling.
- `src/reviewState.ts` — review state = map path → reviewed-content blob sha, stored on `refs/review/<branch>`; `markReviewed` snapshots current working content of the given paths. Everything is keyed by plain path — a moved file's snapshot lives under its NEW path automatically.
- `src/clusters.ts` — matches contract file paths against `ReviewFile.path` (new path). No change needed.

## Test conventions

- Vitest, colocated `*.test.ts` in `src/` (e.g. `src/model.test.ts` tests `parseCheckAttrOutput` with hand-built NUL-separated fixtures). The `vscode` module cannot be imported under Vitest — keep new logic pure.
- Test exceptions (config): extension-host behavior + purely visual changes → manual verification in the F5 Extension Development Host, per DEVELOPMENT.md's manual test script.

## git facts for the implementation

- Replacement command: `git diff --name-status --find-renames -z <mergeBase>` (tree vs working tree supports rename detection; explicit flag so the user's `diff.renames` config doesn't matter).
- `-z --name-status` record format: each field NUL-terminated. Single-path records: `<STATUS>\0<path>\0` (A/M/D/T…). Two-path records: `R<score>\0<oldPath>\0<newPath>\0` (and `C<score>` if copy detection were ever on — parse defensively, emit as plain added dst).
- Rename detection can silently give up on huge diffs (`diff.renameLimit`) → degrades to A+D, which REQ-DET-4 already permits.

## Quality commands (config)

Format `yarn format`; Check `yarn lint` + `yarn build`; Unit tests `yarn test`.
