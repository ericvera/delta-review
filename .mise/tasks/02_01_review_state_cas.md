# 02_01 Compare-and-set review-state writes

## Goal

Make writes to `refs/review/<branch>` and `refs/review-predeletion/<branch>` compare-and-set, so a concurrent writer (another VS Code window or worktree on the same branch) cannot silently drop a mark. Retry the whole read-modify-write on conflict. After the retries fail, throw a distinguishable conflict error that says whether the ref moved or stayed locked.

## Files to modify/create

- src/reviewState.ts (tests: src/reviewState.test.ts)

## Background

- `src/reviewState.ts`:
  - `readSnapshotTree` (`:25-35`) reads the tree via `ls-tree`.
  - `writeSnapshotTree` (`:40-87`) builds a temp index, `write-tree`, reads the parent with `rev-parse --verify --quiet <ref>`, runs `commit-tree`, then does an unconditional `update-ref <ref> <commit>` at `:83`. That is the lost-update window: read at the start of a mutation, write at the end.
  - Public mutations: `markReviewed` (`:121-170`, which may write predeletion then review), `unmarkReviewed` (`:172-191`, review then predeletion), `clearAllReviewSnapshots` (`:198-210`). `writeReviewState` is also exported (`:100-104`). Check its callers with `grep -rn writeReviewState src`.
- In-window writes are already serialized by `createSerialQueue` (`src/serialQueue.ts`), so this task is about cross-process safety only.
- Verified git behavior:
  - `git update-ref <ref> <new> <old>` fails with `cannot lock ref '<ref>': is at X but expected Y` when the ref moved.
  - `git update-ref <ref> <new> ""` fails with `reference already exists` when the ref exists.
  - Both exit 128.
  - A concurrent writer holding `<ref>.lock` makes update-ref fail with `cannot lock ref '<ref>': Unable to create '<path>.lock': File exists.` (exit 128) while the ref may still equal `expectedOld`. That is contention, not a hard failure.
  - `git.run` rejections carry git's stderr in the error message (`src/git.ts:11-14`).
- Existing tests in `src/reviewState.test.ts` use a recording Git stub (`setUp`, `:27+`) that asserts exact call sequences. Those expectations will need the extra `update-ref` argument. Real temp-repo pattern for the cross-process test: `src/notesStore.test.ts:57-67` (`mkdtemp` under `tmpdir()`, `createGit(repoRoot)`, `init -b main`, user config, `commit.gpgsign false`, first commit) and `src/git.test.ts:115`. (`src/model.test.ts` around `:958-1000` stubs Git; it is not a real repo.)

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- New private `readSnapshotWithCommit(git, ref): Promise<{ state: Map; commit: string | undefined }>`: `rev-parse --verify --quiet <ref>` first (undefined when it fails or prints nothing), then `ls-tree -r -z <commit>` (not `<ref>`), so the tree and the expected-old value are consistent. `readSnapshotTree` (and the exported `readReviewState` / `readPreDeletionState`, which other modules call) keep returning the bare `Map` by delegating to it.
- `writeSnapshotTree(git, ref, state, expectedOld: string | undefined)`:
  - Use `expectedOld` as the `commit-tree` parent instead of re-reading it. Delete the `rev-parse` parent lookup (`:63-73`).
  - Run `update-ref ref commit (expectedOld ?? "")`.
  - On failure: if the message matches `/cannot lock ref .*Unable to create '([^']+\.lock)'.*File exists/s`, throw `new ReviewStateConflictError(ref, "locked", lockPath)`. Otherwise re-read the ref; if it differs from `expectedOld`, throw `new ReviewStateConflictError(ref, "moved")`. Otherwise rethrow the original error.
  - `ReviewStateConflictError` is exported: `name = "ReviewStateConflictError"`, `readonly ref`, `readonly kind: "moved" | "locked"`, `readonly lockPath?: string`. Message: `moved` → `<ref> changed while it was being written`; `locked` → `<ref> is locked (<lockPath>)`.
- The CAS value is the commit the mutation read at its start. Each public mutation reads with `readSnapshotWithCommit` and passes that `commit` straight to `writeSnapshotTree` for the same ref:
  - `markReviewed` (`:121-170`): read review and predeletion with commits; write predeletion with its read commit, then review with its read commit. Replace the `writeReviewState(git, branch, state)` call at `:169` with `writeSnapshotTree(git, reviewRefForBranch(branch), state, reviewCommit)`.
  - `unmarkReviewed` (`:172-191`): same at `:181` (review) and for predeletion (read commit from its own read at `:183`).
  - `clearAllReviewSnapshots` (`:198-210`): same at `:205` and `:208`.
  - Nothing may re-read a ref between the mutation's read and its write; that re-read is exactly the lost-update window.
- `withConflictRetry<T>(fn, { attempts = 3, delays = [50, 200], sleep })` runs the whole mutation again on a `ReviewStateConflictError`, sleeping `delays[i]` ms before retry `i + 1`, and rethrows the last conflict after the final attempt. `sleep` defaults to a `setTimeout` promise; tests pass `async () => {}`. Each public mutation body runs inside it, so each attempt re-reads both refs. The public mutations take an optional trailing `options?: { sleep? }` for tests; existing callers are unchanged.
- `writeReviewState(git, branch, state)` keeps its signature for any external caller. It reads the current commit inside and CASes against it (a lone write has no earlier read to protect). No public mutation calls it anymore.
- Keep the existing comments' rationale (pre-deletion written first, and so on) and update them only where the mechanism changed.

## Gotchas

- `markReviewed` writes two refs. A conflict on the second write after the first succeeded is safe to retry: the retry re-reads predeletion, finds its entry already present, and leaves it unchanged. Keep the "pre-deletion first" order.
- `hash-object -w` blobs written by a failed attempt are harmless loose objects. Don't try to clean them up.
- An empty-string old value must be passed as a real empty argument (`""` in the args array), not omitted.
- SHA-256 repos: don't hardcode a 40-zero oid. The empty-string form avoids that.
- A stale `<ref>.lock` left by a crashed git process fails every attempt with the "File exists" message. That is why the lock case is its own `kind` and its message names the lock file instead of claiming another window wrote. Check the lock pattern before re-reading the ref.

## Verification

- Update the stub-based tests in `src/reviewState.test.ts` for the new `update-ref` arity and the commit-first read.
- Add a temp-repo test with a real `createGit`: start `markReviewed(a)`, and inject a concurrent write after the mutation's `ls-tree` and before its write by wrapping `git.run` so the first `hash-object` call first runs a separate, unwrapped `markReviewed(b)` on the real repo. Expect both `a` and `b` present in `refs/review/<branch>` afterwards, and the ref history to show the retry. This test must fail against an implementation that re-reads the ref inside the write (as `writeReviewState` does): confirm by temporarily pointing `markReviewed` at `writeReviewState` and seeing `b` dropped, then revert.
- The same injection for `unmarkReviewed` (inject at `write-tree`, since unmark hashes nothing) keeps the concurrent `b` mark while dropping the unmarked path.
- A test where every attempt conflicts (a wrapper moves the ref before each `update-ref`) rejects with `ReviewStateConflictError` of `kind: "moved"` after 3 attempts.
- A stub test where the first `update-ref` rejects with `cannot lock ref 'refs/review/x': Unable to create '/r/.git/refs/review/x.lock': File exists.` while the ref is unchanged, and the second succeeds: the mutation retries and resolves.
- A temp-repo test with a pre-created stale `.git/refs/review/<branch>.lock`: `markReviewed` rejects with `kind: "locked"`, `lockPath` ending in `<branch>.lock`, after 3 attempts (`sleep` stubbed), and `refs/review/<branch>` is unchanged.
- A test where `update-ref` fails for a non-conflict reason (the stub rejects while the ref is unchanged) rethrows the original error unchanged.
- Run `yarn test`, `yarn lint`, `yarn build`.
