# 02_01 Compare-and-set review-state writes

## Goal

Make writes to `refs/review/<branch>` and `refs/review-predeletion/<branch>` compare-and-set, so a concurrent writer (another VS Code window or worktree on the same branch) cannot silently drop a mark. Retry the whole read-modify-write on conflict. After the retries fail, throw a distinguishable conflict error.

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
- Existing tests in `src/reviewState.test.ts` use a recording Git stub (`setUp`, `:27+`) that asserts exact call sequences. Those expectations will need the extra `update-ref` argument. Temp-repo pattern for the cross-process test: `src/model.test.ts:959`.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `readSnapshotTree` also returns the ref's commit: `{ state: Map, commit: string | undefined }`, via `rev-parse --verify --quiet <ref>`, with undefined when it fails or is empty. Read the commit first, then `ls-tree <commit>` (not `<ref>`), so the tree and the expected-old value are consistent.
- `writeSnapshotTree(git, ref, state, expectedOld: string | undefined)`:
  - Use `expectedOld` as the `commit-tree` parent instead of re-reading it.
  - Run `update-ref ref commit (expectedOld ?? "")`.
  - On failure, re-read the ref. If it differs from `expectedOld`, or the error message matches `/cannot lock ref .*File exists/s`, throw `new ReviewStateConflictError(ref)` (exported class, `name = "ReviewStateConflictError"`). Otherwise rethrow the original error.
- `withConflictRetry<T>(fn, attempts = 3)` runs the whole mutation again on a `ReviewStateConflictError` and rethrows after the last attempt. Each public mutation body runs inside it: it re-reads both refs on each attempt.
- `writeReviewState(git, branch, state)` keeps its signature for any external caller. Read the current commit inside it and CAS against it (a lone write has no earlier read to protect).
- Keep the existing comments' rationale (pre-deletion written first, and so on) and update them only where the mechanism changed.

## Gotchas

- `markReviewed` writes two refs. A conflict on the second write after the first succeeded is safe to retry: the retry re-reads predeletion, finds its entry already present, and leaves it unchanged. Keep the "pre-deletion first" order.
- `hash-object -w` blobs written by a failed attempt are harmless loose objects. Don't try to clean them up.
- An empty-string old value must be passed as a real empty argument (`""` in the args array), not omitted.
- SHA-256 repos: don't hardcode a 40-zero oid. The empty-string form avoids that.

## Verification

- Update the stub-based tests in `src/reviewState.test.ts` for the new `update-ref` arity and the commit-first read.
- Add a temp-repo test with a real `createGit`: start `markReviewed(a)`, and inject a concurrent write between its read and its update-ref by wrapping `git.run` so the first `update-ref` call first runs a separate `markReviewed(b)` on the real repo. Expect both `a` and `b` present in `refs/review/<branch>` afterwards, and the ref history to show the retry.
- A test where every attempt conflicts (a wrapper always moves the ref before `update-ref`) rejects with `ReviewStateConflictError` after 3 attempts.
- A stub test where the first `update-ref` rejects with `cannot lock ref 'refs/review/x': Unable to create '/r/.git/refs/review/x.lock': File exists.` while the ref is unchanged, and the second succeeds: the mutation retries and resolves.
- A test where `update-ref` fails for a non-conflict reason (the stub rejects while the ref is unchanged) rethrows the original error unchanged.
- Run `yarn test`, `yarn lint`, `yarn build`.
