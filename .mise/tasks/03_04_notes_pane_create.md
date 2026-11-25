# 03_04 Review Notes pane: General notes group, file-note rows, `+` command

## Goal

Make the Review Notes pane:

- show general notes in a "General notes" group above the file groups
- show file notes first in their file's group, with the description `file`
- let the user create notes from a `+` in the pane title bar, which offers "File note" (for the active editor's file; disabled with a reason when not possible) or "General note"

Clicking a file-note row opens the file's diff with the whole-file thread expanded. Clicking a general-note row opens its tab.

## Files to modify/create

- src/notesGrouping.ts (tests: src/notesGrouping.test.ts)
- src/notesTreeProvider.ts
- src/newNoteChoice.ts (new, pure; test: src/newNoteChoice.test.ts)
- src/extension.ts
- package.json

## Background

- Task 03_01: `AnyNoteThread` plus `isLineThread` / `isFileThread` / `isGeneralThread` (`src/noteThreads.ts`). `FileNote` and `GeneralNote` (`src/notes.ts`).
- Task 03_02:
  - `commentController.startFileNoteDraft(uri, path, noteId)` and `fileNoteTargetFor(model, note, onDisk)` (`src/noteTarget.ts`).
  - `renderNoteThreads` passes line+file threads to the comment controller and only line threads to the tree.
  - `commentController.expandThread(noteId)` exists.
- Task 03_03: commands `deltaReview.openGeneralNote(thread)` and `deltaReview.newGeneralNote()`.
- `src/notesGrouping.ts`:
  - `NoteGroup { document?; file; threads }`, `groupNoteThreads` (`:19-49`) ranks branch → clusterNotes → code and sorts rows by `currentStartLine`.
  - `notesGroupCollapseKey` (`:76-82`) yields `notes:<file>` / `notes:<doc>:<file>`.
- `src/notesTreeProvider.ts`:
  - Elements `fileGroup` and `note` (`:16-31`).
  - `getChildren` returns `[]` when empty so `viewsWelcome` renders (`:101-107`).
  - `getTreeItem` row description is `:<currentStartLine>` (`:164`), and the row command is `deltaReview.openNoteInDiff`.
- `src/extension.ts`:
  - Collapse handlers check `event.element.kind === "fileGroup"` (`:282-293`).
  - `deltaReview.openNoteInDiff` (`:1617-1680`) handles document and line notes.
  - `openDiff(file, selection?)` and `revealFileRow(file)` exist.
  - `deltaReview.clearResolvedNotes` (`:1741+`) filters `currentNoteThreads` (all kinds after 03_02), so it already covers general notes. Verify.
- package.json:
  - `viewsWelcome` for `deltaReviewNotes` (`:33-37`).
  - `view/title` `deltaReview.clearResolvedNotes` at `navigation@0` (`:291-295`).
  - Row context menus key on `viewItem =~ /^noteRow-/` (`:413-452`).
- Mock (`.mise/mock/notes-create.html`, `notes-pane.html`):
  - `$(add)` left of Clear Resolved.
  - QuickPick title `New Review Note`, placeholder `Choose the kind of note`.
  - Items:
    - `$(file) File note`, description `<path>`, detail `whole-file thread at the top of the diff`; when disabled, the description is the reason
    - `$(comment-discussion) General note`, description `not tied to a file`
  - Reasons:
    - `No file is open in the editor`
    - `<path> is not changed on this branch`
    - `Open a file from the Delta Review diff`
    - plus, for a deleted file, `<path> is deleted on this branch`
  - A disabled item cannot be accepted, and the highlight starts on General note.
  - Group `General notes` (icon comment-discussion, count description) sits first. General rows have no description, and their tooltip ends with `General note · click to open its conversation`.
  - File-note rows: description `file`, sorted before line notes.
  - Empty text: `No review notes on this branch.\nClick + above to add a file or general note, or hover a line in a review diff and click + to add a line note.`

## Guides

- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format
- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `notesGrouping.ts`:
  - `NoteGroup = { kind: "general"; threads: AnyNoteThread[] } | { kind: "file"; document?; file; threads: AnyNoteThread[] }`.
  - The general group comes first, and only when non-empty.
  - Within a file group, file-note threads come first by `createdAt`, then line threads by `currentStartLine`.
  - `notesGroupCollapseKey` returns `notesGeneral` for the general group (no `notes:` prefix, so it cannot collide with a file key).
- `notesTreeProvider.ts`:
  - New element `{ kind: "generalGroup"; threads }`. `NoteRowElement.thread: AnyNoteThread`.
  - The general group item has label `General notes`, `iconPath = ThemeIcon("comment-discussion")`, description = count, and id `notesGeneral`.
  - Rows:
    - file note: description `file` (+ ` ⚠` if outdated); outdated tooltip `⚠ Outdated — the file left the diff`
    - general note: no description; tooltip adds `General note · click to open its conversation`; command `deltaReview.openGeneralNote`
    - line note: unchanged
  - `contextValue` is unchanged, so row actions keep working.
- `newNoteChoice.ts` (pure, no vscode):
  - `fileNoteAvailability(active: { scheme: string; fsPath: string; path: string } | undefined, repoRoot: string, files: readonly { path: string; deleted: boolean }[]): { path: string } | { reason: string }`.
  - Pass in the active tab's modified/primary URI fields.
  - `file` scheme: repo-relative `/` path. `delta-review-base` scheme (`REVIEW_BASE_SCHEME`): the path is `uri.path.slice(1)`.
  - Reasons:
    - undefined → `No file is open in the editor`
    - not file/base scheme, or outside the repo → `Open a file from the Delta Review diff`
    - not in files → `<path> is not changed on this branch`
    - deleted → `<path> is deleted on this branch`
- `extension.ts`:
  - `renderNoteThreads` gives the tree all threads.
  - Collapse handlers also handle `generalGroup` (`notesCollapseKeyFor` accepts both group kinds).
  - Register `deltaReview.newNote`:
    - Read the active tab: `vscode.window.tabGroups.activeTabGroup.activeTab?.input`. Use `TabInputTextDiff.modified`, else `TabInputText.uri`.
    - Compute availability and show a `createQuickPick` with the two items. Set `activeItems` to General note.
    - `onDidAccept`: ignore the File note item when it is unavailable (keep the picker open).
    - File note: `openDiff(file)`, then (after a tick) `commentController.startFileNoteDraft(Uri.file(join(repoRoot, path)), path, randomUUID())`.
    - General note: `executeCommand("deltaReview.newGeneralNote")`.
  - `openNoteInDiff`:
    - General thread → `deltaReview.openGeneralNote`.
    - File thread in the model with a non-empty diff → `openDiff(file)` (no selection), a tick, `expandThread`, `revealFileRow`.
    - Otherwise open the `fileNoteTargetFor` document and expand.
- `package.json`:
  - Command `deltaReview.newNote` (title `New Review Note`, icon `$(add)`, category Delta Review) in `view/title` when `view == deltaReviewNotes`, group `navigation@-1`.
  - Reword the `deltaReviewNotes` welcome to the mock text.
  - Un-hide `deltaReview.newGeneralNote` in the palette (keep `openGeneralNote` hidden).

## Gotchas

- `src/contentProvider.ts` imports `vscode`, so `newNoteChoice.ts` must not import `REVIEW_BASE_SCHEME` from it. Take the base scheme as a parameter from `extension.ts`.
- The welcome text renders only when `getChildren()` returns `[]`. Keep the general group absent when there are no general notes.
- A row's `id` stays `note:<id>`. The general group id must not collide with `notesFile:` ids.
- The QuickPick `onDidAccept` fires on Enter, even on the "disabled" item. Return early without hiding.
- Wait for `openDiff` to resolve before `startFileNoteDraft`. The thread must attach after the editor exists (same one-tick pattern as `openNoteInDiff`, `src/extension.ts:1638`).

## Verification

- `src/notesGrouping.test.ts`:
  - the general group comes first and is omitted when empty
  - file notes come before line notes, ordered by `createdAt`
  - document and code group ranking is unchanged
  - the `notesGeneral` collapse key
- `src/newNoteChoice.test.ts`: each reason, base-scheme path mapping, and outside-repo path.
- Run `yarn test`, `yarn lint`, `yarn build`.
- Scripted extension-host check (batch with 03_02 / 03_03): write a v3 notes file with one general, one file and one line note on a changed file. `__inspect().treeRows` doesn't include notes-tree rows today, so add `notesRows` (same shape, from `notesTreeProvider`) to `__inspect`. Assert:
  - the first group is `General notes`
  - the file row's description is `file` and it precedes the line row
  - `executeCommand("deltaReview.clearResolvedNotes")` after resolving the general note removes it
- Manual (eyeball): the `+` placement, the disabled File note item with its reason, and that a File note draft appears above line 1 and saves.
