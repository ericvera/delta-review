# Spec: per-branch diff base, notes from the pane, responsive marks

## What

- **Per-branch diff base.** Each branch has its own diff base, shared by every worktree on that branch. Resolution order: explicit base (set in the status-bar picker or by an agent through a documented contract file), else auto-detected (closest local branch HEAD forked from, else a differently-named upstream), else the `deltaReview.baseBranch` setting (default `main`). A new status-bar item `$(git-compare) ← <base>` opens the picker; its tooltip names the source. A stored or detected base that is fully merged into the fallback raises a Switch / Keep / Choose… prompt, never a silent switch. An explicit base that no longer resolves shows a tree message linking to the picker. `delta:cluster` computes the same base.
- **Notes from the pane.** A `+` in the Review Notes title bar offers "File note" (whole-file thread at the top of the active file's diff; disabled with a reason when the active file is not in the diff) or "General note" (no file; opens its own conversation tab). General notes group above file groups; file notes sort first in their file group and show `file` instead of `:<line>`. Notes file goes to version 3; the review-notes skill documents both kinds.
- **Responsive marks.** Mark/unmark updates the row, badge and counter immediately; a failed write rolls back with an error offering Retry and Show Log. The extension's own review-ref writes no longer restart the refresh debounce; the debounce gets a max wait; `refs/review/<branch>` and `refs/review-predeletion/<branch>` writes use compare-and-set with retry; the silent no-ops of the mark commands report why.

## Design

### Per-branch diff base

- **Contract file** (agent-settable, extension-written): `<git common dir>/delta-review/base-<sanitized-branch>.json`, `{ "version": 1, "base": "<ref>" }`. `base` is any ref `git rev-parse --verify "<ref>^{commit}"` accepts. Sanitization is `sanitizeBranchForFilename` (`src/clusters.ts:234`). Present = explicit base. Absent = automatic. Invalid (bad JSON, wrong version, empty `base`) = treated as absent, with the parse error in the base item tooltip. The extension overwrites it only on a user pick, Switch or Keep, and deletes it only on "Use automatic detection". Writes are atomic: temp file in the same dir, then rename. The existing contract-dir watcher (`{*.json,...}`, `src/extension.ts` `watchContractDir`) already refreshes on its changes. The contract is owned by `plugin/skills/cluster/SKILL.md` (new Contract section "Diff base").
- **Detection** (`src/diffBase.ts`, vscode-free):
  - When the branch is the fallback itself (or detached), detection is skipped and the source is `fallback`: on `main` no feature branch is ever picked as base.
  - Candidates are `git for-each-ref --format='%(refname:short) %(objectname)' refs/heads` in output (refname) order, excluding the current branch.
  - For each candidate: `mb = git merge-base <c> HEAD`; a failure skips it. Skip it when `mb == HEAD` and its tip `!= HEAD`, since it is a descendant of the current branch. Distance is `git rev-list --count mb..HEAD`.
  - The smallest distance wins. A tie goes to the fallback name, otherwise the earlier candidate keeps it.
  - With no candidate, use the upstream (`git rev-parse --abbrev-ref @{upstream}`) when it does not end in `/<current branch>` and has a merge-base with HEAD.
  - Results are cached in memory keyed by `HEAD sha + for-each-ref output + upstream + fallback`, so a steady-state refresh costs 3 git spawns. The cache is cleared on repo switch.
  - On a tie the fallback wins, so a merge-merged parent detects as the fallback, and a detected base is effectively never stale.
- **Resolution** returns `BaseResolution = { branch, base, source: "explicit" | "detected" | "fallback", detectedVia?: "forkPoint" | "upstream", fallback, missing: boolean, stale: boolean, fileError?: string, suggestions: { forkPoint?, upstream?, fallback } }`. `missing` is set when an explicit base fails `rev-parse --verify --quiet <base>^{commit}`. `stale` is true when the source is explicit or `detected` via `forkPoint` (never via `upstream`: `origin/main` lagging local `main` is not a merged parent), `branch !== fallback`, `base !== fallback`, base is a branch (`refs/heads/<base>` or `refs/remotes/<base>` exists), and `git merge-base --is-ancestor <base> <fallback>` succeeds.
- **Wiring.** `refresh()` (`src/extension.ts:405`) resolves the branch, then the base, then calls `computeReviewModel(git, resolution.base, …)`. `computeReviewModel`'s merge-base error drops the setting hint (`src/model.ts:608`). A missing explicit base skips the model: the tree is empty, `treeView.message` reads `⚠ Base <base> for branch <branch> does not resolve.`, context key `deltaReview.baseMissing` shows a `viewsWelcome` with `[Choose a base](command:deltaReview.setBranchBase)` and `[Use automatic detection](command:deltaReview.useAutomaticBase)`, the counter item hides, and the base item shows the error tint.
- **Status bar.** The new `baseStatusItem` sits left-aligned at priority 49, right after the counter (priority 50). Its text is `$(git-compare) ← <base>`, or `$(warning) ← <base>` while stale. Background is `statusBarItem.warningBackground` while a stale prompt is unanswered, `statusBarItem.errorBackground` when missing. The command is `deltaReview.setBranchBase`. Text and tooltip come from a pure builder in `src/diffBaseUi.ts`. The counter tooltip becomes `Delta Review: <branch> vs <resolved base>`.
- **Picker** (`src/basePicker.ts`, UI only; items from `src/diffBaseUi.ts`):
  - Command "Delta Review: Set Diff Base for Branch" (`deltaReview.setBranchBase`) opens a QuickPick with sections `suggested` (detected fork point, upstream, fallback), `local branches`, then `Enter a ref…` and `Use automatic detection` (the latter only with an explicit base).
  - The current base is marked `$(check)`. A typed value matching no item adds `Use ref '<typed>'`. `Enter a ref…` opens an InputBox validated as the user types (`'<ref>' is not a valid ref in this repository.`).
  - Picking writes the contract file. "Use automatic detection" deletes it. Both refresh.
  - On detached HEAD the command shows `Delta Review: detached HEAD has no branch to set a base for.`.
- **Stale prompt.**
  - When `resolution.stale` is true and the pair is neither suppressed nor already prompting, show a warning: `Base <base> is fully merged into <fallback>. Switch the diff base for <branch> to <fallback>?` with actions `Switch to <fallback>` / `Keep <base>` / `Choose…`.
  - Switch writes the fallback as explicit. Keep writes the old base as explicit and suppresses the pair. Choose… opens the picker with the fallback first. Dismissal, or a cancelled Choose…, suppresses the pair.
  - Suppression is `context.workspaceState` key `deltaReview.staleBaseDismissed`: `{ [commonDir + "\0" + branch]: base }`. A different base for the branch un-suppresses. A pick in the picker also suppresses its own pair, so knowingly choosing a merged branch never prompts.
- **Base-side notes** go outdated through the existing merge-base logic, with no warning (decided).
- **Docs.** `plugin/skills/cluster/SKILL.md` gets a Contract "Diff base" section: file format, set/clear commands, and the resolution order with a shell snippet reproducing detection exactly. Workflow step 1 references it. README Settings and Usage, and DEVELOPMENT.md (lines 29, 74, 256-262 plus a "Diff base" subsection) move to the per-branch model. `deltaReview.baseBranch` stays as the fallback; its `package.json` setting description says so.

### Responsiveness

- **Compare-and-set** (`src/reviewState.ts`):
  - `writeSnapshotTree` takes the commit it read (`expectedOld: string | undefined`) and runs `git update-ref <ref> <new> <old>`, with `""` for "must not exist" (verified: git rejects with "reference already exists" / "is at X but expected Y"; a concurrent writer holding the lock gives "cannot lock ref … File exists").
  - A failed update-ref whose ref now differs from `expectedOld`, or whose error is `cannot lock ref … File exists` (lock held by another writer), throws `ReviewStateConflictError`. Every public mutation (`markReviewed`, `unmarkReviewed`, `clearAllReviewSnapshots`) re-reads and retries its whole read-modify-write up to 3 attempts, then rethrows the conflict.
  - The `refs/review-slices` anchor is unchanged: it is rebuilt from each refresh's own set.
- **Refresh scheduling** (`src/refreshScheduler.ts`, vscode-free):
  - `createRefreshScheduler({ delayMs: 400, maxWaitMs: 1500, run, timers })` gives a trailing debounce that fires at most `maxWaitMs` after the first unserved `schedule()`.
  - `isSelfWriteEventPath(path)` is true for paths with a `/.git/` segment followed by `refs/review`, `logs/refs/review`, or a `*.lock` of those. The repo watcher (`src/extension.ts` `watchRepo`) drops such events.
  - `headFingerprint(state)` covers HEAD name and commit. Git `state.onDidChange` schedules a refresh only when the active repo's fingerprint changed (`GitRepository.state.HEAD` typed in `src/gitExtensionApi.ts`).
  - Focus, save and config events go through the scheduler unchanged.
  - Trade-off: another window's mark on the same branch shows on the next focus, save or HEAD change rather than instantly.
- **Optimistic marks** (`src/optimisticModel.ts`, pure): `withReviewStatus(model, paths, reviewed)` returns a copy with those files' `status` / `hasReviewSnapshot` set. `revertReviewStatus(model, prior)` restores captured `{ path → { status, hasReviewSnapshot } }`.
  - `applyReviewStateChange(action, mutate, optimistic?)` publishes the optimistic model (tree, badge, counter) before enqueueing, with no `withProgress`. On success it refreshes. On failure it reverts on the current model, refreshes, and shows `Could not <action> <subject>: <reason>. Your mark was undone.` with `Retry` (re-runs the command's change) and `Show Log` (new OutputChannel "Delta Review", which receives the full error). A `ReviewStateConflictError` reason reads `the review state changed in another window and the retry also failed`.
  - In-flight refreshes: right before the optimistic publish, `applyReviewStateChange` bumps `refreshGeneration`, so a refresh that read pre-write state bails instead of flipping the row back; the command's own `refresh()` publishes next. This is the only generation rule for the optimistic path.
  - `publishModel(model)` sets the tree, badge and counter. `publishCount` (exposed on `__inspect`) counts refresh publishes only: it increments in `refresh()` beside its `publishModel` call, never inside `publishModel`, so the optimistic publish does not count and a mark adds exactly one.
  - Applies to file, folder, cluster, auto, mark-all and unmark-all.
- **No-op reasons**:
  - Mark or unmark with no model: `Delta Review: the review is still loading — try again in a moment.`
  - Mark or unmark on a non-file element: `Delta Review: select a file row to mark it reviewed.`
  - Unmark without a snapshot: `Delta Review: <path> has no reviewed snapshot to drop.`

### Notes from the pane

- **Contract v3** (`src/notes.ts`):
  - Types are `Note` (existing line/document note, unchanged), `FileNote = { scope: "file", id, file, contentBlob, turns, status, outdated, createdAt }`, `GeneralNote = { scope: "general", id, turns, status, outdated, createdAt }`, and `AnyNote = Note | FileNote | GeneralNote`. `NotesFile.notes: AnyNote[]`, `version: 1 | 2 | 3`.
  - Only version 3 reads `scope`. A scoped note carries no `side`, line fields, `snapshot`, `document` or `appliedAnchorAt`. A general note also has no `file` and no `contentBlob`.
  - `notesFileVersion` returns 3 if any scoped note, else 2 if any document note, else 1.
  - Code term: "scope". User-facing term: "General note" / "File note".
- **Threads** (`src/noteThreads.ts`): `NoteThread<N extends AnyNote = Note>`, `AnyNoteThread = NoteThread<AnyNote>`. `mergeThreads` returns `AnyNoteThread[]`, with guards `isLineThread`, `isFileThread`, `isGeneralThread`. Scoped threads never get `effectiveAnchor` applied: a response `anchor` on them is ignored.
- **Store** (`src/notesStore.ts`):
  - `createNote` accepts `NoteDraft | FileNoteDraft { scope: "file", file, content, text, id? } | GeneralNoteDraft { scope: "general", text, id? }`. The optional pre-allocated `id` lets the general-note tab and the file-note draft adopt their thread.
  - `anchorBlobs` anchors every note that has a `contentBlob`.
  - `refreshDerived` skips scoped notes in anchor application. A file note's `outdated` = `!isInReviewSet(file)` (new optional `RefreshOptions.isInReviewSet`, defaulting to "working content exists"). A general note keeps `outdated: false`.
- **File-note threads** (`src/commentController.ts`, `src/noteTarget.ts`):
  - `fileNoteTargetFor(model, note, onDisk)`: a model file that is deleted → its base document; on disk → working file; else → base document at `contentBlob`.
  - The thread is created at `Range(0,0,0,0)`, then `thread.range = undefined` (a file-level comment above line 1).
  - `startFileNoteDraft(workingUri, path)` creates an empty, expanded, range-less thread with `contextValue = "fileNoteDraft"`. `addNote` treats a range-less pending thread as a file note.
  - New comment-thread command `deltaReview.cancelNoteDraft` (when `commentThread == fileNoteDraft`) disposes it.
  - The thread label is `whole file`. General notes never render as comment threads.
- **General-note tab** (`src/generalNotePanel.ts` vscode UI, `src/generalNoteHtml.ts` pure HTML):
  - One `WebviewPanel` per note id, reused (`reveal`), titled with the first line truncated, icon `$(comment-discussion)`. It holds a header (first line, status, Resolve/Unresolve, Delete), a meta line (`General note · branch <b> · created <date>`), turns (markdown via `markdown.api.render`, escaped-text fallback), Mark Read when pending-unread, and a reply box.
  - Draft mode (`New General note`, `Not tied to a file · branch <b>`) shows Add Note / Cancel. Add Note creates the note with the panel's pre-allocated id and retitles. Cancel closes.
  - Strict CSP with a nonce. Reply text survives re-render through `vscode.setState`.
  - Each panel records its repo root and branch, and acts on those, never the active repo. On each successful render for its repo+branch the panel updates, and closes if its note is gone.
- **Pane** (`src/notesGrouping.ts`, `src/notesTreeProvider.ts`):
  - Groups are `{ kind: "general", threads }` first (label `General notes`, icon `comment-discussion`, collapse key `notesGeneral`), then branch overview, cluster notes and code groups as today.
  - Within a file group, file notes (by `createdAt`) come before line notes (by `currentStartLine`). File rows have description `file` (plus `⚠` if outdated). General rows have no description, and their command is `deltaReview.openGeneralNote`. Row actions are unchanged.
  - Clear Resolved covers every thread. Its archive entries are the removed notes exactly as they stood in the notes file, so file and general notes enter the archive scope-shaped (no `snapshot`).
  - Welcome text becomes: `No review notes on this branch.\nClick + above to add a file or general note, or hover a line in a review diff and click + to add a line note.`
- **Create** (`deltaReview.newNote`, `$(add)`, `view/title` `navigation@-1` on `deltaReviewNotes`): the QuickPick offers `File note` (description: path, detail `whole-file thread at the top of the diff`) and `General note` (`not tied to a file`). Availability comes from pure `fileNoteAvailability(active: { scheme, fsPath, path } | undefined, repoRoot, files: { path, deleted }[], baseScheme: string)` (`src/newNoteChoice.ts`; `extension.ts` passes the active tab's URI fields, the model's files and `REVIEW_BASE_SCHEME`), which returns `{ path } | { reason }` with these reasons:
  - `No file is open in the editor`
  - `<path> is not changed on this branch`
  - `<path> is deleted on this branch`
  - `Open a file from the Delta Review diff`

  A disabled item cannot be accepted, and the active item starts on General note. File note opens the diff and starts the draft. General note opens a draft tab.
- **`openNoteInDiff`** for a file note opens the diff (no selection) and expands the thread. Off the review set it opens the file-note target document.
- **Archive stays version 1** (decided). The archive's shell (`{ version, notes }`) is unchanged and its parser validates only the shell; entries were always "the note as it stood in the notes file plus `deletedAt`", which already admitted v2 document-note shapes without a bump. SKILL.md's archive section is amended: entries take any notes-file note shape; a line note's text record is `snapshot`, a scoped note's is its `turns` (plus `file` for a file note). The Schema-changes rule gains that archive entries follow the notes-file schema and need no archive bump of their own. `archiveNotes` takes `readonly AnyNote[]`.
- **Docs.** `plugin/skills/review-notes/SKILL.md` covers v3, `scope`, file and general note semantics, ignored anchors, and work-set order (general first, then by file with file notes before line notes). README and DEVELOPMENT.md cover the notes pane.

### Removed

- The `withProgress` wrapper around review-state commands is removed in task 02_03.
- The `deltaReview.baseBranch` "Check the setting" hint in the merge-base error is removed in task 01_02.
- The cluster skill's `.vscode/settings.json`-only base rule is replaced in task 01_05.

## Hard-to-undo

- Notes file schema version 3 (`notes-<branch>.json` written at `version: 3` once a file or general note exists). Extensions without v3 support reject such a file. This is a public contract change in `plugin/skills/review-notes/SKILL.md`.
- Review-note archive (`archive-<branch>.json`, append-only) receives scope-shaped file/general note entries while staying `version: 1`. Once appended they cannot be rewritten; the archive contract text in `plugin/skills/review-notes/SKILL.md` changes accordingly.
- New public agent contract file `<git common dir>/delta-review/base-<sanitized-branch>.json` (version 1), documented in `plugin/skills/cluster/SKILL.md`, written and deleted by the extension.
- `refs/review/<branch>` and `refs/review-predeletion/<branch>` writes switch to compare-and-set with retry. The data format is unchanged, but the writes go to persistent shared state.

## Task index

| Task file | What it does | Files |
| --- | --- | --- |
| 01_01_diff_base_module.md | Base contract file I/O, detection, resolution and stale check | src/diffBase.ts |
| 01_02_resolve_base_in_refresh.md | Refresh uses the resolved base; base status-bar item and tooltips; missing-base message | src/extension.ts, src/model.ts, src/diffBaseUi.ts |
| 01_03_base_picker.md | Set Diff Base picker, Use automatic detection, missing-base welcome links | src/basePicker.ts, src/diffBaseUi.ts, src/extension.ts, package.json |
| 01_04_stale_base_prompt.md | Stale-base prompt with suppression and warning tint | src/diffBaseUi.ts, src/extension.ts |
| 01_05_base_docs.md | Cluster skill Diff base contract, README, DEVELOPMENT.md, baseBranch setting description | plugin/skills/cluster/SKILL.md, README.md, DEVELOPMENT.md, package.json |
| 02_01_review_state_cas.md | Compare-and-set with retry on review-state refs | src/reviewState.ts |
| 02_02_refresh_scheduler.md | Debounce with max wait; ignore own ref writes and non-HEAD git events | src/refreshScheduler.ts, src/extension.ts, src/gitExtensionApi.ts |
| 02_03_optimistic_marks.md | Immediate row update, rollback with Retry/Show Log, no-op reasons | src/optimisticModel.ts, src/extension.ts, DEVELOPMENT.md |
| 03_01_notes_v3_contract.md | Notes v3 types/parser, scoped threads, store support | src/notes.ts, src/noteThreads.ts, src/notesStore.ts, src/pendingRead.ts, src/extension.ts |
| 03_02_file_note_threads.md | File notes render as whole-file threads; file-note draft and cancel | src/noteTarget.ts, src/commentController.ts, src/extension.ts, package.json |
| 03_03_general_note_tab.md | General note conversation tab (webview) with draft mode | src/generalNotePanel.ts, src/generalNoteHtml.ts, src/extension.ts, package.json |
| 03_04_notes_pane_create.md | General notes group, file-note rows, pane + command, open file notes | src/notesGrouping.ts, src/notesTreeProvider.ts, src/newNoteChoice.ts, src/extension.ts, package.json |
| 03_05_notes_docs.md | Review-notes skill v3 and archive contract, README, DEVELOPMENT.md | plugin/skills/review-notes/SKILL.md, README.md, DEVELOPMENT.md |
