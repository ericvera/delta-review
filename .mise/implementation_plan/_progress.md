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

## Task 3.1 — Comment controller: gutters, note creation, thread rendering

- Key changes: new `src/commentController.ts` (`createNoteCommentController` — commenting
  range provider offering full-document ranges on both diff sides (working `file://` docs in
  the review set; base docs only while their query sha is some file's current `diffBaseSha`),
  `addNote` handler deriving side/path from the thread URI, persisting via `createNote`, and
  adopting the pending thread in place; `renderThreads` reconciling a noteId→CommentThread
  cache — working side at the file URI (deleted files at the empty base URI), base side at
  the currently displayed base sha with dispose+recreate when the sha moves, status labels
  with `• Outdated` flag and "Line was:" snapshot block in the first comment, `canReply:
  false`; exported helpers `reviewBasePathFor`/`baseBlobForPath`). `src/extension.ts` —
  controller instantiation + disposal, `deltaReview.addNote` registration, and a
  generation-guarded notes block at the end of `refresh()` (loadNotes → loadResponses →
  `refreshDerived` with `anchorResolves: () => false` → `mergeThreads` → `renderThreads`;
  threads cleared on the no-git and fatal-error paths, left untouched on an invalid notes
  file). `package.json` — `deltaReview.addNote` command, `comments/commentThread/context`
  menu entry (`commentThreadIsEmpty` gate), palette hide.
- Deviations from plan: none material. The refresh block skips `refreshDerived` entirely
  when no notes exist on disk so no empty notes file is ever created. Verification: no e2e
  infra exists in-repo, but the manual-check substitute was scripted with
  `@vscode/test-electron` (harness in the session scratchpad, not committed): 40 assertions
  covering working/base/deleted-file note creation, multi-line ranges, pending-thread
  adoption (label/contextValue/state/canReply), notes-file schema, `refs/review-notes/<branch>`
  anchoring, derived-position shift on refresh, pre-seeded-note rendering at activation
  (reload-window substitute), and the unwritable-store failure path (file untouched, thread
  not adopted). The visible `+` gutter hover remains eyeball-only in the F5 dev host.

## Task 3.1 (review fix) — Notes-refresh failures no longer tear down the review tree

- Key changes: `src/extension.ts` — the notes block in `refresh()` now has its own try/catch
  (it previously shared the model catch, so a throwing `refreshDerived`/`loadNotes` replaced
  the whole tree with a fatal error state). On a notes failure the model, tree, badge, status
  bar, and previously rendered threads stay intact; a notes-scoped
  `showWarningMessage` surfaces the error, deduped via a module-level `lastNotesWarning`
  string (the same pattern Task 3.3 will use for response-file warnings).
- Deviations from plan: none — review-directed fix only.

## Task 3.2 — Thread actions: edit/delete turns, delete thread, resolve/unresolve, reply-to-reopen

- Key changes: `src/commentController.ts` — comments are now `NoteComment`s carrying
  `noteId`/`reviewerTurnIndex`/`turnText`, with `contextValue: "reviewerTurn"` on reviewer turns
  only (agent turns get none); handlers `editNoteTurn` (flips to `CommentMode.Editing` with the
  raw text as body — display body is escaped markdown and may carry the snapshot block),
  `saveNoteTurn` (persists via `editReviewerTurn`, reads the edited value from `comment.body`),
  `cancelNoteTurn`, `deleteNoteTurn` (store decides single-turn → whole-note delete),
  `deleteNoteThread`, `resolveNote`/`unresolveNote` (accept a `CommentThread` or a
  `CommentReply` — the reply-row Resolve passes the latter), `replyReopen`
  (`appendReviewerTurn` → open); `canReply = (status === "addressed")` in `styleThread`; cache
  entries now hold the last rendered `NoteThread` (handlers restyle eagerly, then
  `onDidChangeNotes` re-renders authoritatively) plus a reverse `Map<CommentThread, noteId>`;
  `styleThread` carries comments in Editing mode across re-renders by reviewer-turn index so
  watcher refreshes don't blow away an in-progress edit. `src/notesStore.ts` — new
  `deleteReviewerTurn` (deletes the whole note when its only turn is removed, returns
  `undefined` then; re-derives status via extracted `recomputeStatus`, now shared with
  `setResolved`). `src/extension.ts` — registered the eight commands. `package.json` — command
  declarations with codicons, `comments/comment/title` (edit/delete, `comment == reviewerTurn`),
  `comments/comment/context` (Cancel/Save), `comments/commentThread/title` (Resolve on
  open|addressed, Unresolve on resolved, Delete Thread on all three — regex gates anchored
  `^(...)$`), `comments/commentThread/context` (Reply & Reopen + Resolve on
  `commentThread == addressedNote && !commentThreadIsEmpty`), palette hiding.
- Deviations from plan: `deleteReviewerTurn` added to `src/notesStore.ts` (+5 tests) though the
  task's file list omitted it — removing a single turn needs store-level persistence and the
  ≥1-reviewer-turn invariant enforced at save time. Verification: manual checks 1–7 scripted
  with the session `@vscode/test-electron` harness (`runThreadActions.mjs` +
  `suite/threadActions.cjs` in the scratchpad, not committed): 44 assertions all passing —
  edit/save/cancel (timestamp preserved, status unchanged), single-turn delete disposes thread,
  hand-written response → Addressed + reply box, Reply & Reopen → open + box gone, multi-turn
  delete re-derives addressed, resolve/unresolve from both statuses and via the reply-row
  `CommentReply` shape, addressed-thread delete, and review-state isolation (notes file
  byte-identical across `markAllReviewed`; no note action creates `refs/review/<branch>`).
  Display assertions wait ~900ms for the authoritative re-render (eager restyles can be
  transiently clobbered by an in-flight stale refresh). Menu placement/icons remain eyeball-only
  in the F5 dev host.

## Task 3.2 (review fixes) — Empty-input guards; edits address turns by `at` identity

- Key changes: `src/commentController.ts` — `replyReopen` no-ops on an empty/whitespace reply
  (an empty reply must never reopen a note; the typed whitespace stays in the input box);
  `saveNoteTurn` treats saving an emptied body as cancel — it reuses `cancelNoteTurn` to close
  edit mode and restore the original text (chosen over leave-editing-open no-op: same line
  count, and the reviewer isn't stranded in an empty editor; an empty turn is never persisted).
  `NoteComment` now carries `turnAt` (the turn's `at` timestamp); `saveNoteTurn` persists via
  `at` identity and updates the cached thread by `at` lookup, and `styleThread` carries
  in-progress Editing comments across re-renders keyed by `turnAt` (remapping their
  `reviewerTurnIndex` to the fresh render) — so a concurrent delete of another reviewer turn
  can no longer shift indices under an in-progress edit and overwrite the wrong turn.
  `src/notesStore.ts` — `editReviewerTurn` signature changed from `turnIndex: number` to
  `turnAt: string`; throws when no turn carries that timestamp. `src/notesStore.test.ts` —
  existing edit tests moved to the `at` signature; new tests: edit targets the right turn after
  an earlier turn's deletion shifts indices, and a deleted turn's timestamp is rejected.
- Deviations from plan: none — review-directed fixes only.

## Task 3.3 — Live agent loop: anchor application, live merge, outdated polish, contract freshness

- Key changes: `src/notesStore.ts` — new `buildAnchorResolver(responses, readWorkingContent)`
  (an anchor resolves when its file exists and its line ≤ the file's logical line count; each
  anchored file read once, sync callback returned) and the finalized anchor-application path
  inside `refreshDerived` replacing Task 2.1's `applyAnchors` hook: for each thread's
  `effectiveAnchor` the carrying agent turn's `at` is found by reference, guarded one-shot via
  `note.appliedAnchorAt`, then the note is rewritten (side → working, file/lines → anchor,
  snapshot → `[anchor.snapshot]`, `contentBlob` re-snapshotted from the anchor file's current
  content, outdated → false) with the blob re-anchored on `refs/review-notes/<branch>` in the
  same pass; `anchorResolves` now defaults to the real resolver. `src/extension.ts` — notes
  block builds one resolver per refresh (drives both `refreshDerived` and the render merge);
  invalid notes file → deduped warning + `renderThreads([])` (read-only broken, file never
  rewritten); invalid responses file → deduped warning, treated as missing; `warnOnce` helper
  unifies the three warning dedupes (each reset when its file loads cleanly).
  `src/commentController.ts` — outdated first comment now renders the mock-4 dimmed
  `*line was: `<first snapshot line>`*` one-liner (backtick-safe `inlineCode` helper);
  relocation dispose+recreate carries `collapsibleState` over. `src/notesStore.test.ts` —
  responses helper generalized to full entries; new suites: anchor application (side
  flip/relocation/re-snapshot/ref re-anchor, one-shot idempotence, newer-anchor re-apply,
  dangling missing-file and out-of-range-line anchors, resolved survives late response) and
  `buildAnchorResolver` line-count semantics; the old `applyAnchors` hook test replaced by the
  real-path coverage (250 tests total).
- Deviations from plan: none material. The `applyAnchors` hook was removed rather than kept
  alongside the built-in path — the application now lives inside `refreshDerived` as the plan's
  "finalize" instruction intended. Verification: manual agent-loop checks 1–7 scripted with the
  session `@vscode/test-electron` harness (`runAgentLoop.mjs` + `suite/agentLoop.cjs` in the
  scratchpad, not committed): 34 assertions all passing — watcher-driven response merge with no
  manual refresh (label flips to Addressed, status persisted), anchored relocation across files
  with base→working flip and ref re-anchor, dangling anchor ignored, edit-above shift +
  noted-line edit → Outdated label and "line was" body, base progression after mark-reviewed
  (base thread disposed/recreated at the new sha; turns/status byte-untouched), deleted noted
  file outdated-but-listed, corrupt responses (extension keeps working, recovers on fix),
  corrupt notes (never rewritten, no rendering, mutation refused), and a 5s mtime-stability
  window proving no refresh/write oscillation. Toast dedup wording remains eyeball-only.

## 3.3 (review fixes) — responses-file warning without notes; anchor paths confined to the repo

- Key changes: `src/extension.ts` — refresh's notes block now loads/validates the responses
  file before the note-count branch, so an invalid responses file warns (deduped via
  `lastResponsesFileWarning`, cleared on valid/missing) even when the notes file is
  missing/empty; only a missing responses file stays silent. `src/notesStore.ts` — new
  `isRepoRelativeAnchorFile` guard: agent-written `anchor.file` must be a repo-relative
  `/`-separated path (rejects absolute paths, `..`/`.` segments, backslash separators,
  drive-letter prefixes, empty segments); enforced in `buildAnchorResolver` (bad paths are
  never read and never resolve) and again in `refreshDerived`'s anchor-application path (an
  injected resolver cannot force an escape) — such anchors count as dangling: no relocation,
  no side flip, response text still merges. `src/notesStore.test.ts` — two new tests
  (traversal anchor stays dangling under an accept-all injected resolver; resolver rejects
  traversal/absolute/backslash/drive/`.`-segment paths without reading them), 252 total.
- Deviations from plan: none — targeted fixes for the two reviewer-confirmed defects only.

## Task 4.1 — REVIEW NOTES view: sibling SCM section with file groups, status icons, empty state

- Key changes: new `src/notesTreeProvider.ts` (`NotesTreeElement` union
  `fileGroup`/`note`, `notesCollapseKeyFor` (`notes:<path>` namespace),
  `NotesTreeProvider` — root = file groups sorted by path (basename label, dimmed
  dirname ` · <n>` description with the bare count for root-dir files, resolved
  notes included, full-path tooltip, id `notesFile:<path>`, default expanded via
  injected `isCollapsed`); children = that file's threads sorted by
  `currentStartLine` (status icon circle-large-filled/blue → open,
  circle-large-outline/yellow → addressed, check/green → resolved; ~60-char
  first-line label; `:<line> base ⚠` description parts; full-text+status tooltip;
  `contextValue: noteRow-<status>`; id `note:<noteId>`; click command
  `deltaReview.openNoteInDiff` with the thread argument); `getChildren(root)`
  returns `[]` when empty so `viewsWelcome` renders). `src/extension.ts` —
  `notesTreeProvider`/`notesTreeView` (`createTreeView("deltaReviewNotes")`),
  collapse wiring into the shared collapsed set, `renderNoteThreads(threads)`
  helper replacing every `commentController.renderThreads` call site (renders
  both surfaces + sets the notes badge to the open+addressed count, tooltip
  "n review note(s) to handle"), and the `deltaReview.openNoteInDiff` stub
  (opens the file's review diff via `openDiff` when the noted file is in the
  review set; no-op otherwise). `package.json` — `views.scm` sibling entry
  `deltaReviewNotes`/"Review Notes", `viewsWelcome` empty state, command
  declaration + palette hide. `deltaReview` view entries untouched.
- Deviations from plan: none. The plan's "module-level `NoteThread[]` variable"
  isn't needed — the provider holds the current threads; `renderNoteThreads`
  centralizes the fan-out at the already-generation-guarded call sites (the
  notes-failure catch still leaves both surfaces and the badge intact).
  Verification: manual checks scripted with the session `@vscode/test-electron`
  harness (`runNotesView.mjs` + `suite/notesView.cjs` in the scratchpad, not
  committed): 36 assertions all passing — manifest contributions (sibling view
  second in `views.scm`, welcome text, command), empty root → `[]`,
  grouping/sorting incl. same-basename subdir disambiguation, all three status
  icons with `charts.*` colors, truncation, base/⚠ markers, ids/contextValues,
  click-command wiring, collapse-key replay, live setThreads events, the
  openNoteInDiff stub opening the review diff (and no-op off-set), review-flow
  isolation (`markAllReviewed` unaffected, no notes file created by an empty
  view). Welcome-view rendering, badge pill, and section placement remain
  eyeball-only in the F5 dev host.

## Task 4.2 — View actions: click-to-diff navigation, Clear Resolved, live updates, branch switching

- Key changes: `src/extension.ts` — real `deltaReview.openNoteInDiff` (in-set file →
  `openDiff` with a selection at `currentStartLine - 1` passed as `vscode.diff`'s positional
  4th options argument, then `expandThread` one tick after the await; deleted in-set file →
  its deletion diff via the same path; off-set file → plain `showTextDocument` at the line,
  with an `access` check first and a "file no longer exists; note kept" info toast when the
  file is gone from disk too); `openDiff` gained an optional `selection` parameter; new
  `deltaReview.clearResolvedNotes` command (collects resolved ids from the rendered thread
  set held in `currentNoteThreads`, batch-deletes, refreshes; error toast without refresh on
  store failure); `currentNoteThreads` assigned only in `renderNoteThreads`.
  `src/commentController.ts` — new `expandThread(noteId)` (sets the cached thread's
  `collapsibleState` to Expanded — the reveal approximation, no stable `thread.reveal()` in
  1.90). `src/notesStore.ts` — new `deleteNotes(git, branch, ids)` batch helper: one
  load→save→anchor pass, early-return with nothing matched (file and ref untouched).
  `package.json` — `clearResolvedNotes` declaration (`$(clear-all)`), `view/title` entry on
  `deltaReviewNotes`. `src/notesStore.test.ts` — 4 new `deleteNotes` tests (260 total).
- Deviations from plan: none. Live updates (REQ-VIEW-5) and branch/repo switching
  (REQ-VIEW-8) needed no code: every render path funnels through `renderNoteThreads` (both
  surfaces + badge), the responses/notes files are watched via the delta-review-dir watcher,
  and the notes load path derives branch/repo from the current refresh's `computed.branch` /
  captured `git` with no caches. Verification: manual checks 1–6 scripted with the session
  `@vscode/test-electron` harness (`runViewActions.mjs` + `suite/viewActions.cjs` in the
  scratchpad, not committed): 26 assertions all passing — diff navigation with cursor at the
  note's line and thread expanded, plain-file fallback after reverting the change, base-side
  note (diff opens, left thread expanded), deletion-diff navigation, vanished-file note-kept
  path, Clear Resolved (resolved gone from file/threads/ref, open notes untouched, second
  run touches neither file nor ref), watcher-driven addressed flip with no manual refresh,
  and branch switching (per-branch notes files isolated across `git switch`). SCM-picker
  repo switching wasn't scripted (single-repo harness; `setActiveRepo` funnels through
  `refresh()` — code-verified); toast wording and title-button placement remain eyeball-only
  in the F5 dev host.

## Task 5.1 — review-notes skill, README/DEVELOPMENT docs, full verification pass

- Key changes: new `plugin/skills/review-notes/SKILL.md` (agent-facing contract doc mirroring
  cluster-review: frontmatter with the plan's trigger phrases; both schemas with
  parser-rejection rules vs silent-failure conventions; numbered steps — repo/branch/common-dir
  resolution with the shared sanitization rule and explicitly no base-branch logic;
  missing/empty notes → report and stop; timestamp-based work-set rule — actionable iff newest
  turn across both files is a reviewer turn and status ≠ resolved, never trust `status` alone;
  snapshot-first target location with `currentStartLine` as hint; append-only atomic
  responses writing with `date -u +%FT%TZ` timestamps and working-tree anchors; never write
  the notes file, never repair a corrupt one; version-bump rule). `README.md` — feature
  bullet, "Review notes" usage section (creation, lifecycle, agent loop, REVIEW NOTES view),
  and a two-skills install note beside the cluster instructions; Settings untouched.
  `DEVELOPMENT.md` — "Review notes" internals section (contract files and ownership,
  `refs/review-notes/<branch>` anchoring, anchoring model + derived-field refresh, thread
  merge/status derivation, response-anchor application, watcher/warning behavior,
  standard-comments-API rendering) and manual-script "Notes" group (scenarios 23–35).
  `plugin/.claude-plugin/plugin.json` untouched — skills are directory-discovered, not
  enumerated there.
- Deviations from plan: none. Verification: `yarn format`/`yarn lint`/`yarn build`/`yarn test`
  (256 tests)/`yarn package` all green; vsix excludes `plugin/**` so skill files ship with the
  plugin only. Skill dry-run executed literally against a scratch repo on branch `notes/demo`
  (exercises sanitization): phase A created a working-side and a base-side note through the
  real `deltaReview.addNote` path in a scripted extension host; the agent role was then
  simulated out-of-host by following SKILL.md step-by-step (bash resolution incl. relative
  `--git-common-dir`, snapshot-located code edits, atomic temp+rename append of two anchored
  responses); phase B host run verified the extension merge picked it up — both notes
  persisted `addressed`, anchor relocation incl. the base→working flip, `appliedAnchorAt`
  one-shot, contentBlobs re-anchored on the ref — and completed the lifecycle in-host (third
  note → live watcher merge to Addressed → `deltaReview.resolveNote` → resolved persisted),
  with the skill's step-3 work-set rule returning empty afterwards (no re-addressing).
  Full-manual-pass substitute (interactive F5 unavailable): re-ran every session
  extension-host harness — notes (39 checks), threadActions (44), agentLoop (34), notesView,
  viewActions, moves — all PASSED; Comments-panel check done at code level (single standard
  `createCommentController`, only stock `comments/*` menu contributions, no panel-specific
  code). Purely visual details (icons, badge pill, menu placement, toast wording) remain
  eyeball-only in the F5 dev host.
