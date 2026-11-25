# 03_03 General note conversation tab

## Goal

Open a general note (a note with no file) in its own editor tab. The tab shows the note, the reviewer's replies, the agent's responses and a reply box, with Resolve/Unresolve, Delete and Mark Read. A draft mode creates a new general note. There is one tab per note, reused when it is already open. The tab closes when its note is deleted.

## Files to modify/create

- src/generalNoteHtml.ts (new, pure; test: src/generalNoteHtml.test.ts)
- src/generalNotePanel.ts (new, vscode UI; no unit test because it imports vscode)
- src/extension.ts
- package.json

## Background

- Task 03_01:
  - `GeneralNote { scope: "general"; id; turns; status; outdated; createdAt }` (`src/notes.ts`), and `AnyNoteThread` / `isGeneralThread` (`src/noteThreads.ts`).
  - `createNote(git, branch, { scope: "general", text, id? })`, `appendReviewerTurn`, `setResolved`, `deleteNote` (`src/notesStore.ts`).
  - `pendingRead.ts` accepts `AnyNoteThread`.
- Task 03_02: `src/extension.ts` keeps `currentNoteThreads: AnyNoteThread[]` and `markRead(thread)` / `isUnread(thread)`. `renderNoteThreads(threads)` is the single place threads are rendered after a notes load. `notesKey` (`{ repo, branch }`, `src/extension.ts:150`) is defined only on a successful load, and its `branch` is `readMarkBranch(computed.branch)` (`src/extension.ts:746`; `readMarkBranch` in `src/pendingRead.ts:20` strips a leading `heads/`, which `rev-parse --abbrev-ref HEAD` prints when a tag shares the branch name). The notes store itself is called with the raw `computed.branch` (e.g. `refreshDerived` at `src/extension.ts:~724`).
- Thread statuses and labels: `ThreadStatus` = `open | addressed | pending | resolved`. Status label map is in `src/commentController.ts:49-55`. Row icons and colors are in `src/notesTreeProvider.ts:48-73`. Match these colors in the tab.
- Existing delete confirmation for note rows: `deltaReview.deleteNoteRow` (`src/extension.ts:~1695-1735`). Reuse its wording.
- Mock (`.mise/mock/general-note-tab.html`):
  - Tab title is the first line, truncated, with icon `$(comment-discussion)`.
  - Header: full first line, status pill, `✓ Resolve`, `🗑 Delete`.
  - Meta: `General note · branch <b> · created <d MMM HH:mm>`.
  - Turns: avatar initial, author (`You` / `Agent`), relative time, markdown body.
  - Footer: `Mark Read` (pending-unread only) and `Reply`.
  - Draft: title `New General note`, meta `Not tied to a file · branch <b>`, textarea, `Cancel` / `Add Note`. After Add Note the tab retitles and the note appears in the pane.
  - Deleted from anywhere means the open tab closes. Unread highlight matches line threads.
- Agent responses render as markdown (review-notes SKILL.md, "Entry conventions").

## Guides

- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format
- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

- `generalNoteHtml.ts` (pure, no vscode):
  - `renderGeneralNoteHtml({ mode: "note" | "draft", thread?, unread, branch, bodiesHtml: string[], nonce, cspSource, now }): string`.
  - `bodiesHtml` are pre-rendered turn bodies, one per turn.
  - Escape every other interpolated string with an exported `escapeHtml`.
  - CSP: `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} https: data:`.
  - Use VS Code theme CSS variables (`--vscode-editor-background`, etc.).
  - The inline script (nonce) posts `{ type: "reply" | "resolve" | "unresolve" | "delete" | "markRead" | "add" | "cancel", text? }` and keeps textarea text in `vscode.getState/setState`.
  - Also export `sameNotesKey(a, b)` (value equality of `{ repo, branch }`, used by `update`), `generalNoteTitle(text)` (first line, truncated at 40 with `…`) and `formatCreated(iso)`.
- `generalNotePanel.ts`: `createGeneralNotePanels({ markdownToHtml, isUnread, markRead, onDidChangeNotes })` returns:
  - `GeneralNoteContext = { repoRoot: string; storeBranch: string; key: { repo: string; branch: string } }`. `storeBranch` is passed to every store call; `key` has `notesKey`'s shape and value and is used for matching and for the meta line's branch.
  - `open(thread, ctx: GeneralNoteContext)`: reveal if open. Otherwise `createWebviewPanel("deltaReview.generalNote", title, ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false })` with `iconPath = new ThemeIcon("comment-discussion")`.
  - `openDraft(ctx)`: pre-allocates `randomUUID()` as the future note id.
  - `update(threads, key: { repo, branch })`: for panels where `sameNotesKey(ctx.key, key)`, re-render the panel's thread when changed (compare turn count, last `at`, status, unread). Close a non-draft panel whose note id is absent.
  - Messages run the store call on `createGit(panel.ctx.repoRoot)` and `panel.ctx.storeBranch`, then `onDidChangeNotes()`:
    - reply → `appendReviewerTurn`
    - resolve/unresolve → `setResolved`
    - delete → modal confirm, then `deleteNote`, then dispose
    - markRead → `markRead(thread)`
    - add → `createNote({ scope: "general", text, id })`, then switch to note mode and retitle
    - cancel → dispose
  - Errors show `Delta Review: failed to <action> (<msg>)`.
  - `markdownToHtml(text)` = `vscode.commands.executeCommand<string>("markdown.api.render", text)`, falling back to `<p>` + `escapeHtml` + `<br>` when the command throws or returns a non-string.
- `extension.ts`:
  - Instantiate the panels manager. Add `generalNoteContext(): GeneralNoteContext | undefined`, returning undefined unless `git` and `model` are defined, else `{ repoRoot: git.repoRoot, storeBranch: model.branch, key: { repo: git.repoRoot, branch: readMarkBranch(model.branch) } }`. Never use raw `model.branch` as the key: on a branch shadowed by a same-named tag it is `heads/<name>`, which would never equal `notesKey`, so the panel would never update or close.
  - Register `deltaReview.openGeneralNote(thread: AnyNoteThread)` (general threads only, else return) with `generalNoteContext()` (info `Delta Review: the review is still loading — try again in a moment.` when undefined).
  - Register `deltaReview.newGeneralNote()`, which opens a draft with `generalNoteContext()` (used by 03_04's `+`).
  - In `renderNoteThreads`, call `generalNotePanels.update(threads, notesKey)` when `notesKey` is defined.
  - `__inspect` gains `generalNotePanels: [{ noteId, mode, title }]` and `allNoteThreads: currentNoteThreads`.
- `package.json`: commands `deltaReview.openGeneralNote` (title `Open General Note`) and `deltaReview.newGeneralNote` (title `New General Note`, category Delta Review), both hidden from the palette for now (`when: false`). 03_04 exposes creation via the pane `+`.

## Gotchas

- Never `await` `showWarningMessage` / the modal inside `update`. Only message handlers await.
- `retainContextWhenHidden: false` means a hidden tab reloads its HTML when shown. The reply text survives via `setState`.
- A panel for a draft has no thread yet. `update` must not close it.
- Panels act on their own repo and branch even if the user switched repos. Never use the module-level `git` inside handlers.
- `markdown.api.render` output may contain raw HTML from responses. The nonce CSP blocks scripts and inline handlers. Don't add `'unsafe-inline'` to `script-src`.

## Verification

- `sameNotesKey`: `{ repo, branch: readMarkBranch("heads/x") }` equals `{ repo, branch: "x" }`; a different repo or branch does not.
- `src/generalNoteHtml.test.ts`:
  - escaping of note text (`<script>` stays inert text in the output)
  - the CSP meta contains the nonce and no `'unsafe-inline'` in `script-src`
  - draft vs note mode markup (Add Note/Cancel vs Reply/Resolve/Delete)
  - the Mark Read button only when unread
  - Unresolve shown for a resolved thread
  - `generalNoteTitle` truncation
  - `formatCreated`
- Run `yarn test`, `yarn lint`, `yarn build`.
- Scripted extension-host check: write a v3 notes file with one general note.
  - `executeCommand("deltaReview.openGeneralNote", thread)` with the thread taken from `__inspect().allNoteThreads`. `__inspect().generalNotePanels` lists it with its title.
  - Delete the note via `deleteNote` on disk (rewrite the notes file without it) and refresh. The panel list is empty.
- Manual (eyeball): reply, resolve, delete confirm, draft Add Note and retitle, markdown rendering, theme colors.
