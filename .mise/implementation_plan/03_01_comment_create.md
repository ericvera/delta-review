# Task 3.1: Comment controller — gutters, note creation, thread rendering

## Goal

Create `src/commentController.ts` and wire it into `src/extension.ts` + `package.json`: the `+`
commenting gutter on both diff sides, the add-note flow persisting through the store, and rendering
of existing threads with status labels.

## Requirements addressed

REQ-NOTE-1, REQ-NOTE-2, REQ-NOTE-3, REQ-NOTE-4, REQ-NOTE-5, REQ-LIFE-5

## Background

The feature: inline review notes in Delta Review's review diffs. Prior tasks produced:
- Task 1.1 — `src/notes.ts` (types incl. `Note`, `NoteSide`; `NotesFile`).
- Task 1.3 — `src/noteThreads.ts` (`mergeThreads` → `NoteThread { note, turns, status,
  effectiveAnchor }`).
- Task 2.1 — `src/notesStore.ts` (`loadNotes`, `loadResponses`, `createNote`, `refreshDerived`,
  mutation helpers).

Existing integration points:
- Review diffs open via `openDiff` `src/extension.ts:371-399`: left =
  `createReviewBaseUri(leftPath, diffBaseSha)` (scheme `delta-review-base`,
  `src/contentProvider.ts:4-16`), right = `vscode.Uri.file(join(git.repoRoot, file.path))`.
- The extension-wide refresh `extension.ts:184-287` recomputes `ReviewModel` (`model` variable) —
  `ReviewFile` fields at `src/model.ts:17-35` (`path`, `diffBaseSha` :28,
  `diffBaseIsReviewedSnapshot` :26, `deleted` :21).
- Commands register in `activate` `extension.ts:422-670`; disposables push into
  `context.subscriptions`.

VS Code Comments API (engines `^1.90`):
- `vscode.comments.createCommentController("deltaReview.notes", "Delta Review Notes")`; set
  `controller.commentingRangeProvider = { provideCommentingRanges(document) }`.
- The `+` gutter opens an empty thread with a native input; submitting runs a command contributed to
  the `comments/commentThread/context` menu with
  `when: "commentController == deltaReview.notes && commentThreadIsEmpty"`; the handler receives
  `vscode.CommentReply { thread, text }`.
- Threads: `controller.createCommentThread(uri, range, comments)`; set `label`, `contextValue`,
  `state` (`vscode.CommentThreadState`), `collapsibleState`, `canReply`; `thread.dispose()` removes.
- Comments implement `vscode.Comment`: `body`, `mode`, `author: {name}`, `contextValue`,
  `timestamp`.

## Files to modify/create

- `src/commentController.ts` — new module: controller setup, range provider, thread cache, render
  function, add-note command handler.
- `src/extension.ts` — instantiate controller; call its render from `refresh()` (after
  `treeProvider.setModel(model)` ~`extension.ts:257`); register `deltaReview.addNote`; dispose via
  subscriptions.
- `package.json` — `comments/commentThread/context` menu entry for `deltaReview.addNote`
  (title "Add Note"); command declaration; hide from palette (`when: "false"` block, pattern
  `package.json:260-301`).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Range provider (REQ-NOTE-1/5 + requirements "Commenting surface" assumption):
   - `file://` doc → repo-relative path in the current review set (callback into extension state
     `() => model`) → full-document range; else no ranges.
   - `delta-review-base` doc → ranges only when its `query` (blob sha) matches some review-set
     file's current `diffBaseSha` — this is "the diff's current base document"; stale snapshot docs
     get no *new* commenting ranges.
   - Note the provider returns ranges for the whole doc — multi-line selection then drives the range
     of a created note (REQ-NOTE-2).
2. `deltaReview.addNote` handler (`CommentReply`):
   - Derive side + repo path from `thread.uri` (file → working; delta-review-base → base, path from
     `uri.path.slice(1)`, blob from `uri.query`).
   - Read the anchored lines' text from the live `TextDocument` (`vscode.workspace.textDocuments`
     match by uri) for `snapshot`; full doc text = creation content for `contentBlob` (working side;
     base side passes the existing blob sha through — store handles both, Task 2.1 `createNote`).
   - `createNote(...)`; on success re-render (the saved note now owns the thread); on failure show
     `vscode.window.showErrorMessage("Delta Review: failed to save note (…)")` and do NOT dispose
     the pending thread — the typed text stays (REQ-NOTE-3/4, mock 2B).
3. `renderThreads(threads: NoteThread[])` — reconcile a `Map<noteId, vscode.CommentThread>`:
   - Thread URI: working side → `Uri.file(join(git.repoRoot, note.file))`; base side →
     `createReviewBaseUri(note.file, note.contentBlob)` — threads attach to the creation blob's doc,
     which is exactly the displayed base while unchanged; base-progression display comes via derived
     positions (Task 2.1) and REQ-ANCHOR-4.
   - Range from `currentStartLine/currentEndLine` (convert to 0-based `vscode.Range`).
   - One `vscode.Comment` per turn: author "You" / "Claude", `timestamp: new Date(turn.at)`.
   - `label`: status + optional flag — `"Open"`, `"Addressed"`, `"Resolved"`, plus `" • Outdated"`
     (REQ-LIFE-5; the "line was: <snapshot>" context renders in the first comment body when
     outdated — MarkdownString, mock scenario 4).
   - `contextValue`: `openNote` / `addressedNote` / `resolvedNote` (menus in Task 3.2 key off
     these); `state`: Resolved ↔ status resolved, else Unresolved; `canReply: false` for now
     (Task 3.2 enables addressed-reply).
   - Dispose threads whose note ids vanished.
4. Extension wiring: after the model is set in `refresh()`, load notes+responses via the store,
   `mergeThreads`, `refreshDerived`, then `renderThreads`. Guard with the existing generation
   counter (`extension.ts:183-205` pattern) so stale renders drop.

## Testing suggestions

- No new unit tests (all `vscode`-bound). Manual, in the F5 Extension Development Host
  (DEVELOPMENT.md manual-script style), against a repo with changes vs `main`:
  1. Open a review diff → hovering any line on either side shows `+` (mock 1).
  2. Click `+` on the right side, type, Add Note → thread renders with "Open" label; reload window →
     thread still there at the same line.
  3. Same on the left side over a deleted line (mock 3B).
  4. Multi-line selection → note spans the range.
  5. Make the notes file unwritable (`chmod -w .git/delta-review` briefly) → save shows the error
     toast, typed text intact (mock 2B).
  6. `cat .git/delta-review/notes-<branch>.json` → valid schema; `git ls-tree
     refs/review-notes/<branch>` lists the note id.

## Gotchas

- The right-side `file://` document is the same doc as the normal editor — threads will show there
  too; that's accepted behavior (requirements Assumption), don't fight it.
- `CommentReply.thread` is a *pending* thread owned by VS Code; after persisting, adopt it (set its
  comments/label) rather than disposing+recreating, or the input UX flickers.
- `provideCommentingRanges` runs for *every* open document — return fast for foreign schemes
  (settings editors, output panes).
- Don't touch existing tree/decoration code paths (REQ-PRESERVE-1); the only `extension.ts` changes
  are additive wiring.

## Verification checklist

- [ ] Manual dev-host checks 1–6 above pass.
- [ ] `yarn lint`, `yarn build`, `yarn test` pass (existing suites unaffected).
- [ ] End-to-end tests: Test exception applies ("Anything that would need an extension-host e2e
      test (no e2e infrastructure exists) — verify with unit tests plus manual verification in the
      F5 Extension Development Host"): the manual checks above are the substitute verification.
