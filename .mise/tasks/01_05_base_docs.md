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
  - `src/diffBase.ts`: contract file `<common dir>/delta-review/base-<sanitized-branch>.json` = `{ "version": 1, "base": "<ref>" }`.
    - Invalid is treated as absent.
    - Resolution is explicit → detected → `deltaReview.baseBranch` (default `main`).
    - Detection:
      - Walk local branches in `git for-each-ref refs/heads` order, minus the current branch.
      - Skip a candidate when `merge-base == HEAD` and its tip `!= HEAD`.
      - Distance is `rev-list --count <merge-base>..HEAD`. The smallest wins. A tie goes to the fallback name, otherwise the earlier candidate.
      - With no candidate, use `@{upstream}` when it does not end with `/<branch>`.
      - On the fallback branch itself, detection is skipped (source fallback).
    - Stale means an explicit or fork-point-detected branch base that is an ancestor of the fallback, on a branch other than the fallback. Upstream-detected bases are never stale.
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
  - file path and shape
  - who writes it: the extension's picker, and any agent that creates or drives a branch and knows its parent
  - set: atomic write (temp file in the same dir, then rename)
  - clear: delete the file
  - invalid means ignored
  - the resolution order
  - one bash snippet that prints the resolved base, reproducing detection exactly: same candidate order, skip rule, distance, tie-break, and upstream eligibility. The fallback is `deltaReview.baseBranch` from `.vscode/settings.json` (JSONC, read as text), else `main`.
  - The user-scope-settings caveat currently in step 1 moves here (it concerns the fallback only).
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
    - the detection cache key
    - stale and missing semantics, and the suppression key `deltaReview.staleBaseDismissed`
    - the known limitation that a child branch with newer commits can win detection
  - Add manual-script steps after step 8:
    - status item text and tooltip per source
    - pick a base → `base-<branch>.json` written and the view refreshes
    - Use automatic detection removes it
    - a merged parent → prompt; Keep suppresses
    - an explicit missing ref → tree message and error tint

## Gotchas

- The snippet must work in macOS bash 3.2 and zsh: no associative arrays, no `mapfile`.
- Don't document the extension's internal workspace-state key in the skill. That is DEVELOPMENT.md only.
- Keep the review-notes skill untouched. It needs no base.

## Verification

- No test covers docs. Substitute check: in a scratch temp repo, build these scenarios and run the SKILL.md snippet verbatim. Its output must equal `__inspect().base.base`, or the `resolveDiffBase` result from a throwaway Vitest script run against the same repo.
  - `main` → `feat/a` → `feat/b`: expect `feat/a`.
  - After `git merge --no-ff feat/a` into main: expect `main`.
  - With an explicit file: expect the file's value.
  - With no local candidates but an upstream: expect the upstream.
- `grep -n '"description"' package.json | grep -i fallback` shows the new `deltaReview.baseBranch` description.
- Re-read the three docs for statements that still claim a single global base: `grep -n "baseBranch\|merge base" README.md DEVELOPMENT.md plugin/skills/cluster/SKILL.md`. Every remaining hit must describe the fallback or a per-branch base.
- Run `yarn lint` and `yarn build` (unchanged code; confirms nothing else broke).
