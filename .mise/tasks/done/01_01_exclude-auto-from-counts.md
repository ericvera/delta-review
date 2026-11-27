# 01_01 Exclude auto-triaged files from review counts

## Goal

Files triaged `auto` (matched by `deltaReview.autoReview.globs` or marked `linguist-generated` in `.gitattributes`, e.g. `.mise/**`) stop counting toward:

- the DELTA REVIEW tree view badge (files to review),
- the status bar item text `Review x/y`,
- the per-status group header counts (`Needs Review` / `Reviewed` row descriptions).

Nothing else changes: the Auto subgroup row keeps its own count of auto files, and Mark All, folder bulk actions and `autoReview.markAutomatically` keep their current behavior.

## Files to modify/create

- `src/reviewCounts.ts` (create): pure, VS Code-free counting helper
- `src/extension.ts`: `publishModel` uses the helper; `deltaReview.__inspect` exposes the file badge and status bar text
- `src/treeProvider.ts`: status group header count excludes auto files
- `DEVELOPMENT.md`: update the Auto triage rule and the `__inspect` field list

## Background

- Triage: `src/triage.ts:3` `export type Triage = "auto" | "normal"`; every `ReviewFile` (`src/model.ts:49`) carries `triage: Triage` and `status: FileReviewStatus` (`src/model.ts:34`, `NeedsReview` / `Reviewed`). `src/model.ts` has no `vscode` import, so importing from it keeps a helper testable under Vitest.
- Current counting: `publishModel` in `src/extension.ts:558-578` counts every file in `next.files` for `treeView.badge` (value = needs-review count, tooltip `N file(s) to review`, `undefined` when 0) and `statusBarItem.text = "$(checklist) Review ${reviewedCount}/${next.files.length}"`.
- Group header count: `src/treeProvider.ts:432` `item.description = String(this.filesWithStatus(element.status).length);` — `filesWithStatus(status, triage?)` is at `src/treeProvider.ts:766-778`; passing `"normal"` narrows to non-auto files (already used at `:212`, `:382`).
- Auto subgroup count (`src/treeProvider.ts:454-456`) and cluster-mode counts (`clusterCountDescription`, `src/treeProvider.ts:~744`) are out of scope; leave them.
- Pure-helper pattern to follow: `src/rowContext.ts` (imports only from `./model`) with colocated `src/rowContext.test.ts`, whose `file(path, overrides)` factory at `src/rowContext.test.ts:9-30` builds a full `ReviewFile` — copy it.
- Test hook: `deltaReview.__inspect` returns an object built at `src/extension.ts:~2870-2922`; it already exposes `notesBadge: notesTreeView.badge` (`:2906`) and `baseStatus` (`:2913-2918`). The field list is documented in `DEVELOPMENT.md:280`.
- Doc rule to update: `DEVELOPMENT.md:130` currently says auto files are excluded from the normal list/tree and folder bulk actions, "group counts and Mark All still include them".
- Design decisions: exclusion is declared only by the existing triage inputs (no new setting or contract key). When every non-auto file is reviewed and only auto files remain, the badge is cleared (`undefined`) and the status bar shows full progress (`Review n/n`; `Review 0/0` when there are no non-auto files).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Create `src/reviewCounts.ts`:
   - `export interface ReviewCounts { reviewed: number; total: number; needsReview: number }`
   - `export const reviewCounts = (files: readonly ReviewFile[]): ReviewCounts` — counts only files with `triage !== "auto"`; `total` = that count, `reviewed` = those with `status === FileReviewStatus.Reviewed`, `needsReview = total - reviewed`.
   - Optionally also export pure formatters used by `publishModel` (e.g. `statusBarText(counts)` returning `` `$(checklist) Review ${reviewed}/${total}` `` and `badgeFor(counts)` returning `{ value, tooltip } | undefined` with the existing tooltip wording) so the strings are unit-tested too. Keep the file free of `vscode` imports.
2. `src/extension.ts` `publishModel`: replace the inline counting with `reviewCounts(next.files)` (and the formatters if added); output strings and the `undefined` badge when zero stay as today.
3. `src/extension.ts` `deltaReview.__inspect`: add `fileBadge: treeView.badge` and `statusBarText: statusBarItem.text` beside `notesBadge`.
4. `src/treeProvider.ts:432`: change to `this.filesWithStatus(element.status, "normal").length`.
5. `DEVELOPMENT.md`:
   - `:130`: say auto files are excluded from the tree badge, the status bar `Review x/y` and the `Needs Review`/`Reviewed` group counts (the Auto subgroup shows its own count); Mark All still includes them. State the rule once.
   - `:280`: add `fileBadge` (DELTA REVIEW badge) and `statusBarText` (status bar item text) to the `__inspect` field list.

## Gotchas

- Do not change `filesWithStatus` itself; the Auto subgroup and child lists depend on its unfiltered form.
- Status bar and badge must still be reset/hidden on the existing paths (`src/extension.ts:590-593`, `:643-645`, `:1019-1020`); do not touch those.
- No `REQ-*` identifiers anywhere; comments explain why, not what.
- Keep `.mise/` and `.claude/` out of any formatting run (`yarn format` would break mise approval hashes).
- The scripted host check launches VS Code in the foreground and steals focus: run it once, batched.

## Verification

- Check: `yarn lint`, `yarn build`. Unit tests: `yarn test`.
- New test `src/reviewCounts.test.ts` (fails without the change), covering:
  - mixed normal/auto files: auto files of either status are excluded from `reviewed`, `total`, `needsReview`;
  - all normal files reviewed, auto files still needing review: `needsReview === 0`, `reviewed === total`;
  - only auto files: all counts 0;
  - formatters if added: badge `undefined` at zero, singular/plural tooltip, status bar string.
- Scripted extension-host check (DEVELOPMENT.md "Scripted extension-host checks"; throwaway harness in the session scratchpad, launched with `env -u ELECTRON_RUN_AS_NODE`, short `--user-data-dir`, `DELTA_REVIEW_TEST=1`): temp git repo on a feature branch with one changed normal file and one changed `.mise/x.md`, workspace setting `deltaReview.autoReview.globs: [".mise/**"]`, `markAutomatically` off. Assert via `deltaReview.__inspect`: `fileBadge.value === 1`, `statusBarText` ends with `Review 0/1`, and the `group:needs-review` row in `treeRows` has description `1`. Then mark the normal file reviewed (`deltaReview` mark command as used in DEVELOPMENT.md's manual script) and assert `fileBadge` is `undefined` and `statusBarText` ends with `Review 1/1`.
