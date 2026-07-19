# Progress

## Task 1.1 — Notes contract: types, parse/validate, load results in `src/notes.ts`

- Key changes: new `src/notes.ts` (types `NoteSide`, `NoteStatus`, `ReviewerTurn`, `Note`,
  `NotesFile`, `ResponseAnchor`, `ResponseEntry`, `ResponsesFile`; result unions
  `ParseNotesResult`/`ParseResponsesResult`/`LoadNotesResult`/`LoadResponsesResult`; filename
  helpers `notesFileName`/`responsesFileName` reusing `sanitizeBranchForFilename` from
  `./clusters`; parsers `parseNotesFile`/`parseResponsesFile` with a shared
  `parseVersionedFile` top-level validator in clusters style). New `src/notes.test.ts`
  (round-trips, version rejection, per-field `it.each` error tables, unknown-key tolerance,
  filename sanitization/prefix tests).
- Deviations from plan: also validates `currentEndLine >= currentStartLine` (plan only named
  `endLine >= startLine`; applied the same ordering rule to the derived pair for consistency).
  `turns[].text`/`turns[].at` and `anchor.snapshot` accept empty strings (plan required
  non-empty only for `id`/`file`/`contentBlob`/`createdAt`/`noteId`/`response`/`at`/`anchor.file`).

## Task 1.2 — Anchor mapping: hunk parsing and line-range re-mapping in `src/noteAnchor.ts`

- Key changes: new `src/noteAnchor.ts` (`DiffHunk`, `parseUnifiedDiffHunks` extracting
  `@@ -a[,b] +c[,d] @@` headers with omitted counts defaulting to 1; `MappedRange`;
  `mapRangeThroughHunks` — any-line intersection marks outdated, pure insertions outdate only
  when strictly inside the range, clean ranges shift by the net delta of hunks above). New
  `src/noteAnchor.test.ts` (header parsing incl. zero-count/omitted-count/garbage cases;
  `it.each` mapping table for shifts, boundaries, outdated positioning, clamping; independent
  per-note mapping over one shared diff).
- Deviations from plan: none. Collapse rule chosen per the plan's offered "simplest honest
  rule": an outdated range collapses to a single line at the mapped start (start shifted by
  hunks above when the start line survives; offset into the replacement capped at its last
  line when rewritten; deletion hunk's `newStart` clamped to >= 1 when deleted outright).

## Task 1.3 — Thread merge: notes + responses → display threads in `src/noteThreads.ts`

- Key changes: new `src/noteThreads.ts` (`ThreadTurn`, `NoteThread`; `mergeThreads` grouping
  responses by noteId, dropping unknown ids, interleaving reviewer/agent turns by `at` with a
  stable file-order fallback for ties/unparsable timestamps, deriving status — explicit
  `resolved` wins, else last speaker agent → addressed / reviewer → open — and picking
  `effectiveAnchor` as the newest agent anchor passing the injected `anchorResolves` callback,
  dangling anchors skipped with fall-through to next-newest; `workSet` filtering derived-open
  threads). New `src/noteThreads.test.ts` covering all plan-listed cases plus no-mutation and
  multi-note ordering.
- Deviations from plan: none. Tie fallback concatenates reviewer turns before agent turns, so
  an exact timestamp tie orders reviewer first (each source array's internal order preserved).

## Task 2.1 — Notes store: git-backed persistence, blob anchoring, derived-field refresh

- Key changes: new `src/notesStore.ts` (`reviewNotesRefForBranch`; `loadNotes`/`loadResponses`
  clusters-style via git common dir; `saveNotes` atomic same-dir temp+rename with the
  idempotence guard — module-level last-written map plus on-disk comparison, returns
  wrote/skipped boolean; `writeContentBlob` (`hash-object -w --stdin`); `anchorBlobs`
  commit-tree on `refs/review-notes/<branch>` with path=note id, sha=contentBlob, temp
  `GIT_INDEX_FILE` in `finally`, ref deleted when no notes remain; mutation helpers
  `createNote` (takes `NoteDraft`), `appendReviewerTurn`, `editReviewerTurn`, `deleteNote`,
  `setResolved` — all load→modify→save+anchor, throwing instead of overwriting an invalid
  on-disk file; `refreshDerived(git, branch, notesFile, responses, options)` with
  `RefreshOptions` `{readWorkingContent, baseBlobFor, anchorResolves?, applyAnchors?}` —
  clone-in/clone-out, short-circuit on identical blobs, `git diff -U0 <blob> <blob>` →
  `mapRangeThroughHunks` otherwise, missing side document → outdated + keep last position,
  status from `mergeThreads`, re-anchor only when a contentBlob changed). New
  `src/notesStore.test.ts` (24 tests, real temp repos): load/save round-trip, missing/corrupt,
  guard skips (module state and fresh on-disk identical content), blob + ref anchoring,
  `gc --prune=now` survival with `refs/review/<branch>` written then deleted (plus a control
  blob proving gc prunes unanchored objects), sanitized filename vs raw ref for `feat/x`,
  mutation helpers incl. refuse-on-corrupt, setResolved/unresolve recompute, refreshDerived
  shift/outdate/missing/base-side/status-persist/no-input-mutation/hook re-anchor.
- Deviations from plan: `anchorBlobs` skips creating a commit when the anchored tree is
  unchanged (mutation helpers anchor after every save, so text-only edits would otherwise
  pile up empty commits on the ref); everything else mirrors `writeReviewState`. The 3.3
  hook is `applyAnchors(threads)` receiving the merged `NoteThread[]` (whose `note` refs are
  the to-be-persisted clones) rather than a per-note callback.
