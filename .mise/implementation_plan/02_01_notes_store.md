# Task 2.1: Notes store — git-backed persistence, blob anchoring, derived-field refresh

## Goal

Create `src/notesStore.ts`: the single module that reads/writes the notes and responses files,
snapshots and gc-anchors note content blobs, and computes/persists derived fields (current position,
outdated, status) — with temp-repo unit tests for its pure-adjacent pieces.

## Requirements addressed

REQ-STORE-1, REQ-STORE-2, REQ-STORE-3, REQ-STORE-4, REQ-ANCHOR-2, REQ-ANCHOR-4, REQ-AGENT-9

## Background

The feature: inline review notes persisted per branch inside `.git`. Prior tasks produced:
- Task 1.1 — `src/notes.ts`: `Note`, `NotesFile`, `ResponsesFile`, `parseNotesFile`,
  `parseResponsesFile`, `notesFileName(branch)`, `responsesFileName(branch)`, load-result unions.
- Task 1.2 — `src/noteAnchor.ts`: `parseUnifiedDiffHunks`, `mapRangeThroughHunks`.
- Task 1.3 — `src/noteThreads.ts`: `mergeThreads`, `workSet`.

Existing patterns to mirror:
- Common-dir + file resolution: `loadClustersContract` `src/clusters.ts:286-317` — `git rev-parse
  --git-common-dir`, `isAbsolute` check with `join(git.repoRoot, …)` fallback, file under
  `<commonDir>/delta-review/`, ENOENT → missing, other errors → invalid with the error message.
- gc-safe blob anchoring: `writeReviewState` `src/reviewState.ts:38-87` — temp `GIT_INDEX_FILE`
  (`join(tmpdir(), "delta-review-<random>")`), `read-tree --empty`, `update-index -z --index-info`
  with lines `100644 <sha> 0\t<path>\0`, `write-tree`, `commit-tree` with previous ref tip as
  parent, `update-ref`. Blob hashing: `markReviewed` `reviewState.ts:90-120` (`hash-object -w
  --stdin-paths` / `--stdin`).
- `Git` interface `src/git.ts:3-9`: `{ repoRoot, run(args, {stdin?, env?}) }`.

Why a dedicated anchor ref: left-side notes reference merge-base or reviewed-snapshot blobs, and
`Clear Review State` deletes `refs/review/<branch>` — so notes must anchor every `contentBlob` on
their own ref, `refs/review-notes/<branch>`, to survive gc regardless of review-state clearing
(REQ-STORE-3, REQ-STORE-4).

## Files to modify/create

- `src/notesStore.ts` — new module.
- `src/notesStore.test.ts` — new unit tests (temp git repo).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `reviewNotesRefForBranch(branch)` → `refs/review-notes/<branch>` (mirror `reviewRefForBranch`
   `reviewState.ts:13`).
2. `loadNotes(git, branch)` / `loadResponses(git, branch)` → clusters-style results (missing /
   invalid+error / ok+file), using Task 1.1 parsers and filenames. Directory may not exist —
   ENOENT → missing.
3. `saveNotes(git, branch, file: NotesFile)`:
   - Serialize with `JSON.stringify(file, null, 2)` + trailing newline (agent-readable).
   - `mkdir` the `delta-review` dir recursively, write atomically (write temp file in same dir,
     rename over).
   - **Idempotence guard** (REQ-AGENT-9 without watcher loops): keep the last-written string per
     path in module state; also compare against current on-disk content before writing — skip when
     identical.
   - Never write when the on-disk file is present but unparsable (REQ-AGENT-8 read-only-broken is
     enforced by callers holding no `NotesFile` to save — assert by loading first in the mutation
     helpers below).
4. Mutation helpers (all: load → modify → save + anchor):
   - `createNote(git, branch, draft)` — draft carries file/side/lines/snapshot/current content
     string; hash content via `hash-object -w --stdin` → `contentBlob`; id `crypto.randomUUID()`;
     first reviewer turn; status open; derived fields = creation values; then `anchorBlobs`.
   - `appendReviewerTurn`, `editReviewerTurn`, `deleteNote` (whole thread), `setResolved(id,
     resolved)` — resolved sets status "resolved"; unresolve recomputes via `mergeThreads` last
     speaker.
5. `anchorBlobs(git, branch, notes)` — write the commit-tree on `refs/review-notes/<branch>` with
   one entry per note: path = note id, sha = `contentBlob` (dedup by sha is automatic). Mirror
   `writeReviewState` exactly, including the temp-index cleanup in `finally`. Call after any
   mutation that adds/changes `contentBlob`s; deleting the last note may delete the ref
   (`update-ref -d`, tolerate absence — mirror `clearReviewState` handling `extension.ts:662-666`).
6. `refreshDerived(git, branch, notesFile, responses, workingContentReader)` — the REQ-AGENT-9 pass:
   - For each note: resolve the current side-document blob — working side: hash current working-tree
     content (`hash-object -w --stdin` so the comparison blob is also anchored-able; skip for
     missing file → outdated, keep last position, REQ-ANCHOR-5 semantics come in Task 3.3); base
     side: the file's current `diffBaseSha` (passed in by the caller; extension supplies it from
     `ReviewModel` — `model.ts:28`).
   - `contentBlob === currentBlob` → derived = stored creation lines, outdated false (short-circuit,
     no diff).
   - Else `git diff -U0 <contentBlob> <currentBlob>` → `parseUnifiedDiffHunks` →
     `mapRangeThroughHunks` → `currentStartLine/currentEndLine/outdated` (REQ-ANCHOR-2/4).
   - Status: from `mergeThreads` (derived addressed/open; stored resolved wins).
   - Anchor relocation persistence is Task 3.3's concern — here only compute; accept a hook so 3.3
     can apply `effectiveAnchor` before persisting.
   - Persist via `saveNotes` only if anything changed (guard above). If any `contentBlob` changed in
     this pass (anchor application re-snapshots, and working-side comparison blobs are written with
     `-w`), call `anchorBlobs` before returning — a loose replacement blob is prunable and a later
     `git gc` would break re-anchoring for exactly the relocated notes (REQ-STORE-3).
7. Export everything the UI layers need; keep `vscode` out of this module (Node + `Git` only) so the
   temp-repo tests run under Vitest.

## Testing suggestions

- `src/notesStore.test.ts` with a real temp git repo (this goes beyond the fake-`Git` style of
  `clusters.test.ts:558-641` because ref/blob behavior is the point): `mkdtemp`, `git init -b main`,
  one committed file; `createGit(tmp)` from `src/git.ts`.
  - save/load round-trip; missing → `{state:"missing"}`; corrupt JSON → invalid with error;
  - `createNote` writes the blob (verify `git cat-file -e <sha>`), the ref exists and its tree lists
    the note id (`git ls-tree`);
  - blobs survive `git gc --prune=now` with `refs/review/<branch>` deleted (REQ-STORE-3/4);
  - idempotent `saveNotes` (second save leaves mtime/content identical — assert by content read and
    by spying that no write occurred via the module's guard);
  - `refreshDerived`: unchanged content short-circuits; an edit above the note shifts lines; an edit
    on the note sets outdated (uses real `git diff -U0` output);
  - `setResolved` + unresolve status recomputation.
- Run `yarn test`.

## Gotchas

- `git diff <shaA> <shaB>` with two blob shas prints a blob-vs-blob diff — no `--no-index`, no
  paths. Verify the hunk header format in a test fixture before relying on the parser.
- `hash-object -w` must run with `-w` everywhere a sha is later referenced from the ref tree —
  a non-written hash would leave a dangling tree entry.
- Atomic write: rename within the same directory only (cross-device rename fails).
- The watcher (`extension.ts:325-353`) fires on these writes; the idempotence guard is what prevents
  refresh→write→refresh loops. Test the guard.
- Branch names with `/` sanitize in *filenames* but stay raw in *ref names* (refs allow `/`).

## Verification checklist

- [ ] `yarn test` passes including the temp-repo store suite.
- [ ] `yarn lint` and `yarn build` pass.
- [ ] End-to-end tests: Test exception applies (no e2e infrastructure exists): temp-repo unit tests
      above are the verification; UI integration is exercised from Task 3.1 onward in the dev host.
