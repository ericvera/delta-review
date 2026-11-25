# 03_02 File notes as whole-file comment threads

## Goal

Render file notes as whole-file comment threads above line 1 of the file's review diff (working side), with the same status, actions and reply box as line notes. Add the API that starts a new file-note draft thread and saves it as a file note, plus a Cancel action for that draft. General notes never render as comment threads.

## Files to modify/create

- src/noteTarget.ts (tests: src/noteTarget.test.ts)
- src/commentController.ts
- src/extension.ts
- package.json

## Background

- Task 03_01 produced:
  - `src/notes.ts`: `FileNote { scope: "file"; id; file; contentBlob; turns; status; outdated; createdAt }`, `GeneralNote`, `AnyNote`, and guards `isFileNote` / `isLineNote`.
  - `src/noteThreads.ts`: `NoteThread<N>`, `AnyNoteThread`, guards `isLineThread` / `isFileThread` / `isGeneralThread`.
  - `src/notesStore.ts`: `createNote(git, branch, { scope: "file", file, content, text, id? })`. File-note `outdated` is computed from `isInReviewSet`.
  - `src/extension.ts` passes `threads.filter(isLineThread)` to `renderNoteThreads`.
- `src/noteTarget.ts:63-121`: `noteTargetFor(model, note, workingDocumentExists)` picks working, base or document targets. `NoteTarget` carries `lines: "current" | "creation"`.
- `src/commentController.ts`:
  - `threadTargetFor` / `uriForTarget` (`:402-441`), `rangeFor` (`:451-462`), and the `ThreadEntry` cache (`:469-478`).
  - `renderThreads` (`:777-838`) creates, updates and disposes threads.
  - `reclampThreadsFor` (`:851-871`) re-applies ranges.
  - `commentsFor` (`:285-312`) adds a `*line was: …*` hint from `snapshot` for outdated notes.
  - `styleThread` (`:333+`) sets the label, contextValue and canReply.
  - `addNote(reply)` (`:887-956`) creates a line note from the pending gutter thread, adopting it into `threadCache`.
- `@types/vscode` 1.140: `createCommentThread(uri, range: Range, comments)` requires a Range, but `CommentThread.range` is `Range | undefined` and writable. A range-less thread is a file-level comment.
- package.json: the comment-thread menu `comments/commentThread/context` (`:500-516`) has `deltaReview.addNote` when `commentThreadIsEmpty`. Hidden commands go in `menus.commandPalette` with `"when": "false"` (`:517+`).
- Mock (`.mise/mock/file-note.html`):
  - Draft title `File note · <path>` with Cancel / Add Note.
  - Existing thread label shows `whole file`.
  - It is never outdated from line moves, only when the file leaves the diff.

## Guides

- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format
- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `noteTarget.ts`: `fileNoteTargetFor(model, note: FileNote, onDisk: boolean): FileNoteTarget`. `FileNoteTarget` is `{ kind: "working"; path } | { kind: "base"; path; sha }`.
  - If the model file is deleted: base `diffBasePath` / `diffBaseSha ?? note.contentBlob`.
  - Else if it is in the model or on disk: working.
  - Else: base `note.file` / `note.contentBlob`.
- `commentController.ts`:
  - `renderThreads(threads: NoteThread<Note | FileNote>[])`. For file threads, use `fileNoteTargetFor` and create at `new Range(0,0,0,0)`, then set `thread.range = undefined`. Store the entry with a marker (e.g. `lines: "file"`) so `reclampThreadsFor` and `restyle` skip range writes for it.
  - `commentsFor` skips the `line was` hint for file notes.
  - `styleThread` labels file threads `whole file` (prefixed with the status label as line threads are). In the outdated case it says `file left the diff` instead of the line wording. Read `styleThread` before changing it.
  - New `startFileNoteDraft(uri: vscode.Uri, path: string, noteId: string): void`:
    - `controller.createCommentThread(uri, new Range(0,0,0,0), [])`, then `range = undefined`.
    - `collapsibleState = Expanded`, `canReply = true`, `contextValue = "fileNoteDraft"`, `label = \`File note · ${path}\``.
    - Track it in `fileNoteDrafts: Map<CommentThread, { path, noteId }>`.
  - `addNote`: if `fileNoteDrafts.has(reply.thread)`, read the working content via `vscode.workspace.fs` / the open document text (fall back to `readFile`). Call `createNote(git, branch, { scope: "file", file: path, content, text: reply.text, id: noteId })`. Adopt the thread into `threadCache` with the file marker, delete it from `fileNoteDrafts`, style it, and call `onDidChangeNotes()`. Otherwise use the existing line-note path.
  - New `cancelNoteDraft(thread)`: dispose it and delete it from `fileNoteDrafts`.
  - Export both on `NoteCommentController`.
- `extension.ts`:
  - `renderNoteThreads` passes `threads.filter((t) => isLineThread(t) || isFileThread(t))` to `commentController.renderThreads`. The tree still gets line threads only (03_04 broadens it). The badge counts every non-resolved thread across all kinds.
  - `currentNoteThreads` holds all threads (`AnyNoteThread[]`). Widen `markRead` / `isUnread` signatures accordingly.
  - Register `deltaReview.cancelNoteDraft` → `commentController.cancelNoteDraft(thread)`.
  - Extend `__inspect` with `noteThreads: commentController.noteThreadSnapshots()`. Add that method: `{ noteId, uri, range: null | [startLine, endLine], label, contextValue }[]`.
- `package.json`:
  - Command `deltaReview.cancelNoteDraft` (title `Cancel`), in `comments/commentThread/context` with when `commentController == deltaReview.notes && commentThread == fileNoteDraft`, group `inline@0`.
  - Hide it from the palette.

## Gotchas

- `restyle` may recreate a thread (`replaceThread`) with `controller.createCommentThread(uri, range, …)`. For file threads, pass `Range(0,0,0,0)` and reset `range = undefined` after creation. Put that in one helper used by all three creation sites.
- `reclampThreadsFor` must not assign a range to a file thread.
- If a range-less thread does not render in the diff editor's modified side in the host check, fall back to `Range(0,0,0,0)` (thread after line 1) and note it in the task's report. Do not enable `CommentingRanges.enableFileComments`: creation goes only through the pane `+` (decided).
- Keep `commentingRangesFor` returning `Range[]`. No change is needed for drafts created programmatically.

## Verification

- `src/noteTarget.test.ts`: `fileNoteTargetFor` covers in-model working, deleted-in-model to base with `diffBaseSha`, deleted with no base sha to `contentBlob`, gone from model but on disk to working, and gone from both to base `contentBlob`.
- Run `yarn test`, `yarn lint`, `yarn build`.
- Scripted extension-host check (batch with 03_03 / 03_04 if run together):
  - In a temp repo with a changed `src/a.ts`, write a v3 notes file with one file note on `src/a.ts`. Its `contentBlob` comes from `git hash-object -w src/a.ts`.
  - Open the file. `__inspect().noteThreads` has that note with `range: null` and a label containing `whole file`.
  - Remove `src/a.ts` from the diff (`git checkout main -- src/a.ts`). After refresh, the notes file shows `outdated: true`.
