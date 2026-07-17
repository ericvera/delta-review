# Task 1.1: Pure parser for `git diff --name-status --find-renames -z` output

## Goal

Add a pure, unit-tested function `parseNameStatusOutput` that turns `git diff --name-status -z` output into the review set's path list plus a new-path → old-path move map. No callers change in this task.

## Requirements addressed

REQ-DET-1, REQ-DET-3, REQ-DET-4

## Background

Delta Review is a VS Code extension showing files changed between a branch's merge base and the working tree. The feature being built: files git detects as renamed/moved should render as a single row at the new path (with the old path attached), instead of today's unrelated deleted + added rows. Today's detection (`src/model.ts:97-103`) runs `git diff --name-only --no-renames -z <mergeBase>` and gets bare paths. Task 1.2 will switch that call to `--name-status --find-renames` and needs a parser for the richer output — that parser is this task.

Existing NUL-output parsers live in `src/git.ts`: `splitNulTerminated` (line 42) and `parseLsTreeOutput` (line 46). Follow their style: exported, pure, documented with a comment stating the input format. `src/git.ts` imports nothing from `vscode`, which is what makes it unit-testable — the project's Vitest setup cannot load the `vscode` module.

### Output format to parse

With `-z`, every field is NUL-terminated:

- Single-path records: `<STATUS>\0<path>\0` where STATUS is one letter (`A`, `M`, `D`, `T`, `U`, `X`, `B`).
- Two-path records: `<STATUS><score>\0<sourcePath>\0<destinationPath>\0` where STATUS is `R` (rename) or `C` (copy) and score is a 0-padded similarity like `100` or `087`. Only `R` will occur (we pass `--find-renames`, never `--find-copies`), but `C` must be handled defensively.

## Files to modify/create

- `src/git.ts` — add `parseNameStatusOutput`
- `src/git.test.ts` — new colocated test file (none exists yet for git.ts)

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. In `src/git.ts`, add an exported pure function `parseNameStatusOutput(output: string)` returning `{ paths: string[]; movedFrom: Map<string, string> }`:
   - `paths`: every path that should get a review row — single-path record paths, plus the **destination** path of each `R`/`C` record. Rename **source** paths are excluded (that is what removes the old-path row).
   - `movedFrom`: destination path → source path, for `R` records only. A `C` record's destination goes into `paths` but not into `movedFrom` (a copy's source still exists; treating it as a move would wrongly suppress a real file).
2. Split on NUL like `splitNulTerminated` does, then walk the fields as a cursor: read a status field, decide by its first character whether one or two path fields follow (`R`/`C` → two), and consume accordingly. Ignore a trailing empty field from the final NUL.
3. Malformed tails (status field with no following path — shouldn't happen, but the parser must not throw) end parsing silently, mirroring the tolerant style of `parseLsTreeOutput` (which skips entries without a tab).
4. Document the record format in a comment above the function, as `parseLsTreeOutput` and `parseCheckAttrOutput` (`src/model.ts:35-39`) do.

## Testing suggestions

- New `src/git.test.ts`, modeled on `src/model.test.ts` (builds NUL fixtures with a small helper, single `describe`). Cases:
  - mixed `A`/`M`/`D` records → all paths in `paths`, empty `movedFrom`;
  - `R100` pure rename → destination in `paths`, source absent, `movedFrom` maps dst → src;
  - `R087` rename-with-edits → same shape (score digits vary);
  - `C075` copy record → destination in `paths`, `movedFrom` empty;
  - paths containing spaces (NUL splitting must not care);
  - empty output → empty result;
  - truncated tail (dangling status field) → parses the records before it, no throw.
- Sanity-check the format against real git once: in any repo, `git mv` a file, edit another, then `git diff --name-status --find-renames -z HEAD | xxd | head` and confirm the field layout matches the tests.

## Gotchas

- The score suffix means you must match on `status[0]`, not the whole status string (`R100` !== `R`).
- Unmerged (`U`) and unknown statuses are single-path — the cursor walk must default to one path so an unexpected status doesn't desync the whole parse.
- Do not sort or dedupe inside the parser — `computeReviewModel` owns that (it also merges untracked paths).

## Verification checklist

- [ ] `yarn test` passes with the new `src/git.test.ts` cases
- [ ] `yarn lint` and `yarn build` pass
- [ ] End-to-end tests: none for this task — pure parsing logic fully covered by unit tests; extension-host behavior is exercised in Task 2.2's manual pass (config Test exception: no e2e infrastructure exists)
