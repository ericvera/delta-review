# Progress

## 1.1 — Pure parser for `git diff --name-status --find-renames -z` output

- Key changes: `src/git.ts` adds exported `parseNameStatusOutput(output)` returning `{ paths, movedFrom }` (rename sources excluded from paths; `movedFrom` maps destination → source for `R` records only, `C` destinations included in paths but not treated as moves); new colocated `src/git.test.ts` with 8 test cases covering A/M/D, R100/R087, C075, spaces in paths, empty output, truncated tails, and unknown statuses.
- Deviations from plan: none. Field layout sanity-checked against real git output (`M\0b.txt\0R100\0a.txt\0renamed.txt\0`).

## 1.2 — Rename detection wired into `computeReviewModel`

- Key changes: `src/model.ts` — tracked-changes command switched to `git diff --name-status --find-renames -z` parsed via `parseNameStatusOutput`; `ReviewFile` gains required `movedFrom: string | undefined`; merge-base branch of `diffBaseSha` now resolves via `baseBlobs.get(movedFromByPath.get(path) ?? path)` (snapshot branch untouched). `src/clusters.test.ts` fixture literal gains `movedFrom: undefined`.
- Deviations from plan: none. No new pure helpers extracted, so `src/model.test.ts` unchanged. Live check done headlessly against a real scratch git repo (with `diff.renames=false` set to prove explicit `--find-renames` wins): pure move yields one row at the new path, no old-path row, `movedFrom` set, diff base = old path's merge-base blob (empty diff); move+edit keeps old blob as base; plain edits unaffected. Dev-host visual pass deferred to Task 2.2's full manual pass (badge intentionally still `A` until Task 2.1).
