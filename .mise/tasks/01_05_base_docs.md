# 01_05 Per-branch base docs and cluster skill contract

## Goal

Document the per-branch diff base:

- the agent-settable contract file and the exact resolution rule in the cluster skill, so `delta:cluster` computes the same base as the extension
- the user-facing behavior in README.md
- the internals in DEVELOPMENT.md

## Files to modify/create

- plugin/skills/cluster/SKILL.md
- README.md
- DEVELOPMENT.md
- package.json

## Background

- Tasks 01_01 to 01_04 implemented these:
  - `src/diffBase.ts`: contract file `<common dir>/delta-review/base-<sanitized-branch>.json` = `{ "version": 1, "branch": "<branch>", "base": "<ref>" }`.
    - Invalid (including a missing or empty `branch`) is treated as absent.
    - `branch` is the owning branch's full name. Sanitization (`[^A-Za-z0-9._-]` → `-`) maps `feat/x` and `feat-x` to the same file, so a file whose `branch` differs from the current branch is ignored (treated as absent, no error). Writing overwrites whoever owned the file; clearing leaves a file owned by another branch in place.
    - A branch name from `git rev-parse --abbrev-ref HEAD` has one leading `heads/` stripped (printed when a tag shares the name) before any use.
    - Resolution is explicit → detected → `deltaReview.baseBranch` (default `main`).
    - Detection:
      - One `git for-each-ref --format='%(refname:short) %(objectname) %(ahead-behind:HEAD)' refs/heads` (git >= 2.41) lists local branches in order with `ahead behind`, minus the current branch. Distance is `behind` (commits in HEAD not in the candidate).
      - One `git reflog show --format='%H %gs' refs/heads/<branch> --` (newest first) gives: `creationRef` (oldest subject `branch: Created from <ref>`, leading `refs/heads/` stripped, ignored when `HEAD`); `unmoved` (the newest line is that creation line and its sha equals HEAD's); `ownCommits` (shas, newest first, of lines whose subject starts with `commit`, `cherry-pick`, `revert` or `rebase`, or starts with `merge`/`pull` without `Fast-forward`; minus any `… (finish): … onto <sha>` line whose own sha equals its `onto` sha, a rebase that only fast-forwarded). No reflog: no `creationRef`, not `unmoved`, no `ownCommits`.
      - `containing`: when `ownCommits` is non-empty, one `git for-each-ref --format='%(refname:short)' --contains=<c1> --contains=<c2> … refs/heads` with the 32 newest own commits (git ORs repeated `--contains`) lists every branch holding an own commit (children of this branch, branches created at an own commit).
      - Skip a candidate when `behind == $(git rev-list --count HEAD)` (no common history), when `behind == 0` and the branch is not `unmoved` (same tip as HEAD, or a descendant), or when it is in `containing` and is not the fallback.
      - The smallest distance wins. A tie goes to the fallback name, then to `creationRef`, otherwise the earlier candidate.
      - Older git: per-candidate `merge-base` + `rev-list --count <mb>..HEAD` (`behind == 0` is `mb == HEAD sha`), same rules.
      - With no candidate, use `@{upstream}` when it does not end with `/<branch>` and `git merge-base <upstream> HEAD` succeeds.
      - On the fallback branch itself, detection is skipped (source fallback).
    - Stale means an explicit or fork-point-detected branch base that is an ancestor of the fallback and whose tip is off the fallback's first-parent chain (last line of `git log --first-parent --format=%P <base>..<fallback>` has a first field other than the base tip), on a branch other than the fallback. Upstream-detected bases are never stale.
    - Known limitations: without a reflog (or when all own commits a child holds are older than the 32 newest), a child branch can win detection; a branch created at a commit this branch only fast-forwarded or reset to is not recognized as own; same-commit candidates are told apart only by `creationRef`; without a reflog a brand-new branch picks a farther ancestor until its first commit; a base fast-forwarded into the fallback is never flagged stale.
    - Missing means an explicit base that does not resolve.
  - UI: status-bar item `$(git-compare) ← <base>` (tooltip names explicit/auto-detected/default) opens the "Delta Review: Set Diff Base for Branch" picker. The stale prompt offers Switch / Keep / Choose…. A missing base shows a tree message with Choose a base / use automatic detection links.
- Current text to replace:
  - `plugin/skills/cluster/SKILL.md:207-211`, workflow step 1, which reads the base only from `.vscode/settings.json`.
  - The `<base>` in step 2 (`:213-216`).
  - DEVELOPMENT.md:29 and :74 ("merge base with the base branch", "`merge-base(baseBranch, HEAD)`").
  - `package.json:645`, the `deltaReview.baseBranch` setting description (`Branch the review set is computed against (merge-base with HEAD).`).
  - DEVELOPMENT.md:256-262, the manual script (merge base wording; add a base step).
  - README.md:25 (Usage, "Files changed vs the base branch") and :105 (Settings: `deltaReview.baseBranch`, the branch the review set is computed against).
- CLAUDE.md rules for skill docs and DEVELOPMENT.md:
  - Binding **Contract** plus an overridable **Default workflow** that references it.
  - Terse, every line normative. State each rule once, in the Contract. Workflow steps reference Contract sections by name.
  - No `REQ-*` ids. README style: one-liner plus skimmable bullets.

## Guides

- plugin/skills/cluster/SKILL.md (doc): the clusters contract file — read before changing cluster generation or its file format
- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- Cluster SKILL.md: add a Contract subsection `### Diff base` after `### File location`. It covers:
  - file path and shape, including the required `branch` field, why it exists (sanitized names collide), and that a file with another `branch` is ignored; the writer sets `branch` to the full branch name (no leading `heads/`)
  - who writes it: the extension's picker, and any agent that creates or drives a branch and knows its parent
  - set: atomic write (temp file in the same dir, then rename)
  - clear: delete the file
  - invalid means ignored
  - the resolution order
  - one bash snippet that prints the resolved base, reproducing detection exactly: same candidate order, reflog derivation (`creationRef`, `unmoved`, `ownCommits` with the fast-forward-rebase exclusion), the single capped `--contains` for-each-ref and the fallback exemption, skip rules, distance, tie-break (fallback, then `creationRef`, then earlier), and upstream eligibility including the `git merge-base <upstream> HEAD` check. The fallback is `deltaReview.baseBranch` from `.vscode/settings.json` (JSONC, read as text), else `main`.
  - The snippet strips a leading `heads/` from `git rev-parse --abbrev-ref HEAD`, and reads the explicit file only when its `branch` equals the current branch.
  - The user-scope-settings caveat currently in step 1 moves here (it concerns the fallback only).
  - one line naming the detection limitations from Background (so an agent knows when to write the file instead of relying on detection).
- Replace workflow step 1's base sentence with "Resolve the base per **Diff base**." Step 2 keeps `git merge-base <base> HEAD`.
- State that the contract file is never committed (lives under the git dir), like the clusters file.
- README:
  - Usage gets a bullet: the base is per branch (shared by worktrees), shown in the status bar, changed with the picker. A merged parent prompts to switch.
  - Settings: `deltaReview.baseBranch` becomes the fallback base when a branch has no explicit or detectable base (default `main`).
- package.json: set the `deltaReview.baseBranch` description to `Fallback diff base for a branch with no explicit or auto-detected base (merge-base with HEAD).` Change nothing else in package.json.
- DEVELOPMENT.md:
  - Fix lines 29 and 74 to say "the branch's diff base".
  - Add `### Diff base` under "How it works", after "Where the state lives":
    - file, resolution and detection rules (point to `src/diffBase.ts`; do not restate the snippet)
    - the detection cost (fixed spawn count via `ahead-behind`, older-git per-candidate fallback) and cache keys
    - stale and missing semantics, and the suppression key `deltaReview.staleBaseDismissed`
    - the known limitations listed in Background (detection and stale)
  - Add manual-script steps after step 8:
    - status item text and tooltip per source
    - pick a base → `base-<branch>.json` written and the view refreshes
    - Use automatic detection removes it
    - a merged parent → prompt; Keep suppresses
    - an explicit missing ref → tree message and error tint

## Gotchas

- The snippet must work in macOS bash 3.2 and zsh: no associative arrays, no `mapfile`.
- Membership tests for `containing` and candidate order in the snippet: use a newline-separated string with `grep -qx` or an awk pass, not arrays. Build the `--contains` args from the first 32 own shas with `head -n 32` and word splitting (shas contain no spaces).
- The snippet uses the `ahead-behind` form only and states it needs git >= 2.41; it does not reproduce the older-git fallback.
- Don't document the extension's internal workspace-state key in the skill. That is DEVELOPMENT.md only.
- Keep the review-notes skill untouched. It needs no base.

## Verification

- No test covers docs. Substitute check: in a scratch temp repo, build these scenarios and run the SKILL.md snippet verbatim. Its output must equal `__inspect().base.base`, or the `resolveDiffBase` result from a throwaway Vitest script run against the same repo.
  - `main` → `feat/a` → `feat/b`: expect `feat/a`.
  - After `git merge --no-ff feat/a` into main: expect `main`.
  - With an explicit file: expect the file's value.
  - With no local candidates but an upstream: expect the upstream.
  - On `feat/b` with a commit, after `git branch x`: expect `feat/a`; after one more commit on `feat/b`: still `feat/a`.
  - Stacked child: `main` → `feat/x` (x1, x2) → `feat/y` (y1), then x3 on `feat/x`: on `feat/x` expect `main`.
  - Fast-forward rebase: `git branch feat/b main`, on `feat/b` `git rebase feat/a`, then a commit: expect `feat/a`.
  - Collision: a file for `feat/x` read while on `feat-x`: expect detection, not the file's base.
  - Brand-new `git branch feat/d feat/a && git checkout feat/d` with an earlier-sorting branch `z` at the same commit: expect `feat/a`.
- `grep -n '"description"' package.json | grep -i fallback` shows the new `deltaReview.baseBranch` description.
- Re-read the three docs for statements that still claim a single global base: `grep -n "baseBranch\|merge base" README.md DEVELOPMENT.md plugin/skills/cluster/SKILL.md`. Every remaining hit must describe the fallback or a per-branch base.
- Run `yarn lint` and `yarn build` (unchanged code; confirms nothing else broke).
