currently it seems like the base commit/branch on a diff is always main or set per config. Different worktrees may need different base branches and also the branch may change over the like of a branch if another branch gets merged into main (for example).

## Investigation

- Base resolved once per refresh from setting `deltaReview.baseBranch` (default `"main"`), src/extension.ts:424; passed to `computeReviewModel` (extension.ts:464, 502); shown in status bar tooltip (extension.ts:592). Declared package.json:642-646, documented README.md:105.
- src/model.ts:574-610 computes `git merge-base <base> HEAD`; error message points at the setting (model.ts:608). `ReviewModel.mergeBase` at model.ts:110.
- Setting change refreshes via `onDidChangeConfiguration` (extension.ts:2165-2169); a per-branch store needs its own refresh trigger.
- Per-branch state pattern: keyed by branch name under the git common dir, shared across worktrees — `deltaReviewDirFor` (src/documents.ts:97), `refs/review/<branch>` (src/reviewState.ts:13), `refs/review-notes/<branch>` (src/notesStore.ts:42), `sanitizeBranchForFilename` (src/clusters.ts:234). Per-branch storage covers per-worktree bases since worktrees sit on different branches.
- `context.workspaceState` (extension.ts:136-173) is per-workspace, not per-branch.
- Active repo/worktree switches via `setActiveRepo` (extension.ts:898), driven by SCM selection (extension.ts:2240-2294).
- Left-side review notes anchor merge-base blobs (notesStore.ts:36-40, src/noteTarget.ts:99-103); a base change can outdate base-side notes. Reviewed snapshots are content-based (model.ts:353-396) and survive.
- `delta:cluster` skill reads its base only from `deltaReview.baseBranch` in `.vscode/settings.json` (plugin/skills/cluster/SKILL.md:207-217); contract must learn the per-branch base. review-notes skill needs no base (plugin/skills/review-notes/SKILL.md:39).
- Docs stating a fixed base: DEVELOPMENT.md:29, :74, :256-262.
- `GitRepository` typing exposes no upstream/branch info (src/gitExtensionApi.ts:8-23); detection needs direct `git` calls.
- Tests: temp-repo tests for `computeReviewModel` at src/model.test.ts:959, :1080. Put base resolution in a new vscode-free module with colocated test; scripted host check for wiring (DEVELOPMENT.md:238-251).
- A base picker command/button triggers the UI mock condition.

## Decisions

- All three pieces of work (per-branch base, notes created from the pane, mark-reviewed responsiveness) ship on this branch.
- Base is per branch, shared by every worktree on that branch. Resolution order: an explicit per-branch base (set by the user or an agent), else auto-detected base (closest local branch HEAD forked from, or the upstream), else `deltaReview.baseBranch`.
- User sets/overrides a branch's base with a status-bar picker.
- Agents can set a branch's base too, through a documented contract (owned by a plugin skill doc), so an agent creating or driving a branch can declare its base without the UI.
- Stale base (stored or detected base fully merged into the fallback base, e.g. parent branch merged into `main`): show a prompt offering to switch to the fallback; never switch silently.
- Base change outdates some base-side review notes: accepted, they show as outdated as today when the merge-base moves; no warning.
- `delta:cluster` must compute the same base the extension uses.

## Assumptions

- Responsiveness: a mark updates its row immediately (optimistic), rolled back with an error if the write fails; the extension's own ref writes do not restart the debounce or supersede the command's refresh; the debounce gets a max wait; review-state ref writes use compare-and-set with retry so concurrent windows/worktrees cannot drop a mark; the silent no-ops report why.
- The agent-facing mechanism (git config key vs. file under the git common dir, which skill doc owns it) is left to the spec; it must be readable by `delta:cluster` and settable without the extension running.
- Dismissing the stale-base prompt suppresses it for that branch/base pair until the base changes.
- Docs (README, DEVELOPMENT.md, cluster SKILL.md) are updated to the per-branch model; `deltaReview.baseBranch` stays as the fallback.
- Mock: a separate status-bar item `$(git-compare) ← <base>` opens the picker; the review counter still focuses the view.
- Mock: command "Delta Review: Set Diff Base for Branch"; picker offers suggestions, local branches, "Enter a ref…" (validated), "Use automatic detection".
- Mock: stale-base prompt offers Switch / Keep / Choose…; Keep saves the old base as explicit for the branch.
- Mock: tooltips name the base's source (explicit / detected / fallback), not whether a user or agent set it.
- Mock: a missing base ref shows a tree message linking to the picker.

## Added scope (owner, during goals)

we should also add in this branch the ability to add review notes directly in the "Review Notes" section of the pane. Perhaps those could be attached to a given file or just be floating (this would need new UI - maybe and 'notes view' that has notes with no file?.

- Investigate: how the "Review Notes" section of the pane is built today, how notes are created/stored/anchored (notes contract), and what a file-level or floating (no file) note would need in storage, the notes/responses contracts, and the review-notes skill.

### Investigation (added scope)

- Pane: `deltaReviewNotes` view package.json:27; welcome text "click + in a diff" :33-37; title action Clear Resolved only :291-294; row actions :413-450. Provider src/notesTreeProvider.ts:76, elements fileGroup/note only (:16-31), [] when empty (:101-107); fed by `setThreads` (src/extension.ts:361, :371).
- Grouping src/notesGrouping.ts:19-49 by (document, file), order branch → clusterNotes → code (:13-14), rows by `currentStartLine` (:45-46); rows show `:<line>` (notesTreeProvider.ts:164).
- Creation only via Comments API gutter `+`: `commentingRangesFor` (src/commentController.ts:220-255) returns `Range[]`; `createNote` from reply handler (:923). No pane create command.
- Store: `createNote` (src/notesStore.ts:444-472) needs `NoteDraft.content`, hashes to `contentBlob`, start/end lines (:425-441); `anchorBlobs` on `refs/review-notes/<branch>` (:336-395); data `<common dir>/delta-review/notes-<branch>.json` (src/notes.ts:115).
- `parseNote` requires non-empty `file` (notes.ts:151), `side` (:154), lines >= 1 (:176-184), snapshot array (:185), `contentBlob` (:188). `refreshDerived` flags outdated when file missing (notesStore.ts:740-756).
- Any notes-file change needs a `version` bump + parser update in the same commit (plugin/skills/review-notes/SKILL.md:147); older extensions strip unknown keys. `notesFileVersion` picks 1|2 (notes.ts:375-376, used notesStore.ts:213) → this is v3. Responses file unchanged (keyed by `noteId`, notes.ts:69-76).
- Threads render only as CommentThreads on a URI from `noteTargetFor` (src/noteTarget.ts:63-121) via `renderThreads`/`rangeFor` (commentController.ts:777-798, :451-456); floating notes have no URI → need a new surface (mock condition).
- `@types/vscode` ^1.140: `CommentThread.range` may be undefined (file-level comment) and `CommentingRanges.enableFileComments` exists; provider must return `CommentingRanges`.
- `document: "branch"` notes attach to the Branch overview markdown (notes.ts:17, :157-175), which exists only when the cluster skill wrote it (src/documents.ts:121-123).
- `deltaReview.openNoteInDiff` (extension.ts:1617-1664) assumes file+line or document note (`openDocumentNote` ~:1320-1335).
- review-notes SKILL.md: `snapshot` authoritative locator (:71), side/document semantics (:72-77), work-set order by file/line (:154) — must document file-level/floating notes and ignored response `anchor` on them.
- Docs: README.md:75-96, DEVELOPMENT.md:175, :204, :226, :315-318.
- Tests: src/notes.test.ts, notesGrouping.test.ts, notesStore.test.ts, noteTarget.test.ts; scripted host check for create command and tree.

## Open questions

1. File-level note form.
2. Where floating notes and their replies render.
3. How notes are created from the pane.

## Added scope 2 (owner, during goals)

Als, currently... updates like marking a file reviewed often takes a few seconds and sometimes even fails and I have to mark it reviewed a couple of times. Like some sort of race condition. Any way to make things more responsive?

- Investigate: the mark-reviewed path end to end (command → review state write → refresh → tree update), where the seconds go, and what race can drop a mark; try to reproduce.

### Investigation (added scope 2)

- Not reproduced outside VS Code: on a 58-file diff `markReviewed` ~47 ms (9 git spawns), warm `computeReviewModel` ~44 ms. The seconds come from the refresh/event pipeline, not git.
- Path: `deltaReview.markFileReviewed` (src/extension.ts:1554-1572) → `applyReviewStateChange` (:801-817): `withProgress` → `reviewStateQueue.run(mutate)` → full `refresh()`; tree updates only at `treeProvider.setModel` (:571), full re-render (src/treeProvider.ts:186-189).
- Mutation src/reviewState.ts:121-170 (temp index, write-tree/commit-tree/update-ref :39-87), no compare-and-set (:83).
- Likely cause: the ref write fires the repo watcher (extension.ts:846-856) and git `state.onDidChange` (:2258-2262) → `scheduleRefresh`, a 400 ms trailing debounce, no max wait, reset by each event (:828-834). That refresh bumps `refreshGeneration` (:406), so the command's own refresh bails at generation checks (:474, :539, :565) and publishes nothing → visible latency = git status + 400 ms + a second full refresh. Focus (:2160-2163) and saves (:2146) also reset the timer.
- Each refresh then runs slice anchoring in the shared queue (:526-535; src/sliceAnchor.ts:51-111) — a click during it waits — and notes refresh does one `hash-object -w` per working-side note plus a `git diff` per moved note (src/notesStore.ts:765-794).
- Apparent "failed" mark: the row keeps the needs-review `+` (package.json:313-317) until a refresh publishes, so the user clicks again (harmless extra write + cascade).
- No in-window lost write (all writes via `createSerialQueue`, extension.ts:394; src/serialQueue.ts:9-24). Real loss possible across processes (another window/worktree on the same branch, external writer): `update-ref` lacks compare-and-set (reviewState.ts:83, sliceAnchor.ts:107).
- Unverified: full-tree re-render on each `setModel` or the focus-triggered refresh may swap the row under the pointer and swallow an inline click (needs host run).
- Silent no-op when `model === undefined` or element not a file (extension.ts:1556-1561).
- refs/review/<branch> and refs/review-predeletion/<branch> are persistent shared state (reviewState.ts:13, :20); refresh-pipeline changes are in-memory only.
- Tests: refresh coalescing/scheduling in a new vscode-free module with colocated test (beside serialQueue.test.ts); cross-process compare-and-set case in src/reviewState.test.ts; scripted host check for wiring/latency (DEVELOPMENT.md:238-251).
