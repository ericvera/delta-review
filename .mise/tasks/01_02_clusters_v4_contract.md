# 01_02 Clusters contract version 4

## Goal

The clusters contract parser accepts version 4, which adds a per-file review level map (`levels`) and line-range agent notes inside `notes`; both reach each `ReviewFile`. No rendering yet.

## Files to modify/create

- `src/clusters.ts`
- `src/model.ts`
- `src/extension.ts`
- `plugin/skills/cluster/SKILL.md`
- `DEVELOPMENT.md`

## Background

- Contract parser: `parseClustersContract` (`src/clusters.ts:409-504`); version check `isContractVersion` (`:231-234`) and messages at `:424-435`; moves parsing passes `version === 3` as `allowsExtraction` (`:456`); notes parsed only at `version === 3` (`:469-491`), values must be strings (`:482-483`). `LineRange` type at `:27`; `isInteger` at `:243`.
- Per-file data reaches rows the way `fileNote` does: contract `notes` → `computeReviewModel` option `notes` (`src/model.ts:575`) → `ReviewFile.fileNote` (`src/model.ts:93`, set at `:777`). `src/extension.ts:417-433` and `:461-468` pass `notes` to both `computeReviewModel` calls.
- Task 01_01 already reorders cluster buckets; untouched here.
- Design decisions:
  - Version 4 contract; accepted versions 1-4; error text ends `(extension supports 1, 2, 3 and 4)` (both the missing and unsupported messages).
  - `levels` (version 4 only, optional): object path → `"review" | "skim"`. Non-object → `"levels" must be an object`; other value → `levels["<path>"] must be "review" or "skim"`. Ignored (unvalidated) below 4.
  - `notes` at version 4: value is a string (file-level, as v3) or an array of items; an item is a string (file-level) or an object `{ "text": string, "lines": [start, end] }` with integers `1 <= start <= end`. File-level strings for one path join with one space into the existing `notes` map entry; empty strings and empty-`text` items are dropped. Error messages: `notes["<p>"] must be a string or an array`, `notes["<p>"][<i>] must be a string or an object with "text" and "lines"`, `notes["<p>"][<i>]: "lines" must be a [start, end] pair of integers with 1 <= start <= end`. Version 3 keeps the string-only rule and message.
  - Types in `src/clusters.ts`: `export type ReviewLevel = "review" | "skim"`, `export interface LineNote { lines: LineRange; text: string }`. `ClustersContract.version` becomes `1 | 2 | 3 | 4`; it gains `levels: Map<string, ReviewLevel>` and `lineNotes: Map<string, LineNote[]>`, always present (empty below 4).
  - `ReviewFile` gains `reviewLevel: ReviewLevel` (default `"review"`) and `lineNotes?: LineNote[]` (absent when none). `computeReviewModel` options gain `levels?: ReadonlyMap<string, ReviewLevel>` and `lineNotes?: ReadonlyMap<string, LineNote[]>`, keyed by current path; keys naming no review-set file are ignored.
  - The skill writes version 4; older extensions reject v4 files — intended (they would otherwise drop ranged notes).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/cluster/SKILL.md (doc): the clusters contract file — read before changing cluster generation or its file format

## Implementation details

1. `src/clusters.ts`: add the types; widen `isContractVersion`; change `version === 3` gates for extraction and notes to `version >= 3`; add a `parseNotes(raw, version)` helper returning `{ notes, lineNotes } | { error }` and a `parseLevels(raw)` helper; return the new maps.
2. `src/model.ts`: add the fields and options; set `reviewLevel: options?.levels?.get(path) ?? "review"` and `lineNotes` only when the list is non-empty.
3. `src/extension.ts`: derive `levels` and `lineNotes` from an `ok` contract (empty maps otherwise) next to `notes` (`:417-421`) and pass them to both `computeReviewModel` calls.
4. `plugin/skills/cluster/SKILL.md` (same commit as the parser, per its "Schema changes" section): schema heading and example to version 4 with a `levels` entry and an array-valued `notes` entry carrying `lines`; field rules for `levels` and the array form of `notes`; `version` rule "write exactly `4` (also accepts 1-3)"; Notes section: when to use a line range (a remark about specific lines) vs a file-level string; preservation rules apply to both forms. Add a short "Review levels" Contract section: mark `skim` a file the reviewer need not read line by line (tests mirroring code, mechanical edits, docs); omit `review` (default). Reference it from the workflow, do not restate it.
5. `DEVELOPMENT.md` "Clusters contract": schema line, versions line, `notes` line, and new `levels` line; manual step 30's invalid example becomes `"version": 5` with the new message; step 21 gains a ranged-note sentence noting the data reaches the model (rendering arrives with a later task — do not describe rendering here).

## Gotchas

- Existing tests assert the old version messages; update them.
- A version 3 contract with an array-valued note must still fail with the v3 message.
- `levels` and array `notes` are not ungated like `waitPaths`: they need version 4.
- Do not add rendering (row tags, threads) in this task.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Write in `src/clusters.test.ts`: v4 accepted; v5 rejected with the new message; `levels` valid/invalid values and non-object; `levels` ignored at v3; string, array-of-strings (joined), and ranged items; every malformed `lines` shape (non-array, wrong length, non-integer, start < 1, end < start) rejects; empty items dropped; v4 moves keep `fromLines`/`baseBlob` (regression for the `>= 3` gate).
- Write in `src/model.test.ts`: `reviewLevel` defaults to `"review"` and reads `levels`; `lineNotes` set only for paths with notes.
