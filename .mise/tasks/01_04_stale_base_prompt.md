# 01_04 Stale-base prompt

## Goal

When the branch's stored or detected base is fully merged into the fallback base, ask the user before changing anything: Switch to the fallback / Keep the old base / Choose…. Tint the base status item while the prompt is unanswered, and never switch silently.

## Files to modify/create

- src/diffBaseUi.ts
- src/extension.ts

## Background

- Task 01_01: `BaseResolution.stale` and `.fallback`, plus `writeBranchBase(git, branch, base)` (`src/diffBase.ts`).
- Task 01_02: `baseStatusPresentation(resolution, mergeBase)` in `src/diffBaseUi.ts` returns `{ text, tooltip, tint }`. `refresh()` in `src/extension.ts` stores `baseResolution` and renders `baseStatusItem`.
- Task 01_03: `showBasePicker({ git, resolution, preferFirst })` in `src/basePicker.ts` returns `{ outcome: "picked"; ref } | { outcome: "cleared" } | { outcome: "cancelled" }`. Picks write the contract file themselves.
- Workspace-state persistence pattern: `context.workspaceState.get/update` (`src/extension.ts:134-141`).
- Git common dir lookup: `git rev-parse --git-common-dir`, resolved against the repo root (see `deltaReviewDirFor`, `src/documents.ts:97`). It keys suppression so all worktrees of a repo share the key format.
- Mock (`.mise/mock/stale-base.html`):
  - Warning `Base <base> is fully merged into <fallback>. Switch the diff base for <branch> to <fallback>?`
  - Buttons `Switch to <fallback>`, `Keep <base>`, `Choose…`.
  - While the prompt is unanswered, the item text is `$(warning) ← <base>` with `statusBarItem.warningBackground`, and the tooltip adds the line `Merged into <fallback>. Click to choose a base.`. Clicking it opens the picker with the fallback listed first.
  - Outcomes:
    - Switch stores the fallback as explicit.
    - Keep stores the old base as explicit and suppresses the pair.
    - Choose… opens the picker (fallback first).
    - Close or dismiss suppresses the pair and keeps the base.
  - In every case the item returns to the normal tint.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `diffBaseUi.ts`:
  - Pure helpers `staleKey(commonDir, branch)` → `${commonDir}\0${branch}`, and `shouldPromptStale(resolution, dismissed: Record<string, string>, key, prompting: ReadonlySet<string>): boolean`. The latter is true iff `resolution.stale && dismissed[key] !== resolution.base && !prompting.has(key)`.
  - `withStaleDismissed(dismissed, key, base)` returns a new record.
  - Extend `baseStatusPresentation` with an optional `promptOpen: boolean`. When it is true and the resolution is stale, the tint is `warning`, the text is `$(warning) ← <base>`, and the tooltip gets the extra line.
- `extension.ts`:
  - State: `dismissed = workspaceState.get("deltaReview.staleBaseDismissed", {})` and `const stalePrompting = new Set<string>()`.
  - After a successful refresh publish, if `shouldPromptStale`, add the key and re-render the item with `promptOpen`. Then, without awaiting inside refresh, show `showWarningMessage(text, switchLabel, keepLabel, "Choose…")`. Handle the choice:
    - Switch: `writeBranchBase(git, branch, fallback)`.
    - Keep: `writeBranchBase(git, branch, base)` and dismiss the pair.
    - Choose…: `showBasePicker({ …, preferFirst: fallback })`. If its outcome is `cancelled`, dismiss the pair.
    - undefined: dismiss the pair.
  - Finally delete the key from `stalePrompting`, persist `dismissed`, and refresh.
  - Capture `git`, branch, base and fallback in locals when the prompt opens. Act on those, even if the active repo changed meanwhile.
  - When the status item is clicked while the prompt is open (stale and prompting), call `showBasePicker` with `preferFirst: fallback`.
  - A pick from the picker suppresses that branch/base pair: wherever `showBasePicker` returns `{ outcome: "picked", ref }` (the `deltaReview.setBranchBase` command and the Choose… path), record `dismissed[key] = ref`, so knowingly choosing a merged branch never prompts.

## Gotchas

- `showWarningMessage` resolves only when the user acts. Never `await` it inside `refresh()`, or refresh stalls.
- Refreshes run often. The `stalePrompting` set is what prevents stacking duplicate notifications.
- A different base for the same branch is a new pair, so a stale dismissal of `feat/a` doesn't suppress `feat/c`.
- Notification "close" (×) and timeout-to-tray both resolve `undefined`. Both count as dismissal, per the decision.

## Verification

- Unit tests in `src/diffBaseUi.test.ts`:
  - `shouldPromptStale` returns false when not stale, when dismissed for the same base, or when already prompting, and true when dismissed for a different base.
  - `withStaleDismissed` is immutable.
  - The presentation with `promptOpen` has warning tint, warning text and the extra tooltip line.
- Run `yarn test`, `yarn lint`, `yarn build`.
- Notifications cannot be answered headlessly. Verify manually in the dev host (eyeball):
  - Set up a repo with `main` → `feat/a` → `feat/b`, explicit base `feat/a` on `feat/b`, then `git checkout main && git merge --no-ff feat/a && git checkout feat/b`.
  - On refresh, the prompt appears and the item is tinted.
  - Keep, then refresh: no new prompt.
  - Switch writes `main` to `base-feat-b.json`.
