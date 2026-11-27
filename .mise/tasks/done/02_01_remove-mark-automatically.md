# 02_01 Remove the `autoReview.markAutomatically` setting

## Goal

Delete the `deltaReview.autoReview.markAutomatically` setting and the refresh-time auto-mark pass it gates. Auto-triaged files (matched by `deltaReview.autoReview.globs` or `linguist-generated` in `.gitattributes`) are already excluded from the badge, status bar and group counts (task 01_01), so marking them automatically is redundant. After this task, auto files are marked only by explicit user action (Auto header `+`, Mark All, inline `+`), like any file.

## Files to modify/create

- `package.json`: drop the setting contribution
- `src/extension.ts`: drop the auto-mark pass in `refresh()` and comments that reference it
- `DEVELOPMENT.md`: drop every mention of the setting / auto-marking
- `README.md`: drop the setting from the Auto-review section and the Settings list

## Background

- Dependency check done at planning time: nothing else relies on auto files being marked reviewed.
  - Mark All marks every file regardless of triage; folder bulk actions filter to `triage === "normal"` (`src/extension.ts:1794`); Auto header `+`/`−` are explicit commands (`deltaReview.markAutoReviewed` / `deltaReview.unmarkAutoReviewed`, `src/extension.ts:2672-2725`). None reads the setting.
  - Notes, notes grouping and the Branch overview never look at `triage`. `src/reviewCounts.ts` excludes auto files from counts regardless of status; `src/clusters.ts:678` buckets auto files regardless of status; `src/treeParents.ts:110` places auto files by status only.
  - The only reader of the setting is `src/extension.ts:692`.
- Contribution: `package.json:720-724`, the `"deltaReview.autoReview.markAutomatically"` object inside `contributes.configuration.properties`, right after `deltaReview.autoReview.globs` (mind the trailing comma on the preceding `globs` entry).
- Auto-mark pass: `src/extension.ts:687-726`, inside `refresh()` after the first `computeReviewModel` call (`:674-683`, declared `let computed`). It filters needs-review auto files, enqueues `markReviewed` on `reviewStateQueue`, re-checks `generation`, then recomputes the model.
- Comments mentioning the pass:
  - `src/extension.ts:534-539` (queue comment): says writes are "user commands and the auto-mark pass" and that refresh() must not run inside the queue "since the auto-mark pass enqueues from within refresh()". Refresh-time slice anchoring (`anchorSlicesIntoCache`, `:733-745`) still enqueues from within refresh(), so the deadlock rule stays; re-attribute it to slice anchoring.
  - `src/extension.ts:727-732` (anchoring comment): "after the auto-mark recomputation, whose slice set is the one that counts" — there is now only one computation.
- Docs mentioning the setting or auto-marking:
  - `DEVELOPMENT.md:42` "Both `computeReviewModel` calls in a `refresh()` share the instance, so the auto-mark recomputation re-hashes nothing."
  - `DEVELOPMENT.md:45` "auto-marking" in the list of queued writes, and "refresh's auto-mark pass enqueues a write of its own" (slice anchoring is the remaining in-refresh write).
  - `DEVELOPMENT.md:130` the sentences from "With `autoReview.markAutomatically` on, ..." to the end of the paragraph.
  - `DEVELOPMENT.md:150` "Its `moves` feed both `computeReviewModel` calls — the initial one and the auto-mark recomputation —".
  - `DEVELOPMENT.md:159` the sentence "With `markAutomatically` on, an unmarked auto file returns to Reviewed on the next refresh (...)".
  - `DEVELOPMENT.md:323` manual test step 25, and the trailing clause of step 28 (`:329`) "— and with `markAutomatically` on, the auto file bounces back into Reviewed on the next refresh".
  - `README.md:40` the second Auto-review bullet; `README.md:110` the Settings bullet.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `package.json`: remove the `deltaReview.autoReview.markAutomatically` property and the comma that preceded it so the JSON stays valid.
2. `src/extension.ts` `refresh()`:
   - Delete the whole `if (configuration.get<boolean>("autoReview.markAutomatically") === true) { ... }` block and its leading comment (`:687-726`).
   - Change `let computed` to `const computed`.
   - Keep the `generation !== refreshGeneration` check that directly follows the first `computeReviewModel` call.
   - Rewrite the queue comment (`:534-539`) so the in-refresh writer it names is slice anchoring; keep the rule that refresh() never runs inside the queue.
   - Rewrite the anchoring comment (`:727-732`) to drop the auto-mark recomputation reference.
   - Leave imports used elsewhere (`FileReviewStatus`, `markReviewed`) in place; remove any import that becomes unused (lint will flag it).
3. `DEVELOPMENT.md`:
   - `:42`: drop the "Both calls share..." sentence; the cache still persists across refreshes (rest of the bullet stays).
   - `:45`: drop "auto-marking" from the list; make the deadlock reason refresh-time slice anchoring.
   - `:130`: end the paragraph after "Mark All still includes them."
   - `:150`: say the contract's `moves` feed `computeReviewModel` (single call).
   - `:159`: drop the `markAutomatically` sentence.
   - Manual test: delete step 25 and renumber every later top-level step (and sub-steps such as `18a`-style labels if any follow) down by one; search the file for "step N" cross-references to renumbered steps and update them. Drop the trailing `markAutomatically` clause from the old step 28.
4. `README.md`: delete the `markAutomatically` bullet under Auto-review and under Settings. Keep the first Auto-review bullet.

## Gotchas

- Users who already set the property keep a harmless unknown-setting entry in their settings.json; no migration code.
- Do not touch `deltaReview.autoReview.globs`, the Auto subgroup commands, Mark All, or folder bulk actions.
- `refreshSliceCache` (`src/extension.ts:669-673`) still serves the single computation and the anchoring step; keep it.
- No `REQ-*` identifiers anywhere; comments explain why, not what.
- Do not run `yarn format` over `.mise/` or `.claude/` (breaks mise approval hashes).
- No scripted extension-host check is needed: the change only removes a code path behind a default-off setting.

## Verification

- Check: `yarn lint`, `yarn build`. Unit tests: `yarn test` (all existing tests stay green; no test referenced the setting).
- No new test: this removes behavior and no pure logic changes. Substitute check: `grep -rn "markAutomatically\|auto-mark" src package.json README.md DEVELOPMENT.md plugin` returns nothing (case-insensitive for "auto-mark"), and `node -e "require('./package.json')"` succeeds.
- Confirm DEVELOPMENT.md manual-test numbering is contiguous after the deletion (`grep -n "^[0-9]*\. " DEVELOPMENT.md`).
