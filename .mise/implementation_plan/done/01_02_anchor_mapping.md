# Task 1.2: Anchor mapping — hunk parsing and line-range re-mapping

## Goal

Create `src/noteAnchor.ts`: pure functions that parse `git diff -U0` output into hunks and map a
note's creation-time line range to its current position (shifted, unchanged, or outdated), with unit
tests.

## Requirements addressed

REQ-ANCHOR-1, REQ-ANCHOR-2, REQ-ANCHOR-3

## Background

The feature: inline review notes anchored by content, not line number. Each note stores its creation
line range plus the blob sha of the whole document at creation (`contentBlob`, defined in Task 1.1's
`Note` type in `src/notes.ts`). To render a note against the current document, the store (Task 2.1)
runs `git diff -U0 <creationBlob> <currentBlob>` and this module maps the range through the hunks —
independently per note, so multiple notes in one file each shift/survive/expire on their own.

This module is pure (no `vscode`, no git execution): input is the diff text and a range; output is a
mapping result. Project test convention: colocated Vitest, pure logic only.

## Files to modify/create

- `src/noteAnchor.ts` — new module.
- `src/noteAnchor.test.ts` — new unit tests.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number }`.
2. `parseUnifiedDiffHunks(diffText: string): DiffHunk[]` — extract every `@@ -a[,b] +c[,d] @@` header
   (regex `/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/`, multiline); omitted counts default to 1.
   Ignore all other lines. Empty/whitespace input → `[]`.
3. `export type MappedRange = { startLine: number; endLine: number; outdated: boolean }`.
4. `mapRangeThroughHunks(startLine, endLine, hunks): MappedRange` — semantics (1-based lines,
   `-U0` hunks are disjoint and ordered):
   - **Outdated** when any line of `[startLine, endLine]` intersects a hunk's old range
     `[oldStart, oldStart+oldLines-1]` (with `oldLines === 0` meaning a pure insertion *between*
     `oldStart` and `oldStart+1` — an insertion strictly between the note's lines also counts as
     touching the range; an insertion at the range's outer boundary does not).
   - When outdated: position at the nearest surviving location — map `startLine` by accumulating
     deltas of hunks entirely above it, clamp into the new document's line space, set
     `endLine = startLine + (original range length - 1)` capped at the touching hunk's new end;
     simplest honest rule: collapse to a single line at the mapped start. Choose the collapse rule
     and document it in the function comment — the requirement is "nearest surviving location",
     display-only.
   - Not outdated: shift both lines by the sum of `(newLines - oldLines)` for every hunk whose old
     range ends before `startLine`.
5. Keep the whole-file-content case out: creation blob == current blob short-circuits in the store
   (no diff run); this module never sees identical content.

## Testing suggestions

- `src/noteAnchor.test.ts`:
  - `parseUnifiedDiffHunks`: single hunk, multiple hunks, omitted counts (`@@ -5 +7 @@`), zero-count
    insertion/deletion hunks, no hunks, garbage lines ignored;
  - `mapRangeThroughHunks` table (`it.each`): note above all hunks (unchanged); below an insertion
    (+N shift); below a deletion (−N shift); range inside an edited hunk (outdated); multi-line range
    where only its middle line changed (outdated — any-line rule per REQ-ANCHOR-3); insertion
    strictly inside a multi-line range (outdated); insertion at the boundary just above/below the
    range (not outdated); multiple hunks above accumulating; edit at exactly `startLine` and exactly
    `endLine` (outdated).
- Run `yarn test`.

## Gotchas

- `git diff -U0` pure-insertion hunks report `oldLines = 0` with `oldStart` = the line *before* the
  insertion point — off-by-one traps live here; encode the convention in tests first.
- Deletion-only hunks report `newLines = 0`; a note whose range was entirely deleted must map to the
  clamped nearest line, never line 0 (minimum 1).
- Do not implement diffing itself — git produces the diff (store layer); this module only parses and
  maps.

## Verification checklist

- [ ] `yarn test` passes with the new `noteAnchor.test.ts` suite.
- [ ] `yarn lint` and `yarn build` pass.
- [ ] End-to-end tests: Test exception applies (no e2e infrastructure exists): exhaustive unit tests
      above are the verification; no runtime surface exists yet.
