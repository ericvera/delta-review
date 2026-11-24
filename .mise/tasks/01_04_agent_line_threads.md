# 01_04 Read-only agent threads on line ranges

## Goal

Each line-range agent note from the clusters contract renders as a read-only comment thread spanning its lines (widget under the last line) on the review diff's right-side document, and the file's row tooltip counts the ranged notes and lists their ranges.

## Files to modify/create

- `src/provenance.ts`
- `src/commentController.ts`
- `src/extension.ts`
- `src/treeProvider.ts`
- `DEVELOPMENT.md`

## Background

- Task 01_02 added `ReviewFile.lineNotes?: LineNote[]` with `LineNote { lines: [start, end]; text: string }` (1-based inclusive) from `src/clusters.ts`.
- Pattern to follow: the file-level provenance thread. Entries composed in vscode-free `src/provenance.ts` (`provenanceEntriesFor`, `:66-92`); rendered by `renderProvenanceThreads` in `src/commentController.ts:476-520` with its own cache (`:452-474`), URI chosen by `provenanceUri` (`:470-474`: working file, or empty base document for a deleted file), read-only by `canReply = false` and no `contextValue`; snapshot accessor `provenanceThreads()` (`:522-540`) and `ProvenanceThreadSnapshot` (`:73-82`). Called from refresh at `src/extension.ts:520` and cleared at `:390` and in `renderThreads`' no-git path (`src/commentController.ts:544-555`).
- Clamping: `clampNoteRange` in `src/noteTarget.ts:107-117`; notes re-clamp on open via `reclampThreadsFor` (`src/commentController.ts:613-625`), called from `onDidOpenTextDocument` in `src/extension.ts:1993-2000`.
- `deltaReview.__inspect` (`src/extension.ts:2044-2068`) exposes thread snapshots for the scripted extension-host check.
- File row tooltip lines: `src/treeProvider.ts:555-598`.
- Design decisions:
  - Agent line threads are not notes and not provenance: a third cache, keyed `<path>\n<index>`, never in `threadNoteIds`, absent from the notes file, REVIEW NOTES, badge and Clear Resolved.
  - Range `start-1 .. end-1` (0-based, column 0), clamped when the target document is open, re-clamped on open; a range past the end sits on the last line.
  - Label `Agent note · lines a–b` (`Agent note · line a` when start = end, en dash); one comment, author `Claude`, body `MarkdownString` of `escapeMarkdownText(text)` (`src/markdown.ts:26`); `canReply = false`; no `contextValue`; collapsible state Expanded.
  - Same URI rule as provenance (deleted file → empty base document).
  - Tooltip line `<n> agent note(s) on lines: <ranges>` — `note` singular when n = 1; ranges `a–b` or `a`, joined `, `.
  - Plain-string notes keep today's file-level provenance thread unchanged.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `src/provenance.ts`: `export interface AgentLineNoteEntry { path: string; deleted: boolean; startLine: number; endLine: number; body: string }`; `agentLineNoteEntriesFor(model)`; `agentLineNoteLabel(startLine, endLine)`; `agentLineNotesTooltipLine(lineNotes: readonly LineNote[] | undefined): string | undefined`.
2. `src/commentController.ts`: `renderAgentLineThreads(entries)` (create, update body/range in place, dispose on URI change, sweep missing keys), `agentLineThreads(): AgentLineThreadSnapshot[]` (path, uri, startLine/endLine of the rendered range, label, canReply, contextValue, body); extend `reclampThreadsFor` to the new cache; clear the new cache wherever provenance is cleared. Add both to `NoteCommentController`.
3. `src/extension.ts`: call `renderAgentLineThreads(agentLineNoteEntriesFor(model))` beside `renderProvenanceThreads` and with `[]` in the no-repo reset; add `agentLineThreads` to `__inspect`.
4. `src/treeProvider.ts`: push `agentLineNotesTooltipLine(file.lineNotes)` into tooltip lines after the file note.
5. `DEVELOPMENT.md`: a "Agent line threads" subsection beside "The provenance thread" (how it differs: line range, own cache, label); mention `agentLineThreads` in "Scripted extension-host checks"; extend manual step 21 with a ranged note.

## Gotchas

- `createCommentThread` needs a `Range`; unlike provenance, keep the range (do not set it undefined).
- `canReply` defaults to `true`; set `false` explicitly or the controller placeholder offers a reply box.
- Never register these threads in `threadNoteIds` and never let note sweeps (`renderThreads`' dispose loop) reach them.
- Body changes rewrite `comments`; range changes write `range`; a URI change (file becomes deleted) disposes and recreates.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Write in `src/provenance.test.ts`: entries per ranged note with escaped body and deleted flag; no entries for files without line notes; label for single and multi-line; tooltip line singular/plural and range formatting; undefined for none/empty.
- Scripted extension-host check (`DEVELOPMENT.md`, "Scripted extension-host checks"; launch with `env -u ELECTRON_RUN_AS_NODE`, short `--user-data-dir`, throwaway repo, `DELTA_REVIEW_TEST=1`): write a v4 contract with two ranged notes on one modified file and one string note on another; assert via `deltaReview.__inspect` that `agentLineThreads` has two read-only threads with the expected ranges/labels/bodies on the working file URI, that `threads` (provenance) still has the string-note thread only, and that the tooltip-bearing row exists in `treeRows`. Harness lives in the session scratchpad, not committed.
