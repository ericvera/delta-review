# Implementation Plan

## Summary

Detected file moves currently render as unrelated D + A rows because the model diffs with `--no-renames`. This plan switches detection to git's native rename detection and renders each move as a single `R` row at the new path whose diff shows only the edits on top of the move — matching the built-in git Changes view's staged-rename rendering.

## Design

One new piece of data flows through the existing pipeline: `ReviewFile.movedFrom: string | undefined` (the old repo-relative path of a detected move; the required-with-undefined form matches the interface's `diffBaseSha` style). Everything downstream is a small consumer of it.

```
git diff --name-status --find-renames -z <mergeBase>
        │  parseNameStatusOutput (new, pure)
        ▼
computeReviewModel  ── ReviewFile { …, movedFrom? }
        │
        ├─ decorations.ts   changeKindFor: movedFrom → "renamed" (R badge,
        │                   gitDecoration.renamedResourceForeground)
        ├─ treeProvider.ts  description: "<dir> ← <old>" (list/flat),
        │                   "← <old>" (tree / root dir); tooltip "Moved from <old>"
        └─ extension.ts     openDiff: left = old-path blob at merge base
                            (snapshot base unchanged); title "(moved from <old> — …)"
```

- **Detection** (`src/model.ts`): replace `git diff --name-only --no-renames -z` with `git diff --name-status --find-renames -z`, parsed by a new pure function `parseNameStatusOutput` returning `{ paths: string[], movedFrom: Map<string, string> }` (new path → old path). Rename records contribute only their new path to the review set, so the old path never gets a row (REQ-DET-1/2). Untracked handling, dedupe, and sort are untouched.
- **Diff base** (`src/model.ts`): for a move without a usable reviewed snapshot, `diffBaseSha` becomes `baseBlobs.get(movedFrom)` — the old path's merge-base blob — which is what makes the diff show only the on-top edits (REQ-DIFF-1). The reviewed-snapshot base path (keyed by new path) is unchanged (REQ-DIFF-3).
- **Review state**: no changes. State is keyed by path; a move is one entry at its new path (REQ-STATE-1/2/4). Stale old-path entries are never consulted.
- **Rendering**: `decorations.ts` gains a `"renamed"` change kind (checked before added/modified; a move row is never `deleted`); `treeProvider.ts` composes the move description and tooltip line; `extension.ts` builds the left URI from the old path (correct origin label in the diff editor; content still comes from the sha) and extends the title.

No schema/data migrations; no code removal beyond the `--no-renames` flag.

## Assumptions

- **Left diff URI uses the old path** when the base is the merge base (accurate editor label; language detection unaffected since move file extensions match in practice, and content comes from the blob sha regardless). When the base is the reviewed snapshot, the left URI keeps the new path as today.
- **`C` (copy) records can't occur** since only `--find-renames` is passed, but the parser treats a two-path `C` record defensively as a plain added file at the destination.
- **`T` (typechange) and other single-path statuses** are treated exactly like today's name-only paths — one plain entry.
- **Rename-limit degradation is acceptable**: on huge diffs git may skip rename detection; the view falls back to A + D, which REQ-DET-4 permits.
- **Diff title composes as** `name (moved from <old path> — <base> ↔ <working>)`, shown whenever `movedFrom` is set, including on the snapshot base.

## Phases

- **Phase 1: Detection & model** — parse rename-aware diff output and thread `movedFrom` + the old-path diff base through `computeReviewModel`.
- **Phase 2: Rendering** — R badge, move descriptions/tooltips, diff origin + title, docs and full manual verification.

## Phase Rationale

Phase 1 changes the data model with unit-testable pure logic and immediately collapses D+A pairs into one row (functionally correct, temporarily badged `A`); the build stays green throughout. Phase 2 is pure presentation on top of `movedFrom` and ends with the dev-host manual pass that the config's Test exceptions prescribe for extension-host/visual behavior.

## Task Index

| File                            | Task                                                    | Phase | Requirements                                              |
| ------------------------------- | ------------------------------------------------------- | ----- | --------------------------------------------------------- |
| `01_01_parse_name_status.md`    | Pure parser for `--name-status --find-renames -z` output | 1     | REQ-DET-1, REQ-DET-3, REQ-DET-4                           |
| `01_02_model_moved_from.md`     | Wire rename detection into `computeReviewModel`          | 1     | REQ-DET-1..4, REQ-DIFF-1, REQ-DIFF-3, REQ-STATE-1..4, REQ-PRES-1..2 |
| `02_01_tree_rendering.md`       | R badge, move descriptions, tooltip                      | 2     | REQ-REND-1..6, REQ-STATE-3                                |
| `02_02_diff_and_verification.md`| Diff origin/title, docs, full dev-host manual pass       | 2     | REQ-DIFF-1..3, REQ-REND-6, REQ-PRES-1                     |
