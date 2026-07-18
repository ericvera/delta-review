# Task 3.3: Live agent loop — response merging, anchors, outdated, contract freshness

## Goal

Make the agent round-trip live and correct: responses merge into threads as the file changes on
disk, anchored responses relocate threads (with base→working side flip), outdated
detection/rendering follows edits and base progression, and the notes file's derived fields stay
near-current (REQ-AGENT-9) without watcher loops.

## Requirements addressed

REQ-AGENT-5, REQ-AGENT-6, REQ-AGENT-8, REQ-AGENT-9, REQ-ANCHOR-3, REQ-ANCHOR-4, REQ-ANCHOR-5, REQ-NOTE-7

## Background

The feature: an agent writes `responses-<branch>.json`; the extension shows its progress live.
Prior tasks:
- Task 1.2 — `src/noteAnchor.ts` mapping; Task 1.3 — `src/noteThreads.ts` (`mergeThreads` with
  `anchorResolves` callback, `effectiveAnchor` on threads).
- Task 2.1 — `src/notesStore.ts`: `loadResponses`, `refreshDerived(git, branch, notesFile,
  responses, …)` with idempotent `saveNotes`, anchor-application hook.
- Task 3.1/3.2 — `src/commentController.ts` render + actions; extension `refresh()` already loads
  notes/responses and renders (Task 3.1 wiring).

Existing machinery that makes "live" free:
- `watchContractDir` `src/extension.ts:325-353` watches `<commonDir>/delta-review/*.json` — agent
  writes to `responses-*.json` fire `scheduleRefresh` (400ms debounce `extension.ts:290-295`).
- `refresh()` `extension.ts:184-287` reloads contracts every run under a generation counter.
- Warning surface: `treeView.message` carries contract warnings (`extension.ts:242-258`,
  `contractWarning` pattern) — reuse the same style for notes/responses file warnings.

## Files to modify/create

- `src/extension.ts` — extend the notes portion of `refresh()`: anchor resolution, derived
  persistence, warnings.
- `src/notesStore.ts` — finalize the anchor-application path in `refreshDerived` (Task 2.1 left the
  hook).
- `src/commentController.ts` — outdated rendering polish; relocated-thread URI handling.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. **Anchor resolution** (REQ-AGENT-5): implement `anchorResolves(anchor)` against the working tree
   — file exists under `git.repoRoot` and `anchor.line` ≤ its line count. Dangling → ignored
   entirely (no relocation, no side flip; normal re-anchoring applies).
2. **Anchor application** (REQ-AGENT-5): for a thread with `effectiveAnchor`, persist onto the note
   (extension owns the notes file): `side = "working"`, `file = anchor.file`, lines = anchor line,
   `snapshot = [anchor.snapshot]`, `contentBlob` = hash of the anchor file's current content
   (re-snapshot so future re-anchoring tracks the *new* line), `outdated = false`. One-shot: apply
   only when the newest unapplied anchor differs from what's already persisted (compare a stored
   marker, e.g. the applied response's `at`, kept as an extension-owned field on the note — add
   `appliedAnchorAt?: string` to the Note type as an extension-internal optional field; unknown keys
   are already tolerated by parsers).
3. **Status persistence** (REQ-AGENT-9): `refreshDerived` writes derived `status`
   (addressed/open flips from responses; resolved preserved — REQ-AGENT-6's resolved-wins rule is in
   `mergeThreads`).
4. **Outdated + base progression** (REQ-ANCHOR-3/4): base-side notes get their current base blob
   from the review model's `diffBaseSha` (`src/model.ts:28`) for the note's file; working-tree edits
   alone never touch them. Right-side notes diff against current working content. Deleted file →
   right-side notes outdated, positions kept (REQ-ANCHOR-5).
5. **Rendering** (mock 4): outdated threads show `" • Outdated"` in the label and a dimmed
   `line was: <snapshot first line>` line in the first comment's MarkdownString body. Relocated
   threads re-attach at the new URI (file change ⇒ dispose + recreate the `vscode.CommentThread` —
   URI is immutable on a thread).
6. **Warnings** (REQ-AGENT-8): invalid responses file → append a `⚠ Review notes responses: <error>`
   line to the notes view/panel message surface (Task 4.1 adds the view; until then use
   `vscode.window.showWarningMessage` once per distinct error — keep last-warned string to avoid
   spam). Invalid notes file → warning + read-only-broken behavior: skip rendering and refuse
   mutations (store already refuses — surface the toast here when a mutation is attempted).
7. **Loop safety**: the derived write triggers the watcher; `saveNotes`'s idempotence guard
   (Task 2.1) makes the follow-up refresh a no-op write. Verify no oscillation with the 400ms
   debounce.
8. Review-state isolation (REQ-NOTE-7): marking reviewed changes `diffBaseSha` → base-side notes
   re-derive (allowed: derived presentation only); their content/turns/status stay untouched — no
   code path here may write turns/status from a review-state event.

## Testing suggestions

- Unit (extend `src/notesStore.test.ts`): anchor application rewrites side/file/lines/snapshot/
  contentBlob and is one-shot; dangling anchor leaves the note untouched; derived status persists
  addressed; resolved survives a late response.
- Manual, F5 dev host, with a second terminal playing the agent:
  1. Add a note; append a valid response entry to `responses-<branch>.json` → within ~1s the thread
     shows Claude's reply, label "Addressed", notes file `status` flips (REQ-AGENT-6/9).
  2. Response with `anchor` to a different file/line → thread relocates there, no Outdated flag,
     REVIEW NOTES-to-be shows the new location (defer view check to Task 4.x); base-side note flips
     to working side.
  3. Response with anchor to a nonexistent file → ignored; thread stays put.
  4. Edit lines above a note → position shifts; edit the noted line → "Outdated" + "line was" (mock
     4). Mark the file reviewed → base-side note re-maps against the new base (REQ-ANCHOR-4).
  5. Delete the noted file from the working tree → note outdated, still listed.
  6. Corrupt `responses-<branch>.json` → one warning, extension keeps working; corrupt
     `notes-<branch>.json` → warning, notes read-only (no rendering, mutations refused, file never
     rewritten).
  7. Watch `git status` / file mtimes for a minute → no refresh/write oscillation.

## Gotchas

- CommentThread URIs are immutable — relocation across files requires dispose+recreate; keep the
  collapse/expand state you can (recreate with the same `collapsibleState`).
- Never apply an anchor twice: the re-snapshot changes `contentBlob`, so a second application would
  see a "changed" doc and could flap. The `appliedAnchorAt` marker is the guard.
- The notes file is read by agents mid-run: `saveNotes` must stay atomic (temp+rename, Task 2.1) so
  a reader never sees a torn file.
- Do not surface missing responses file as a warning — missing is the normal state (mirror clusters:
  missing is silent, `extension.ts:234-253`).

## Verification checklist

- [ ] Unit additions to `notesStore.test.ts` pass (`yarn test`).
- [ ] Manual dev-host checks 1–7 above pass.
- [ ] `yarn lint`, `yarn build` pass.
- [ ] End-to-end tests: Test exception applies (no e2e infrastructure exists — verify with unit
      tests plus manual verification in the F5 Extension Development Host): the manual agent-loop
      checks above are the substitute verification.
