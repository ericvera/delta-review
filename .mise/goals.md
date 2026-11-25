currently it seems like the base commit/branch on a diff is always main or set per config. Different worktrees may need different base branches and also the branch may change over the like of a branch if another branch gets merged into main (for example).

## Investigation

- Base resolved once per refresh from setting `deltaReview.baseBranch` (default `"main"`), src/extension.ts:424; passed to `computeReviewModel` (extension.ts:464, 502); shown in status bar tooltip (extension.ts:592). Declared package.json:642-646, documented README.md:105.
- src/model.ts:574-610 computes `git merge-base <base> HEAD`; error message points at the setting (model.ts:608). `ReviewModel.mergeBase` at model.ts:110.
- Setting change refreshes via `onDidChangeConfiguration` (extension.ts:2165-2169); a per-branch store needs its own refresh trigger.
- Per-branch state pattern: keyed by branch name under the git common dir, shared across worktrees — `deltaReviewDirFor` (src/documents.ts:97), `refs/review/<branch>` (src/reviewState.ts:13), `refs/review-notes/<branch>` (src/notesStore.ts:42), `sanitizeBranchForFilename` (src/clusters.ts:234). Per-branch storage covers per-worktree bases since worktrees sit on different branches.
- `context.workspaceState` (extension.ts:136-173) is per-workspace, not per-branch.
- Active repo/worktree switches via `setActiveRepo` (extension.ts:898), driven by SCM selection (extension.ts:2240-2294).
- Left-side review notes anchor merge-base blobs (notesStore.ts:36-40, src/noteTarget.ts:99-103); a base change can outdate base-side notes. Reviewed snapshots are content-based (model.ts:353-396) and survive.
- `delta:cluster` skill reads its base only from `deltaReview.baseBranch` in `.vscode/settings.json` (plugin/skills/cluster/SKILL.md:207-217); contract must learn the per-branch base. review-notes skill needs no base (plugin/skills/review-notes/SKILL.md:39).
- Docs stating a fixed base: DEVELOPMENT.md:29, :74, :256-262.
- `GitRepository` typing exposes no upstream/branch info (src/gitExtensionApi.ts:8-23); detection needs direct `git` calls.
- Tests: temp-repo tests for `computeReviewModel` at src/model.test.ts:959, :1080. Put base resolution in a new vscode-free module with colocated test; scripted host check for wiring (DEVELOPMENT.md:238-251).
- A base picker command/button triggers the UI mock condition.

## Decisions

- Base is per branch, shared by every worktree on that branch. Resolution order: an explicit per-branch base (set by the user or an agent), else auto-detected base (closest local branch HEAD forked from, or the upstream), else `deltaReview.baseBranch`.
- User sets/overrides a branch's base with a status-bar picker.
- Agents can set a branch's base too, through a documented contract (owned by a plugin skill doc), so an agent creating or driving a branch can declare its base without the UI.
- Stale base (stored or detected base fully merged into the fallback base, e.g. parent branch merged into `main`): show a prompt offering to switch to the fallback; never switch silently.
- Base change outdates some base-side review notes: accepted, they show as outdated as today when the merge-base moves; no warning.
- `delta:cluster` must compute the same base the extension uses.

## Assumptions

- The agent-facing mechanism (git config key vs. file under the git common dir, which skill doc owns it) is left to the spec; it must be readable by `delta:cluster` and settable without the extension running.
- Dismissing the stale-base prompt suppresses it for that branch/base pair until the base changes.
- Docs (README, DEVELOPMENT.md, cluster SKILL.md) are updated to the per-branch model; `deltaReview.baseBranch` stays as the fallback.
- Mock: a separate status-bar item `$(git-compare) ← <base>` opens the picker; the review counter still focuses the view.
- Mock: command "Delta Review: Set Diff Base for Branch"; picker offers suggestions, local branches, "Enter a ref…" (validated), "Use automatic detection".
- Mock: stale-base prompt offers Switch / Keep / Choose…; Keep saves the old base as explicit for the branch.
- Mock: tooltips name the base's source (explicit / detected / fallback), not whether a user or agent set it.
- Mock: a missing base ref shows a tree message linking to the picker.

## Proposal

- Issue: the diff base is one global setting (`main` by default), wrong for stacked branches and worktrees, and it goes stale once a parent branch is merged.
- Approach: a base for each branch (explicit from a picker or an agent contract, otherwise auto-detected, otherwise the setting), a prompt when the base goes stale, and `delta:cluster` and the docs moved to the same resolution.
- Skips: none (spec and critic both run, because this adds a new concept and a contract change).
