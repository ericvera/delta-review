# 01_01 Diff base module

## Goal

Add a vscode-free module that reads, writes and clears a branch's explicit diff base (an agent-settable contract file), auto-detects a base, resolves the effective base in priority order, and flags a stale base. Nothing calls it yet.

## Files to modify/create

- src/diffBase.ts (new; test: src/diffBase.test.ts)

## Background

- Delta Review (a VS Code extension) diffs the branch against `git merge-base <base> HEAD`. Today `<base>` is the global setting `deltaReview.baseBranch` (default `main`), read at `src/extension.ts:424`. The new model: each branch has its own base, shared by every worktree on the branch.
- Resolution order: explicit (contract file) → detected → fallback (`deltaReview.baseBranch`, passed in by the caller).
- Per-branch state lives under the git common dir, keyed by branch name, shared across worktrees:
  - `deltaReviewDirFor(git)` (`src/documents.ts:97`) resolves `<common dir>/delta-review`. Reuse it.
  - `sanitizeBranchForFilename` (`src/clusters.ts:234`) maps `[^A-Za-z0-9._-]` to `-`.
- Atomic write pattern: `writeAtomically` (`src/notesStore.ts:183-200`, private) writes a hidden random temp file in the same dir, then renames it. Copy that pattern locally; do not import it from notesStore.
- Git access: the `Git` interface (`src/git.ts:3-9`), where `git.run(args)` resolves stdout and rejects on non-zero exit. Temp-repo tests: see `src/model.test.ts:959` and `:1080` for creating real repos under `tmpdir()`.
- Design decisions reaching this task (spec `## Design`, "Per-branch diff base"):
  - Contract file: `<common dir>/delta-review/base-<sanitized-branch>.json`, content `{ "version": 1, "base": "<ref>" }`. Invalid (unparsable, version not exactly `1`, `base` not a non-empty string) is treated as absent, with an error string surfaced to the caller.
  - Detection:
    - Candidates are `git for-each-ref --format=%(refname:short) %(objectname) refs/heads` in output order, minus the current branch.
    - For each: `mb = merge-base <c> HEAD` (a failure skips it). Skip when `mb === HEAD sha` and the candidate's tip `!== HEAD sha`, since it is a descendant. Distance is `rev-list --count mb..HEAD`.
    - The smallest distance wins. A tie goes to the candidate named exactly the fallback, otherwise the earlier one keeps it.
    - With no candidate, use the upstream: `rev-parse --abbrev-ref @{upstream}`, used only if it does not end with `/<current branch>` and `merge-base <upstream> HEAD` succeeds.
  - The detection result is cached by a key of HEAD sha + for-each-ref output + upstream (or empty) + fallback. The caller owns the cache object, like `hashCache` in `computeReviewModel`.
  - `stale` is true iff all of these hold:
    - source !== "fallback"
    - base !== fallback
    - base is a branch (`git show-ref --verify --quiet refs/heads/<base>` or `refs/remotes/<base>` succeeds)
    - `git merge-base --is-ancestor <base> <fallback>` exits 0
  - `missing` is true iff the source is explicit and `git rev-parse --verify --quiet <base>^{commit}` fails. A missing base is never stale.

## Guides

- plugin/skills/cluster/SKILL.md (doc): the clusters contract file — read before changing cluster generation or its file format
- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- Exports:
  - `baseFileName(branch): string` → `base-<sanitized>.json`
  - `parseBaseFile(text): { ok: true; base: string } | { ok: false; error: string }`
  - `readBranchBase(git, branch): Promise<{ state: "missing" } | { state: "invalid"; error } | { state: "ok"; base }>`
  - `writeBranchBase(git, branch, base): Promise<void>` writes `JSON.stringify({ version: 1, base }, null, 2) + "\n"` atomically and `mkdir -p`s the dir.
  - `clearBranchBase(git, branch): Promise<void>` unlinks the file and ignores ENOENT.
  - `pickDetectedBase(candidates: { name, distance }[], fallback): string | undefined` is the pure tie-break rule. Unit-test it directly.
  - `detectBase(git, branch, fallback, cache: DetectionCache): Promise<{ forkPoint?: string; upstream?: string; upstreamEligible: boolean }>`. `upstream` is returned even when ineligible, because the picker lists it.
  - `resolveDiffBase(git, branch, fallback, cache): Promise<BaseResolution>` with `BaseResolution = { branch, base, source: "explicit" | "detected" | "fallback", detectedVia?: "forkPoint" | "upstream", fallback, missing, stale, fileError?: string, suggestions: { forkPoint?: string; upstream?: string; fallback: string } }`.
  - `isRefValid(git, ref): Promise<boolean>`, for the picker's input validation later.
- `DetectionCache` is `{ key?: string; result?: … }`, a mutable object the caller holds.
- Run the merge-base/rev-list calls sequentially or with modest parallelism (`Promise.all` over candidates is fine). Keep output order for tie-breaking regardless of completion order.
- Detached HEAD (`branch === "HEAD"`): skip the contract file and detection, and return source fallback.
- Header comment: one short paragraph on why the base is per-branch and stored under the common dir. No `REQ-*` ids.

## Gotchas

- `rev-parse --abbrev-ref @{upstream}` fails when there is no upstream. Treat that as none and don't throw.
- `%(refname:short)` can be ambiguous (`heads/x`) when a tag shares the name. Pass the candidate's `objectname` sha to `merge-base` instead of the short name, and keep the short name for display and return value.
- A child branch forked from the current branch that has since gained commits can win detection (graph-symmetric). Accepted and documented in 01_05. Do not add reflog heuristics.
- Do not import `vscode`.

## Verification

- Write `src/diffBase.test.ts`:
  - `parseBaseFile` accepts the valid shape and rejects bad JSON, version 2, empty base and a non-string base.
  - Write, read and clear round-trip in a temp repo, including a linked worktree (`git worktree add`) reading the same file.
  - `pickDetectedBase` covers smallest distance, a tie going to the fallback, and a tie between non-fallbacks going to the earlier one.
  - In temp repos, `detectBase` / `resolveDiffBase` cover:
    - a branch forked from `feat/a` (which forked from `main`) detects `feat/a`
    - after `feat/a` is merge-merged into `main` (`--no-ff`), detection yields `main`
    - with an explicit base `feat/a` after that merge, `stale: true`
    - with an explicit tag base, `stale: false`
    - an explicit nonexistent ref gives `missing: true`
    - with no local candidates and upstream `origin/main` (bare remote), `detectedVia: "upstream"`
    - an upstream named `origin/<same branch>` is not eligible
    - no candidate and no upstream gives source fallback
    - a descendant branch is skipped
    - a second call with an unchanged repo reuses the cache (assert by counting `git.run` calls through a wrapping Git)
- Run `yarn test`, `yarn lint`, `yarn build`.
