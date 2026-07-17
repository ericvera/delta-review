# Progress

## 1.1 — Pure parser for `git diff --name-status --find-renames -z` output

- Key changes: `src/git.ts` adds exported `parseNameStatusOutput(output)` returning `{ paths, movedFrom }` (rename sources excluded from paths; `movedFrom` maps destination → source for `R` records only, `C` destinations included in paths but not treated as moves); new colocated `src/git.test.ts` with 8 test cases covering A/M/D, R100/R087, C075, spaces in paths, empty output, truncated tails, and unknown statuses.
- Deviations from plan: none. Field layout sanity-checked against real git output (`M\0b.txt\0R100\0a.txt\0renamed.txt\0`).
