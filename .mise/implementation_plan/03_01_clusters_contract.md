# Task 3.1: Clusters contract — locate, parse, validate, resolve membership (pure core)

## Goal

A new `src/clusters.ts` module that finds and reads `.git/delta-review/clusters-<branch>.json`, validates it (version 1, well-formed clusters), and resolves the review set into a `ClusterModel`: ordered clusters with their member files, an Unclustered bucket, and the Auto bucket. All decision logic is pure and Vitest-tested; no UI in this task.

## Requirements addressed

REQ-CONTRACT-1, REQ-CONTRACT-2, REQ-CONTRACT-6, REQ-CLUS-3, REQ-CLUS-8 (data side), REQ-AUTO-3 (auto-wins rule).

## Background

Feature 1: a Claude Code skill writes a contract JSON describing logical clusters of the current change; the extension is purely a renderer of that file. Contract path: `<git common dir>/delta-review/clusters-<sanitized-branch>.json` — inside `.git` so it never touches the working tree (the extension's zero-footprint principle; review state similarly lives in `refs/review/<branch>`). The extension never writes contract files.

Contract shape (version 1):

```json
{
  "version": 1,
  "clusters": [
    { "label": "Rename fetchUser → getUser", "summary": "Mechanical rename across call sites", "files": ["src/api.ts"], "patterns": ["**/*.test.ts"] }
  ]
}
```

Each cluster needs `label` (string), `summary` (string), and at least one of `files` (string array) / `patterns` (string array). Membership rules: explicit `files` beat `patterns`; a file listed by several clusters belongs to the first; patterns evaluate in cluster order; auto-triaged files (Task 1.2's `ReviewFile.triage === 'auto'`) go to the Auto bucket regardless of cluster membership or unclustered status (**auto wins over everything**); remaining unmatched files go to Unclustered. Files named by the contract but absent from the review set are simply not shown (a cluster can end up empty → REQ-CLUS-8). Glob matching uses picomatch (bundled since Task 1.1), same as `src/triage.ts` (Task 1.2) — repo-relative `/`-separated paths, `dot: true`.

Existing infrastructure: `Git.run` (`src/git.ts:13`) executes git in the repo root. `computeReviewModel` (`src/model.ts:35`) produces `ReviewModel { branch, mergeBase, files: ReviewFile[] }`. Vitest cannot import `vscode` — `clusters.ts` must stay vscode-free (use `node:fs/promises` + `Git` for I/O, like `model.ts` does).

## Files to modify/create

- `src/clusters.ts` (new) — types + pure functions + loader:
  - `sanitizeBranchForFilename(branch)` — every char outside `[A-Za-z0-9._-]` → `-`.
  - `parseClustersContract(text)` — JSON parse + validation → `{ ok: true, contract } | { ok: false, error: string }` where `error` is user-facing (e.g. `unsupported version 3 (extension supports 1)`).
  - `resolveClusterModel(contract, files: ReviewFile[])` — pure membership resolution → `ClusterModel { clusters: Array<{ label, summary, files: ReviewFile[] }>, unclustered: ReviewFile[], auto: ReviewFile[] }` (clusters in contract order, possibly empty).
  - `loadClustersContract(git, branch)` — resolve the common dir (`git rev-parse --git-common-dir`, absolute-ify against `git.repoRoot` when relative), read the file, run `parseClustersContract` → `{ state: 'missing' } | { state: 'invalid', error } | { state: 'ok', contract }`.
- `src/clusters.test.ts` (new) — Vitest tests for the pure functions.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Validation specifics: top-level object; `version` must be exactly the integer 1 (`unsupported version` error names the found value); `clusters` must be an array; each entry needs string `label`/`summary` and at least one non-empty array of strings among `files`/`patterns`. Any violation → `invalid` with a one-line reason. Extra unknown keys are ignored (forward-friendly within v1).
2. Membership algorithm (single pass, deterministic): build `explicit: Map<path, clusterIndex>` from all clusters' `files` (first listing wins); precompile each cluster's patterns with picomatch. For each `ReviewFile`: `triage === 'auto'` → auto bucket; else explicit map hit → that cluster; else first cluster (contract order) whose patterns match → that cluster; else unclustered. Preserve `model.files`' existing path-sorted order within each bucket.
3. `ENOENT` → `missing`; any other read error → `invalid` with the error message.
4. Unit tests: sanitization (`feature/foo` → `feature-foo`, unicode/space handling); version rejection (0, 2, "1", absent); malformed clusters (missing label, empty files+patterns, non-array); explicit-beats-pattern; first-cluster-wins for duplicate explicit listings; pattern order across clusters; auto-wins over explicit membership and over unclustered; empty clusters array → everything unclustered/auto; contract referencing unknown files → those ignored, cluster may be empty.

## Testing suggestions

- `yarn test` — the new suite is the primary verification (pure logic, no vscode).
- Manual: hand-write a contract file in a test repo (`mkdir -p .git/delta-review && cat > .git/delta-review/clusters-<branch>.json`), then in a node REPL or a scratch Vitest case run `loadClustersContract` against it.
- Test exception applies (no e2e infrastructure): unit tests are the verification for this task; UI verification happens in Tasks 3.2/3.3.

## Gotchas

- `git rev-parse --git-common-dir` returns a *relative* path (`.git`) when cwd is the main worktree — always resolve against `git.repoRoot`. In linked worktrees it returns the shared dir; using it (not `--git-dir`) is what makes the contract travel with the branch across worktrees, matching where review refs live.
- Branch names can contain `/` (`feature/x`) — the sanitizer is not optional, and SKILL.md (Task 4.1) must document the identical rule.
- Don't cache the contract in module state; the loader is called per refresh (Task 3.2) and caching would fight the file watcher.
- Keep `ReviewFile` objects by reference in the buckets (no copies) so the tree provider's downstream identity assumptions hold.

## Verification checklist

- [ ] `yarn test` green with the new suite covering all rules in Implementation details step 4
- [ ] `yarn build`/`lint` green; `clusters.ts` imports no `vscode`
- [ ] Manual loader check against a hand-written contract file (ok / invalid / missing all exercised)
- [ ] End-to-end: Test exception (no e2e infra) — unit tests per above
