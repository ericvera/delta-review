# 02_02 Refresh scheduler: max wait, ignore own ref writes

## Goal

Stop the extension's own review-ref writes from restarting the refresh debounce and triggering a superseding second refresh. Give the debounce a max wait so a stream of events cannot postpone a refresh indefinitely.

## Files to modify/create

- src/refreshScheduler.ts (new; test: src/refreshScheduler.test.ts)
- src/extension.ts
- src/gitExtensionApi.ts

## Background

- Line numbers below are from before tasks 01_02 to 01_04 edited `src/extension.ts`. Locate by symbol.
- `scheduleRefresh` (`src/extension.ts:828-834`) is a 400 ms trailing debounce with no max wait. Every event resets it. It is called from:
  - the repo watcher `watchRepo` (`:846-856`, `**/*` under the repo root, which includes `.git/refs/review/...` in a main worktree)
  - the contract-dir watcher `watchContractDir` (`:864-894`)
  - git `repository.state.onDidChange` (`:2258-2262`)
  - save (`:2146`), window focus (`:2160-2163`) and configuration change (`:2165-2169`)
- Investigation (goals.md "Investigation (added scope 2)"): a mark's `update-ref` fires the watcher and git `state.onDidChange` → `scheduleRefresh`. That refresh bumps `refreshGeneration` (`:406`), so the command's own refresh bails at its generation checks and publishes nothing. Visible latency becomes git status + 400 ms + a second full refresh.
- `GitRepository` typing (`src/gitExtensionApi.ts:8-18`) exposes only `rootUri`, `ui` and `state.onDidChange`. The real vscode.git API also has `state.HEAD?: { name?: string; commit?: string }`.
- Design decision (spec "Responsiveness"):
  - Self-write filtering drops repo-watcher events whose path, after a `.git` segment, starts with `refs/review` or `logs/refs/review`, including `.lock` files.
  - Git state events schedule a refresh only when HEAD name or commit changed for the active repo.
  - Accepted trade-off: another window's mark appears on next focus, save or HEAD change.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `src/refreshScheduler.ts` (no vscode):
  - `createRefreshScheduler({ delayMs, maxWaitMs, run, timers = { setTimeout, clearTimeout, now: Date.now } })` returns `{ schedule(): void; cancel(): void }`.
    - `schedule` (re)arms a trailing timer of `delayMs`, capped so it fires no later than `firstPendingAt + maxWaitMs`.
    - After firing, the next `schedule` starts a new window.
    - `run` is fire-and-forget (`void run()`).
  - `isSelfWriteEventPath(fsPath: string): boolean`. Normalize `\` to `/`. Return true when the path contains `/.git/` and the remainder starts with `refs/review` or `logs/refs/review`. This covers `refs/review/`, `refs/review-notes/`, `refs/review-slices/`, `refs/review-predeletion/` and their `.lock` siblings.
  - `headFingerprint(head: { name?: string; commit?: string } | undefined): string` → `${name ?? ""}\0${commit ?? ""}`.
- `src/gitExtensionApi.ts`: add `readonly HEAD?: { readonly name?: string; readonly commit?: string }` to `state`.
- `src/extension.ts`:
  - Replace `refreshTimer`/`scheduleRefresh` with `const refreshScheduler = createRefreshScheduler({ delayMs: 400, maxWaitMs: 1500, run: refresh })` and `const scheduleRefresh = () => refreshScheduler.schedule()`, so existing call sites keep working. Cancel it in a `context.subscriptions` disposable.
  - In `watchRepo`, wrap the handlers: `(uri) => { if (!isSelfWriteEventPath(uri.fsPath)) scheduleRefresh(); }`.
  - In `trackRepository`, keep `lastHead = new Map<GitRepository, string>()`. On `state.onDidChange` for the active repo, compute the fingerprint. Schedule only when it differs from the stored one, then store it. Initialize the stored value when the repository is tracked.

## Gotchas

- The contract-dir watcher watches `<common dir>/delta-review/{*.json,*.md,…}`. Leave it unfiltered: agent writes to responses, clusters and base files must still refresh.
- Don't filter `.git/HEAD` or `refs/heads`. Branch switches and commits in the main worktree must still refresh via the repo watcher.
- With HEAD-only fingerprinting, `git fetch` updating remote refs no longer refreshes via git events. A remote-branch base then updates on next focus or save. Accepted; mention it in the scheduler header comment.
- `maxWaitMs` must be measured from the first unserved `schedule()`, not from the last fire.

## Verification

- `src/refreshScheduler.test.ts`, with fake timers (`vi.useFakeTimers()`) or injected timers:
  - a single schedule fires once after `delayMs`
  - repeated schedules every 100 ms fire at `maxWaitMs`, not later
  - a schedule after a fire starts a new window
  - cancel prevents firing
  - `isSelfWriteEventPath` is true for `.git/refs/review/feat/x`, `.git/refs/review-notes/x.lock`, `.git/logs/refs/review/x` and a Windows-style path, and false for `.git/HEAD`, `.git/refs/heads/main`, `src/refs/review.ts`, and `.git/delta-review/notes-x.json`
  - `headFingerprint` differs on name or commit change
- Run `yarn test`, `yarn lint`, `yarn build`.
- Scripted extension-host check (batch with 02_03's): in a temp repo, run `executeCommand("deltaReview.markFileReviewed", { kind: "file", file: (await executeCommand("deltaReview.__inspect")).files[0] })`. Wait until the next published model. Record how many times `refresh` published by adding a `publishCount` counter to `__inspect`. It increments in `refresh()` only, right beside its `treeProvider.setModel(model)` call (02_03 later moves that call into `publishModel` and keeps the increment in `refresh()`, outside `publishModel`, so optimistic publishes never count). Let the run settle 3 s after the mark. The count must rise by exactly one per mark, not two.
