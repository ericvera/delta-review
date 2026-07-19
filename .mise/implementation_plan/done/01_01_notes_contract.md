# Task 1.1: Notes contract — types, parse/validate, load results

## Goal

Create `src/notes.ts`: the versioned JSON contract for review notes (extension-owned) and agent
responses (agent-owned) — types, parsing, validation, and file-load result handling — with unit tests.

## Requirements addressed

REQ-AGENT-1, REQ-AGENT-2, REQ-AGENT-3, REQ-AGENT-8, REQ-STORE-2, REQ-PRESERVE-2

## Background

The feature: inline review notes in Delta Review's diffs, persisted per branch under the git common
dir, worked by a Claude Code agent through two JSON files. This task builds the pure contract layer;
no `vscode` import allowed (Vitest cannot load it — project test convention).

The codebase has an exact precedent to mirror: `src/clusters.ts` parses the per-branch clusters
contract. Copy its idioms:

- Result unions `clusters.ts:39-45`: `ParseClustersResult = {ok:true; contract}|{ok:false; error}`;
  `LoadClustersResult = {state:"missing"}|{state:"invalid"; error}|{state:"ok"; contract}`.
- `sanitizeBranchForFilename` `clusters.ts:137-138`: `branch.replace(/[^A-Za-z0-9._-]/g, "-")` —
  **reuse by import**, do not duplicate.
- Validation style `clusters.ts:145-216`: `JSON.parse` in try/catch; top-level must be a non-array
  object; `version` must be exactly integer `1`; per-entry checks return one-line user-facing error
  strings naming the entry (e.g. `note 3 ("a1b2…"): "side" must be "base" or "working"`); unknown
  keys ignored (forward compatibility).

## Files to modify/create

- `src/notes.ts` — new module: types, constants, parse/validate functions.
- `src/notes.test.ts` — new unit tests.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Types (export all):
   - `NoteSide = "base" | "working"`, `NoteStatus = "open" | "addressed" | "resolved"`.
   - `ReviewerTurn = { text: string; at: string }` (ISO-8601 UTC).
   - `Note = { id: string; file: string; side: NoteSide; startLine: number; endLine: number;
     snapshot: string[]; contentBlob: string; turns: ReviewerTurn[]; status: NoteStatus;
     outdated: boolean; currentStartLine: number; currentEndLine: number; createdAt: string }`.
     Lines 1-based. `snapshot` holds the anchored lines' text (one entry per line of the range).
     `currentStartLine`/`currentEndLine`/`outdated`/`status` are derived fields the extension
     refreshes (REQ-AGENT-9); they persist so agents reading the file get near-current hints.
     Also declare `appliedAnchorAt?: string` (optional, extension-internal: timestamp of the last
     response anchor applied to the note, Task 3.3's one-shot guard) — it MUST be parsed and
     re-serialized like any known field, because the parser normalizes to known fields only and
     would otherwise strip it on the first load→save cycle.
   - `NotesFile = { version: 1; notes: Note[] }`.
   - `ResponseAnchor = { file: string; line: number; snapshot: string }` (always working-tree).
   - `ResponseEntry = { noteId: string; status: "addressed"; response: string; at: string;
     anchor?: ResponseAnchor }`.
   - `ResponsesFile = { version: 1; responses: ResponseEntry[] }`.
2. Constants: `notesFileName(branch)` → `notes-<sanitized>.json`, `responsesFileName(branch)` →
   `responses-<sanitized>.json` (import `sanitizeBranchForFilename` from `./clusters`). The prefix
   must never collide with `clusters-` (REQ-PRESERVE-2).
3. `parseNotesFile(text): {ok:true; file: NotesFile}|{ok:false; error: string}` — validate every
   field: `id`/`file`/`contentBlob`/`createdAt` non-empty strings; `side` and `status` in their
   unions; lines integers ≥ 1 with `endLine >= startLine`; `snapshot` array of strings; `turns`
   array of `{text: string, at: string}` with **at least one turn**; booleans boolean. Multiple
   entries validated independently; first error string wins (clusters style).
4. `parseResponsesFile(text)` — same shape. Per entry: `noteId`/`response`/`at` non-empty strings;
   `status` exactly `"addressed"`; `anchor`, when present, an object with non-empty `file` string,
   integer `line ≥ 1`, string `snapshot` — an anchor failing validation invalidates only that entry?
   **No** — keep clusters semantics: a violating file is rejected as a whole with a one-line error
   (REQ-AGENT-8 surfaces it as a warning; simpler and matches precedent). Note: a *structurally
   valid* anchor pointing at a nonexistent location is NOT this layer's concern (that's runtime
   resolution, Task 3.3).
5. Load-result types only (no fs here): `LoadNotesResult` / `LoadResponsesResult` mirroring
   `LoadClustersResult`. Actual file reading lives in `notesStore.ts` (Task 2.1) so this module stays
   pure and fully unit-testable.

## Testing suggestions

- `src/notes.test.ts`, mirroring `clusters.test.ts` style (`describe` per function, lowercase `it`
  sentences, `it.each` tables for error cases):
  - round-trips a valid notes file and a valid responses file;
  - version rejection (`0`, `2`, `"1"`, missing);
  - tabular per-field error cases for both parsers (wrong types, empty strings, bad side/status,
    line 0, endLine < startLine, empty turns, anchor variants incl. missing fields);
  - unknown extra keys accepted;
  - filename helpers: sanitization (`feat/x` → `notes-feat-x.json`) and distinct prefixes vs
    `clusters-`.
- Run `yarn test`.

## Gotchas

- Do not import `vscode` or anything that transitively imports it (`clusters.ts` is safe — verify it
  stays `vscode`-free; it is today).
- `JSON.parse` accepts numbers like `1.0` as `1`, and a strict `!== 1` check passes it — that is
  the accepted behavior; copy clusters' actual check (`record.version !== 1`, `clusters.ts:195-203`)
  rather than inventing a stricter one.
- Keep error strings one-line and user-facing: they surface in `treeView.message`-style warnings.

## Verification checklist

- [ ] `yarn test` passes with the new `notes.test.ts` suite included.
- [ ] `yarn lint` and `yarn build` pass.
- [ ] End-to-end tests: Test exception applies ("Anything that would need an extension-host e2e
      test — no e2e infrastructure exists"): pure-logic unit tests above are the verification; no
      runtime surface exists yet.
