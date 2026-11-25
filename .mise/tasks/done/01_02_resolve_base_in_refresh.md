# 01_02 Resolve the per-branch base in refresh; base status-bar item

## Goal

Make every refresh compute the review set against the per-branch resolved base instead of the global setting. Show a new status-bar item `$(git-compare) ← <base>` whose tooltip names where the base came from. When an explicit base does not resolve, show an error state instead of the model.

## Files to modify/create

- src/extension.ts
- src/model.ts
- src/diffBaseUi.ts (new; test: src/diffBaseUi.test.ts)

## Background

- Task 01_01 produced `src/diffBase.ts`: `resolveDiffBase(git, branch, fallback, cache)` returns a `BaseResolution` `{ branch, base, source: "explicit" | "detected" | "fallback", detectedVia?: "forkPoint" | "upstream", fallback, missing, stale, fileError?, suggestions }`. `DetectionCache` is a mutable object the caller owns, built only by `createDetectionCache()` (its `perCandidate` map is required) and emptied in place by `resetDetectionCache(cache)`.
- `refresh()` lives at `src/extension.ts:405`. Today it reads `baseBranch` from configuration at `:424`, resolves the branch at `:432`, and passes `baseBranch` to `computeReviewModel` at `:464` and `:502` (the auto-mark recompute). The counter tooltip at `:592` reads `Delta Review: ${model.branch} vs ${baseBranch}`. The fatal catch branch at about `:780-791` hides the counter and sets `treeView.message`.
- Caches cleared on repo switch: `hashCache.clear(); sliceCache.clear();` in `setActiveRepo` (`src/extension.ts:898-905`). Reset the detection cache there.
- The counter status item is created at `src/extension.ts:308-312` (left, priority 50, command `deltaReview.focus`) and pushed to `context.subscriptions` right after.
- `computeReviewModel` (`src/model.ts:574`) throws `Cannot compute merge-base with "<base>". Check the deltaReview.baseBranch setting.` at `:606-608`. The base no longer always comes from the setting, so the hint moves to the extension, which knows the base's source. The fatal catch must keep a way out: with no merge-base the user still needs the setting hint (fallback source) and the base item to reach the picker (01_03 attaches its command).
- `ReviewModel.mergeBase` (`src/model.ts:110`) feeds the tooltip's `Merge-base <short sha>`.
- Mock text (`.mise/mock/status-bar.html`, `base-error.html`), with each tooltip line on its own line:
  - Explicit: `Delta Review base: <base>` / `Set for branch <branch> (all worktrees on this branch).` / `Merge-base <sha7>` / `Click to change the base.`
  - Detected fork point: `Delta Review base: <base> (auto-detected)` / `Closest local branch this branch forked from.` / `Merge-base <sha7>` / `Click to pin a base for this branch.`
  - Detected upstream: second line is `Upstream of this branch (<upstream>).`
  - Fallback: `Delta Review base: <base> (default)` / `From setting deltaReview.baseBranch.` / `Merge-base <sha7>` / `Click to pin a base for this branch.`
  - Missing: text `$(warning) ← <base>`, error tint, tooltip `Base <base> not found. Click to choose a base.`
  - When `fileError` is set, append `Base file ignored: <error>`.
  - Tooltips name the source, never whether a user or an agent set the base.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `src/model.ts`: export `class MergeBaseError extends Error { constructor(readonly base: string) }` with `name = "MergeBaseError"` and message `Cannot compute merge-base with "<base>".`; throw it at `:606-608` in place of the current `Error`.
- `src/diffBaseUi.ts` (pure, no vscode):
  - `baseStatusPresentation(resolution, mergeBase: string | undefined, options?: { mergeBaseFailed?: boolean }): { text: string; tooltip: string; tint: "none" | "warning" | "error" }`. `warning` is not produced yet (01_04 adds stale), so return `none` / `error` only. With `mergeBaseFailed`: text `$(warning) ← <base>`, tint `error`, tooltip `No merge-base between <base> and HEAD. Click to choose a base.`
  - `mergeBaseErrorMessage(resolution): string`: `⚠ Cannot compute merge-base with "<base>".` followed by ` Check the deltaReview.baseBranch setting or click the base in the status bar to choose one.` for source `fallback`, else ` Click the base in the status bar to choose another.`
  - Export both and unit-test every source variant.
- `extension.ts`:
  - Create `baseStatusItem` (left, priority 49) and push it to subscriptions. Leave its `command` unset until 01_03.
  - Hold `let baseResolution: BaseResolution | undefined` and `const baseDetectionCache = createDetectionCache()` (typed `DetectionCache` by inference).
  - In `refresh()`, after `resolveBranch`, call `resolveDiffBase(git, branch, configuration.get("baseBranch") ?? "main", baseDetectionCache)`. Generation-check after the await, as the other awaits do.
  - When `resolution.missing`:
    - set `model`/`clusterModel` undefined
    - `treeProvider.setModel(undefined)`
    - `treeView.badge = undefined`
    - `treeView.message = \`⚠ Base ${base} for branch ${branch} does not resolve.\``
    - hide the counter
    - render the base item with error tint
    - clear note threads exactly like the fatal path does
    - return
  - Otherwise pass `resolution.base` to both `computeReviewModel` calls. Set the counter tooltip to `Delta Review: ${model.branch} vs ${resolution.base}`. Render and show the base item with `model.mergeBase`.
  - Map the tint to `new vscode.ThemeColor("statusBarItem.errorBackground")` / `warningBackground` / undefined.
  - In the fatal catch: when the error is a `MergeBaseError` and `baseResolution` is current, set `treeView.message = mergeBaseErrorMessage(baseResolution)` and render the base item with `mergeBaseFailed: true` and keep it shown. Any other fatal error, and the `git === undefined` branch, hide the base item.
  - Assign `baseResolution` before calling `computeReviewModel`, so the catch can read it.
- In `setActiveRepo`, beside `hashCache.clear(); sliceCache.clear();`, call `resetDetectionCache(baseDetectionCache)` (in place, so the `const` binding stays valid for in-flight refreshes, which then bail on the generation check).
- Extend `deltaReview.__inspect` (test hook, `src/extension.ts:~2200`) with `base: baseResolution` and `baseStatus: { text, tooltip, visible }`, so a host check can read them.

## Gotchas

- Keep `resolveDiffBase` inside the existing `try`, so a torn-down repo still reaches the fatal banner.
- The contract-dir watcher (`watchContractDir`, glob `{*.json,...}`) already refreshes on `base-*.json` changes. Don't add a watcher.
- `StatusBarItem.tooltip` accepts a string with `\n`. Plain text is fine.
- Don't touch the stale logic or the picker. Those are 01_03 and 01_04.

## Verification

- `src/diffBaseUi.test.ts` covers the explicit, detected fork-point, detected upstream, fallback, missing, `mergeBaseFailed` and fileError tooltips and texts, and `mergeBaseErrorMessage` for fallback (contains `deltaReview.baseBranch`) and explicit/detected (does not).
- `src/model.test.ts`: `computeReviewModel` with a failing merge-base rejects with a `MergeBaseError` whose `base` is the ref passed and whose message is `Cannot compute merge-base with "<base>".` (no setting hint). The `computeReviewModel` suite's Git stub (`setUp`, `src/model.test.ts:~968-1000`) always answers `merge-base` with `MERGE_BASE` (`~:991`), so extend it: add an optional `mergeBaseFails?: boolean` to `FakeRepo` (`src/model.test.ts:877`) and make the `merge-base` branch reject (e.g. `throw new Error("fatal: no merge base")`) when it is set. No existing test asserts the old `Check the deltaReview.baseBranch setting` text, so there is nothing to adjust.
- Run `yarn test`, `yarn lint`, `yarn build`.
- Scripted extension-host check (DEVELOPMENT.md "Scripted extension-host checks"; launch with `env -u ELECTRON_RUN_AS_NODE` and a short `--user-data-dir`; batch with other checks where possible). Use a temp repo with `main` → `feat/a` → `feat/b` checked out.
  - `__inspect().base.source === "detected"`, `base === "feat/a"`, and the status text is `$(git-compare) ← feat/a`.
  - Write `.git/delta-review/base-feat-b.json` = `{"version":1,"branch":"feat/b","base":"main"}`. After the refresh, the source is explicit and the files are the diff vs main.
  - Set the base to `nope`. The tree has no rows, `baseStatus.text` contains `$(warning)`.
  - Create an orphan branch `lonely` (`git checkout --orphan lonely && git commit --allow-empty -m x && git checkout feat/b`) and set the base to `lonely`. `baseStatus.visible` is true, its text contains `$(warning)`, and the tree message contains `Click the base in the status bar`.
