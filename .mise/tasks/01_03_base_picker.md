# 01_03 Base picker

## Goal

Let the user set or clear the current branch's diff base from a QuickPick opened by the base status-bar item or the command "Delta Review: Set Diff Base for Branch". When an explicit base is missing, the empty tree links to the picker and to automatic detection.

## Files to modify/create

- src/basePicker.ts (new, vscode UI; no unit test because it imports vscode. Its item logic lives in diffBaseUi.ts)
- src/diffBaseUi.ts
- src/extension.ts
- package.json

## Background

- Task 01_01, `src/diffBase.ts`: `writeBranchBase(git, branch, base)`, `clearBranchBase(git, branch)`, `isRefValid(git, ref)`, `BaseResolution` (with `suggestions: { forkPoint?, upstream?, fallback }` and `source`).
- Task 01_02:
  - `src/extension.ts` holds `baseResolution` and `baseStatusItem` (no command yet).
  - `src/diffBaseUi.ts` exports `baseStatusPresentation`.
  - Missing explicit base: `treeView.message` is set and the tree is empty.
- Command registration pattern: the big `context.subscriptions.push(vscode.commands.registerCommand(...))` block in `src/extension.ts` (around `:1500-2130`). package.json `contributes.commands` entries carry `"category": "Delta Review"` (`package.json:39-256`). `viewsWelcome` is at `package.json:33-38`. Commands hidden from the palette are listed under `menus.commandPalette` with `"when": "false"`.
- Mock (`.mise/mock/base-picker.html`):
  - Title `Diff base for <branch>`, placeholder `Select a base branch or type a ref`.
  - Separator `suggested`, with items:
    - `$(git-compare) <forkPoint>` with description `auto-detected · forked from current`
    - `$(cloud) <upstream>` with description `upstream`
    - `$(gear) <fallback>` with description `default (deltaReview.baseBranch)`
  - Separator `local branches`, with `$(git-branch) <name>` per local branch.
  - A separator, then `$(edit) Enter a ref…` (description `tag, remote branch, or commit`) and `$(discard) Use automatic detection` (description `clears the explicit base`, shown only when `source === "explicit"`).
  - The current base carries a `$(check)` prefix in its label.
  - Typing filters the list. A typed value matching no item label adds `Use ref '<typed>'`.
  - `Enter a ref…` opens an InputBox with prompt `Ref to diff <branch> against (press Enter to confirm, Escape to cancel)`. It validates as the user types with the message `'<ref>' is not a valid ref in this repository.` and stores nothing on invalid input.
- Missing-base welcome (`.mise/mock/base-error.html`): links `Choose a base` and `use automatic detection`.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `diffBaseUi.ts`: add pure `basePickerEntries(resolution, localBranches: string[], options?: { preferFirst?: string }): PickerEntry[]`.
  - `PickerEntry` is `{ kind: "separator"; label } | { kind: "ref"; ref; label; description?; current: boolean } | { kind: "enterRef" } | { kind: "automatic" }`.
  - Suggestions are de-duplicated (a ref appears once, in its first section). Local branches exclude the current branch and refs already suggested.
  - `preferFirst` moves that ref to the top of `suggested`. 01_04's "Choose…" uses it.
  - Export it and unit-test it.
- `basePicker.ts`: `showBasePicker({ git, resolution, preferFirst? }): Promise<{ outcome: "picked"; ref: string } | { outcome: "cleared" } | { outcome: "cancelled" }>`. Task 01_04 uses the picked `ref`.
  - Lists local branches via `git for-each-ref --format=%(refname:short) refs/heads`.
  - Builds a `createQuickPick` from the entries. On accept of a ref it calls `writeBranchBase`. For automatic it calls `clearBranchBase`. `onDidChangeValue` maintains the dynamic `Use ref '<typed>'` item; validate its value with `isRefValid` before writing, and show the error message on failure.
  - The InputBox uses `validateInput` (async allowed) with `isRefValid`.
- `extension.ts`:
  - Register `deltaReview.setBranchBase`. With no git or no resolution, return with info `Delta Review: no repository is active.`. On detached HEAD (`branch === "HEAD"`), show `Delta Review: detached HEAD has no branch to set a base for.`.
  - Read `git` / `baseResolution` into locals before awaiting, as the mark commands do (`src/extension.ts:1562-1566`). Refresh after picked or cleared.
  - Register `deltaReview.useAutomaticBase`: `clearBranchBase` + refresh.
  - Set `baseStatusItem.command = "deltaReview.setBranchBase"`.
  - Set context key `deltaReview.baseMissing` (via `setContext`, like `deltaReview.viewMode` at `:161`) true in the missing path, false otherwise.
  - Set context key `deltaReview.mergeBaseFailed` true in 01_02's `MergeBaseError` fatal path, false otherwise. The base item keeps `command = "deltaReview.setBranchBase"` there (01_02 keeps it visible), so the picker stays reachable when no merge-base exists.
- `package.json`:
  - Commands `deltaReview.setBranchBase` (title `Set Diff Base for Branch`, icon `$(git-compare)`) and `deltaReview.useAutomaticBase` (title `Use Automatic Diff Base Detection`).
  - A `viewsWelcome` entry for view `deltaReview`, when `deltaReview.baseMissing`, contents `[Choose a base](command:deltaReview.setBranchBase) or [use automatic detection](command:deltaReview.useAutomaticBase).`
  - A second `viewsWelcome` entry, when `deltaReview.mergeBaseFailed`, contents `[Choose a base](command:deltaReview.setBranchBase)`.
  - Add `deltaReview.setBranchBase` to the `deltaReview` view's `view/title` overflow (`"group": "base@0"`, no `navigation`), per the mock note that the picker is also reachable from the `···` menu.

## Gotchas

- QuickPick has no disabled items and no headers other than `QuickPickItemKind.Separator`. Use separators for the section labels.
- Changing `quickPick.items` resets the active item. When adding the dynamic item, keep the filter value and set `activeItems` to it.
- Branch names may contain `/`. `writeBranchBase` sanitizes only the file name. The stored `base` is the raw ref.
- The picker writes a file that the contract-dir watcher sees, but call `refresh()` explicitly after the write anyway. Don't rely on the watcher.

## Verification

- Unit tests in `src/diffBaseUi.test.ts` for `basePickerEntries`:
  - de-duplication across sections
  - current-base check
  - automatic entry only for explicit
  - `preferFirst` ordering
  - the current branch is excluded from local branches
- Run `yarn test`, `yarn lint`, `yarn build`.
- Scripted extension-host check (batch with 01_02's if run together):
  - With an explicit missing base, `executeCommand("deltaReview.useAutomaticBase")` removes `base-<branch>.json`, and `__inspect().base.source` becomes `detected` or `fallback`.
  - With an explicit base that resolves but shares no history with HEAD (an orphan branch), `__inspect().baseStatus.visible` is true and `baseStatus.command === "deltaReview.setBranchBase"` (add `command` to 01_02's `baseStatus` inspect shape here).
  - The QuickPick itself cannot be driven headlessly. Verify it manually in the dev host (eyeball only): sections, check mark, `Use ref '<typed>'`, invalid ref message.
