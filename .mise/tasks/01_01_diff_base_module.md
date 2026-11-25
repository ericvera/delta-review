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
  - `sanitizeBranchForFilename` (`src/clusters.ts:234`) maps `[^A-Za-z0-9._-]` to `-`. It is not injective (`feat/x` and `feat-x` both give `base-feat-x.json`), hence the `branch` field in the contract file.
  - `readMarkBranch` (`src/pendingRead.ts:19-20`, vscode-free) strips one leading `heads/`: `git rev-parse --abbrev-ref HEAD` prints `heads/<name>` when a tag shares the branch's name.
- Atomic write pattern: `writeAtomically` (`src/notesStore.ts:183-200`, private) writes a hidden random temp file in the same dir, then renames it. Copy that pattern locally; do not import it from notesStore.
- Git access: the `Git` interface (`src/git.ts:3-9`), where `git.run(args)` resolves stdout and rejects on non-zero exit. Real temp-repo test pattern: `src/notesStore.test.ts:57-67` (`mkdtemp(join(tmpdir(), …))`, `createGit(repoRoot)`, `init -b main`, `user.email`/`user.name`, `commit.gpgsign false`, first commit; `rm` in `afterEach`) and `src/git.test.ts:115`. (`src/model.test.ts` around `:958-1000` stubs Git and is not a real-repo pattern.)
- Design decisions reaching this task (spec `## Design`, "Per-branch diff base"):
  - Contract file: `<common dir>/delta-review/base-<sanitized-branch>.json`, content `{ "version": 1, "branch": "<branch>", "base": "<ref>" }`. Invalid (unparsable, version not exactly `1`, `branch` or `base` not a non-empty string) is treated as absent, with an error string surfaced to the caller. A valid file whose `branch` differs from the (stripped) branch belongs to another branch whose name sanitizes alike: treat it as absent with no error.
  - Branch normalization: every exported function that takes a branch (`baseFileName`, `readBranchBase`, `writeBranchBase`, `clearBranchBase`, `detectBase`, `resolveDiffBase`) first applies `readMarkBranch`. The stripped name is what goes into the file name, the file's `branch` field and its comparison, the reflog ref `refs/heads/<branch>`, the `branch === fallback` guard, candidate exclusion, and `BaseResolution.branch`.
  - Detection (fixed spawn count, independent of the number of local branches and of new commits):
    - One spawn lists candidates with distances: `git for-each-ref --format=%(refname:short) %(objectname) %(ahead-behind:HEAD) refs/heads` (git >= 2.41), in output order, minus the current branch. Each line ends `<ahead> <behind>`: `ahead` = commits in the candidate not in HEAD, `behind` = commits in HEAD not in the candidate. Distance is `behind`.
    - One spawn reads the current branch's reflog: `git reflog show --format=%H %gs refs/heads/<branch> --` (newest first; branch reflogs live in the common dir, so every worktree sees the same one). Derive:
      - `creationRef`: the oldest (last) line's subject matches `branch: Created from <ref>`; strip a leading `refs/heads/`; ignore it when `<ref>` is `HEAD`. (`git checkout -b x`, `git switch -c x` and `git worktree add -b x` with no start point record `Created from HEAD`; `git branch x feat/a` and `git switch -c x feat/a` record `Created from feat/a`.)
      - `unmoved`: the reflog has exactly the creation entry as its newest line and that sha equals HEAD's sha.
      - `ownCommits`: the shas of lines whose subject starts with `commit` (covers `commit:`, `commit (amend):`, `commit (merge):`, `commit (initial):`), `cherry-pick`, `revert` or `rebase`, or starts with `merge` or `pull` and does not contain `Fast-forward`. Exception: a subject matching `/\(finish\): .* onto ([0-9a-f]+)$/` (`rebase (finish): refs/heads/feat/b onto <sha>`, `rebase -i (finish): …`, `pull --rebase (finish): …`) whose line sha equals the captured `onto` sha is excluded: a rebase that replayed nothing fast-forwarded the branch to the new parent's tip, and including it would skip the real parent. Keep `ownCommits` as an insertion-ordered `Set` (newest first).
      - A failed or empty read gives `creationRef` undefined, `unmoved` false, `ownCommits` empty.
    - Skip a candidate when any of these hold:
      - `behind === total`, where `total = rev-list --count HEAD` (no common history)
      - `behind === 0` and not `unmoved` (its tip equals HEAD, or HEAD is its ancestor). This stops `git branch x` / `git worktree add -b x` at the current tip from winning with an empty review, and stops a branch that merged this one. A brand-new (`unmoved`) branch keeps such candidates at distance 0, so it still detects the parent it sits on (its review is empty either way).
      - it is in `containing` and is not named exactly the fallback. `containing` is the set of branch names printed by one spawn, `git for-each-ref --format=%(refname:short) --contains=<c1> --contains=<c2> … refs/heads`, with the first `MAX_CONTAINS_ARGS = 32` entries of `ownCommits` (newest first). Git ORs repeated `--contains`, so this lists every branch holding any own commit: a child forked from this branch (e.g. `main` → `feat/x` (x1, x2) → `feat/y` (y1), then x3 on `feat/x`: on `feat/x`, `feat/y` is at distance 1 but contains x1, so it is skipped and `main` wins), or a branch created at an own commit. The fallback is exempt (it contains own commits once this branch was merged into it, and must stay eligible). Skip the spawn when `ownCommits` is empty (`containing` empty). A failed call gives an empty `containing`. This replaces any "candidate sha in `ownCommits`" rule.
    - The smallest distance wins. A tie goes to the candidate named exactly the fallback, then to the candidate named `creationRef`, otherwise the earlier one keeps it.
    - With no candidate, use the upstream: `rev-parse --abbrev-ref @{upstream}`, used only if it does not end with `/<current branch>` and `merge-base <upstream> HEAD` succeeds.
    - Older git: when the for-each-ref call rejects with a message matching `/ahead-behind/` (unknown field), run `for-each-ref --format=%(refname:short) %(objectname) refs/heads` and per candidate `mb = merge-base <sha> HEAD` (a failure skips it) and `distance = rev-list --count <mb>..HEAD`. `behind === 0` there is `mb === HEAD sha`; no common history is a failed merge-base. Same skip and tie rules.
  - Caching (caller-owned object, like `hashCache` in `computeReviewModel`): `total`, the parsed reflog, `containing` and the upstream merge-base result are cached by a key of for-each-ref output + upstream (or empty) + fallback. The output includes the current branch's own line, so a commit, reset or checkout of the current branch changes the key. The older-git path caches each candidate's `{ mb, distance }` by `candidate sha + HEAD sha`. A steady-state refresh on modern git costs 2 spawns (for-each-ref, `rev-parse @{upstream}`); a key miss adds `rev-list --count HEAD`, the reflog read and (with own commits) the `--contains` for-each-ref, whatever the branch count. Any branch moving or appearing changes the for-each-ref output, so `containing` is never stale.
  - When `branch === fallback`, skip detection: source is `fallback` (unless an explicit file exists). On `main`, a forked or merged feature branch must never be picked as base.
  - `stale` is true iff all of these hold:
    - source is `explicit`, or `detected` with `detectedVia === "forkPoint"` (an upstream-detected base, e.g. `origin/main` while local `main` was skipped, is never stale)
    - branch !== fallback
    - base !== fallback
    - base is a branch (`git show-ref --verify --quiet refs/heads/<base>` or `refs/remotes/<base>` succeeds)
    - `git merge-base --is-ancestor <base> <fallback>` exits 0
    - the base tip is off the fallback's first-parent chain: take the last line of `git log --first-parent --format=%P <base>..<fallback>`; its first field differs from `rev-parse <base>^{commit}`. Empty output (base tip equals the fallback) is not stale. A parent with no commits of its own sits on the fallback's first-parent history, so it is not flagged until it gains commits and is merged with a merge commit. A base fast-forwarded into the fallback is never flagged (accepted, documented in 01_05). Cache the result in `DetectionCache` by `base sha + fallback sha`.
  - `missing` is true iff the source is explicit and `git rev-parse --verify --quiet <base>^{commit}` fails. A missing base is never stale.

## Guides

- plugin/skills/cluster/SKILL.md (doc): the clusters contract file — read before changing cluster generation or its file format
- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- Exports:
  - `baseFileName(branch): string` → `base-<sanitized>.json`
  - `parseBaseFile(text): { ok: true; branch: string; base: string } | { ok: false; error: string }`
  - `readBranchBase(git, branch): Promise<{ state: "missing" } | { state: "invalid"; error } | { state: "ok"; base }>`. A valid file with a different `branch` gives `missing`.
  - `writeBranchBase(git, branch, base): Promise<void>` writes `JSON.stringify({ version: 1, branch, base }, null, 2) + "\n"` (stripped branch) atomically and `mkdir -p`s the dir. It overwrites a file owned by another branch (last writer wins; that branch then reads absent).
  - `clearBranchBase(git, branch): Promise<void>` unlinks the file when it is invalid or its `branch` matches, leaves a file owned by another branch untouched, and ignores ENOENT.
  - `pickDetectedBase(candidates: { name, distance }[], fallback, creationRef?: string): string | undefined` is the pure tie-break rule (candidates already filtered). Unit-test it directly.
  - `parseBranchReflog(output, headSha): { creationRef?: string; unmoved: boolean; ownCommits: Set<string> }` is pure. Unit-test it directly.
  - `isEligibleCandidate(c: { name, ahead, behind }, total, reflog, containing: ReadonlySet<string>, fallback): boolean` is the pure skip rule. Unit-test it directly; the older-git path maps `mb === HEAD sha` to `behind: 0`.
  - `containsArgs(ownCommits): string[]` is pure: `--contains=<sha>` for the first `MAX_CONTAINS_ARGS` (32) entries. Unit-test the cap and order.
  - `detectBase(git, branch, fallback, cache: DetectionCache): Promise<{ forkPoint?: string; upstream?: string; upstreamEligible: boolean }>`. `upstream` is returned even when ineligible, because the picker lists it.
  - `resolveDiffBase(git, branch, fallback, cache): Promise<BaseResolution>` with `BaseResolution = { branch, base, source: "explicit" | "detected" | "fallback", detectedVia?: "forkPoint" | "upstream", fallback, missing, stale, fileError?: string, suggestions: { forkPoint?: string; upstream?: string; fallback: string } }`.
  - `isRefValid(git, ref): Promise<boolean>`, for the picker's input validation later.
- `DetectionCache` is `{ key?: string; total?: number; reflog?: { creationRef?: string; unmoved: boolean; ownCommits: Set<string> }; containing?: Set<string>; upstreamHasBase?: boolean; staleKey?: string; staleOffFirstParent?: boolean; perCandidate: Map<string, { mb: string; distance: number }> }`, a mutable object the caller holds. Export `createDetectionCache(): DetectionCache` (the only constructor callers use; `perCandidate` is required, so `{}` does not type-check) and `resetDetectionCache(cache): void`, which clears every field and the map in place (for repo switches). The per-candidate map is pruned to the current candidate set each call so it never grows.
- Export pure `parseAheadBehindLines(output, currentBranch): { name, sha, ahead, behind }[]` and unit-test it.
- The older-git path may use `Promise.all` over candidates. Keep output order for tie-breaking regardless of completion order.
- Detached HEAD (`branch === "HEAD"`): skip the contract file and detection, and return source fallback.
- `branch === fallback`: read the contract file as usual (an explicit base is honored, never stale), but skip `detectBase` entirely and return source fallback with `base = fallback`.
- Header comment: one short paragraph on why the base is per-branch and stored under the common dir. No `REQ-*` ids.

## Gotchas

- `rev-parse --abbrev-ref @{upstream}` fails when there is no upstream. Treat that as none and don't throw.
- `--contains=<sha>` needs the object: reflog entries keep their commits reachable, so own shas exist. Still treat a rejection as empty `containing`, never as a fatal error.
- `%(refname:short)` can be ambiguous (`heads/x`) when a tag shares the name. Pass the candidate's `objectname` sha to `merge-base` instead of the short name, and keep the short name for display and return value.
- Keep the spawn count fixed: no per-candidate reflog reads or per-candidate `--contains` calls; all own commits go into the one capped `--contains` call. Remaining limitations, accepted and documented in 01_05:
  - Without a reflog (no `ownCommits`), or when every own commit a child holds is older than the 32 newest, a child branch can win (graph-symmetric).
  - A branch created at a commit the current branch only fast-forwarded or reset to is not in `ownCommits`.
  - Candidates at the same commit are told apart only by `creationRef`; otherwise the earlier name wins (the diff is identical).
  - Without a reflog, a brand-new branch is not `unmoved`, so it skips the parent it sits on and picks a farther ancestor until its first commit.
- The reflog's subject for `git branch -m` renames is `Branch: renamed …`, which is not a creation entry; treat it as no `creationRef`.
- Do not import `vscode`.
- `%(ahead-behind:HEAD)` needs a commit HEAD; detached HEAD and an unborn branch never reach detection (detached is skipped; an unborn HEAD makes for-each-ref fail, which detection treats as no candidates).
- The current branch is identified by name (the `branch` argument after `readMarkBranch`), not by `%(HEAD)`. Strip before the reflog read too: `refs/heads/heads/feat/a` does not exist, and the read would silently give no reflog.

## Verification

- Write `src/diffBase.test.ts`:
  - `parseBaseFile` accepts the valid shape and rejects bad JSON, version 2, empty base, a non-string base, and a missing or empty `branch`.
  - Write, read and clear round-trip in a temp repo, including a linked worktree (`git worktree add`) reading the same file.
  - Collision: `writeBranchBase(git, "feat/x", "main")` then `readBranchBase(git, "feat-x")` gives `missing`, `resolveDiffBase` for `feat-x` has no `fileError` and is not explicit, and `clearBranchBase(git, "feat-x")` leaves the file in place; `readBranchBase(git, "feat/x")` still gives `ok`.
  - `heads/` prefix: `resolveDiffBase(git, "heads/main", "main", cache)` gives source `fallback` with `branch === "main"`; on `feat/b` (forked from `feat/a`, with a tag `feat/b` on its tip), `resolveDiffBase(git, "heads/feat/b", …)` detects `feat/a` exactly like `"feat/b"` (the reflog is read from `refs/heads/feat/b`, so `creationRef` is set), and `writeBranchBase(git, "heads/feat/b", …)` writes `base-feat-b.json` with `branch: "feat/b"`.
  - `pickDetectedBase` covers smallest distance, a tie going to the fallback, a tie between non-fallbacks going to `creationRef`, and otherwise to the earlier one.
  - `parseBranchReflog` covers `Created from feat/a`, `Created from refs/heads/feat/a`, `Created from HEAD` (no creationRef), `unmoved` true for a lone creation entry at HEAD and false once a `commit:` line is newer, `ownCommits` including `commit`, `commit (amend)`, `cherry-pick`, `rebase (finish)` and `merge feat/x: Merge made by the 'ort' strategy.` lines and excluding `merge feat/x: Fast-forward`, `reset: moving to …` and the creation line, and empty output. Fast-forward rebase: `<S> rebase (finish): refs/heads/feat/b onto <S>` and `<S> pull --rebase (finish): refs/heads/feat/b onto <S>` are excluded, while `<T> rebase (finish): refs/heads/feat/b onto <S>` (T ≠ S) is included. `ownCommits` iterates newest first.
  - `isEligibleCandidate` covers no common history, same tip on a moved branch (skip), same tip and descendant on an `unmoved` branch (eligible), a name in `containing` (skip), and the fallback in `containing` (eligible).
  - `containsArgs` with 40 shas returns the first 32 as `--contains=<sha>`, in order; with none, `[]`.
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
    - same-tip regression: on `feat/b` (forked from `feat/a`, one commit of its own), `git branch x` then detection still yields `feat/a`, not `x`; same with `git worktree add -b y <dir>` from `feat/b`
    - child regression: on `feat/b` (one commit), `git branch x`, then one more commit on `feat/b`: detection yields `feat/a`, not `x` (`x` is an ancestor at distance 1 and contains an own commit)
    - stacked-child regression: `main` → `feat/x` (x1, x2) → `feat/y` (y1, made on `feat/y`), then x3 on `feat/x`: on `feat/x`, detection yields `main`, not `feat/y`; on `feat/y`, it yields `feat/x`
    - fast-forward rebase regression: `feat/a` from `main` with a commit; `feat/b` from `main` with no commits (`git branch feat/b main`), then on `feat/b` `git rebase feat/a` (fast-forwards; reflog `rebase (finish): refs/heads/feat/b onto <feat/a tip>`), then one commit on `feat/b`: detection yields `feat/a`
    - a merged-into-fallback branch: `feat/b` merged `--no-ff` into `main`, then more commits on `feat/b`: `main` contains own commits but stays eligible and wins
    - brand-new branch: `git checkout -b feat/c` from `feat/a`'s tip (reflog `Created from HEAD`, no commits) detects `feat/a`; `git branch feat/d feat/a && git checkout feat/d` detects `feat/a` even when another branch `z` sits at the same commit and sorts earlier (`creationRef` tie-break)
    - explicit base `feat/e` where `feat/e` was created from `main` and has no commits of its own, with `main` advanced past it by another commit: `stale: false`; after `feat/e` gets a commit and is merged `--no-ff` into `main`: `stale: true`
    - on the fallback branch (`main`) with a forked `feat/a` and a merged `feat/b`, source is `fallback`, `base === "main"`, `stale: false`
    - on the fallback branch with an explicit base merged into it, `stale: false`
    - upstream detection where the upstream (`origin/main`) is an ancestor of local `main` gives `detectedVia: "upstream"` and `stale: false`
    - a second call with an unchanged repo reuses the cache (assert by counting `git.run` calls through a wrapping Git)
    - with 5 local branches, a new commit on HEAD followed by a second call adds no per-branch spawns: the call count is the same as with 1 branch (counting wrapper), exactly one for-each-ref call carries `--contains`, and an unchanged repo's second call runs only for-each-ref and `rev-parse @{upstream}` among detection spawns
    - the older-git path (a wrapping Git that rejects any for-each-ref containing `ahead-behind` with `fatal: unknown field name: ahead-behind`) returns the same detections as the modern path for the fork-point, merged-parent, descendant, same-tip, child and stacked-child regression scenarios (the `--contains` call is the same on both paths)
  - `parseAheadBehindLines` parses names containing `/`, drops the current branch, and keeps output order.
- Run `yarn test`, `yarn lint`, `yarn build`.
