# Spec: markdown note bodies and pending replies

## What

- Reviewer turns and agent turns render as markdown in inline comment threads and in the REVIEW NOTES row tooltip. Every other `escapeMarkdownText` caller (`src/moveDisplay.ts`, `src/provenance.ts`, `src/treeProvider.ts`) stays escaped. Editing a turn still swaps in its raw text. Losing the hard-line-break height trick is accepted.
- An agent response entry may carry `pending: true`, meaning "answered, but the work is still queued." A note whose newest turn is a pending agent reply has the derived status **pending**:
  - It shows a purple `clock` icon, the label "Pending", the thread state Unresolved, and the context values `pendingNote` and `noteRow-pending`.
  - It keeps the reply box ("Reply & Reopen"), is resolvable and deletable, and counts in the view badge.
  - It stays in the agent's work set on the agent's next run.
  - It clears when the agent posts a non-pending reply (Addressed), the reviewer replies (Open), or the reviewer resolves (Resolved).
- Pending replies have read/unread state:
  - A new pending reply is unread. The reviewer marks it read with **Mark as Read** (`$(eye)`), offered on the thread title bar and on the REVIEW NOTES row only while unread. Opening or expanding a thread does not mark it read.
  - Unread shows a purple clock, a highlighted (bold) row label, the thread label "Pending • Unread", and the tooltip "Status: pending (unread)".
  - Read shows a dimmed clock, the label "Pending", and the tooltip "Status: pending".
  - Read state lives only in VS Code workspace state, keyed per note to the newest agent turn's `at`, so a later pending reply is unread again. The notes and responses files and agents never see it.
- No responses-file `version` bump. Old extensions ignore `pending` and show Addressed. The contract's schema-change rule is amended to exempt an additive optional key in the responses file that an older extension can safely ignore, because the extension drops unknown keys and never rewrites that file. The notes file stays under the bump rule: the extension rebuilds notes from known keys (`parseNoteEntry`, `src/notes.ts:215-233`) and re-saves them on every refresh (`saveNotes`, `src/notesStore.ts:209`), so an older extension would strip a newer per-note key. The plugin version bumps 0.8.0 → 0.9.0.

## Design

**Persisted vs derived status.** `NoteStatus` (`src/notes.ts`) stays `"open" | "addressed" | "resolved"`. That is the notes-file schema, and the notes parser keeps rejecting anything else. `src/noteThreads.ts` adds `ThreadStatus = NoteStatus | "pending"`, and `NoteThread.status` becomes `ThreadStatus`. When a derived status is written back into the notes file (`refreshDerived`, `recomputeStatus` in `src/notesStore.ts`), pending is stored as `"addressed"` through `persistedStatus(status: ThreadStatus): NoteStatus`.
- This deviates from the goals assumption "persisted like the others" in order to honor Decision 2. If `"pending"` were written into the notes file, an older extension would reject the whole notes file instead of showing Addressed.
- Agents lose nothing. They read pending from their own responses file, and the work-set rule uses that flag.

**Derivation.** `ThreadTurn` gains `pending?: true` (agent turns only). `deriveThreadStatus(noteStatus: NoteStatus, turns: ThreadTurn[]): ThreadStatus` returns the first match from this list:
1. `resolved` if the note is resolved.
2. `pending` if the last turn is an agent turn with `pending === true`.
3. `addressed` if the last turn is an agent turn.
4. `open` otherwise.

Other derivation rules:
- `mergeThreads` uses `deriveThreadStatus` and copies `entry.pending === true` onto the agent turn.
- `workSet` returns open or pending threads, which mirrors the contract's actionable rule.
- `commentController`'s eager restyles derive the thread status from the store's returned note plus the cached turns, through `deriveThreadStatus`. They never copy `note.status` directly into `noteThread.status`.

**Parsing.** `ResponseEntry` gains `pending?: true`. `parseResponseEntry` rejects a non-boolean `pending` with `"pending" must be a boolean`, and keeps the key only when it is `true`. This follows the clusters `wait` precedent (`src/clusters.ts:260-276`).

**Rendering.**
- `canReplyFor` returns true for `addressed` and `pending`. An open→pending flip goes through the existing `shouldRecreateThread` dispose+recreate. An addressed↔pending change keeps the live thread.
- `statusLabels` and `statusContextValues` become `Record<ThreadStatus, string>`. The label is composed as status, then `" • Unread"` (pending unread only), then `" • Outdated"`.
- The thread context values are `openNote`, `addressedNote`, `pendingNote` (read), `pendingNoteUnread`, and `resolvedNote`.
- The row context values are `noteRow-open`, `noteRow-addressed`, `noteRow-pending`, `noteRow-pendingUnread`, and `noteRow-resolved`.
- Unread rows use a `vscode.TreeItemLabel` with a highlight spanning the whole label. VS Code renders it bold in the theme's `list.highlightForeground` (usually blue), not the mock's bold white; this is accepted.
- `CommentThread` has no accent-color API, so the mock's purple thread accent is not built. Purple shows only on the tree icon.
- The row icon is a `ThemeIcon`, which cannot carry an overlay, so the mock's unread dot is not built. Unread is a bright purple clock (`charts.purple`); read is a dimmed clock (`disabledForeground`).

**Markdown.** `commentsFor` appends `turn.text` raw instead of `escapeMarkdownText(turn.text)`. The notes-tree tooltip appends `thread.turns[0].text` raw. `MarkdownString` stays untrusted, with no HTML and no command links. `displayFor` and `CommentDisplay` are unchanged: `bodyIsMarkdown` stays true for rendered turns, and `bodyText` is now the raw markdown.

**Read state.** A new pure module, `src/pendingRead.ts`, defines `PendingReadMarks = Record<noteId, agentTurnAt>` and exports `newestAgentTurnAt`, `isPendingUnread`, `withReadMark`, and `prunedReadMarks`.
- `src/extension.ts` stores marks per repo and branch in `context.workspaceState` under `deltaReview.pendingReadMarks` (`Record<repoRoot, Record<branch, PendingReadMarks>>`). The key is per repo because the extension follows the SCM-selected repo (`setActiveRepo`) and every repo shares one `workspaceState`.
- On a successful notes load (the `mergeThreads` render site), it prunes only inside the loaded repo's map: the current branch's marks to the note ids present in the thread set, and, when that repo's map holds other branches, entries for branches with no local `refs/heads/<branch>` in that repo (one `git for-each-ref` call, skipped when the current branch is the repo's only key; a git failure skips only that branch pruning). Empty per-branch and per-repo maps are dropped. Other repos' maps are never touched. It writes only if something changed.
- The same pruning runs, with an empty thread set, when the notes file loads successfully with zero notes (`notesResult.state === "ok"` and `notes.length === 0`), so a branch whose last note was deleted loses its marks. It never runs on an invalid or missing notes file.
- It injects `isUnread(thread)` into `NotesTreeProvider` (a new constructor parameter) and `{ isUnread, markRead }` into `createNoteCommentController` (a new fourth parameter).
- `markRead` writes the mark, persists it, and re-styles both surfaces without pruning: it calls a new controller method `restyleThreads()`, which runs `styleThread` over each `threadCache` entry's own `noteThread`, and `notesTreeProvider.setThreads(currentNoteThreads)` for the tree. It must not call `renderNoteThreads` or `renderThreads` outside `refresh()`: `renderThreads` disposes cached threads absent from its array, which would dispose a just-added note's thread whose refresh has not landed. `styleThread` writes only the fields that changed.
- New commands: `deltaReview.markNoteRead` (thread title, inline) and `deltaReview.markNoteRowRead` (row inline and context). Both are hidden from the command palette.

**Badge.** The badge rule is unchanged (not resolved), so pending notes count whether read or unread. Only its comment changes.

**Contract (`plugin/skills/review-notes/SKILL.md`).**
- Document `pending` in the Responses file section.
- Responses-file Entry conventions: `response` renders as markdown; wrap paths and identifiers in backticks.
- Change the Work set rule to: a note is actionable iff it is not resolved and its newest turn is either a reviewer turn or your response with `pending: true`.
- Channel discipline: after the agent appends a pending reply, that note is skipped for the rest of the session, including across watch-mode rounds, until a newer reviewer turn arrives; that turn lifts the skip at once. Still-pending notes are picked up on the next invocation. The existing question skip keeps its pass scope. Questions to the reviewer are never pending.
- A picked-up pending note whose queued work still can't be done gets no new reply; the existing pending reply stands. The agent replies only with new information for the reviewer or when the work is done.
- Schema changes: an additive optional key in the responses file that an older extension can safely ignore (it drops unknown keys and never rewrites that file) needs no `version` bump. The notes file keeps the bump rule, because the extension re-saves parsed notes and would strip unknown keys.
- Bump `plugin/.claude-plugin/plugin.json` to 0.9.0.

**Removed.** Note bodies are no longer escaped in threads or the tooltip. DEVELOPMENT.md's "no escape hatch / escapeMarkdownText verbatim" statement for turns is removed (task 01_01).

## Hard-to-undo

- Public agent-facing contract change: the responses file gains an optional `pending` key, the Work set rule changes, and the schema-change rule is amended to allow additive optional responses-file keys that an older extension can safely ignore without a `version` bump (notes-file changes still bump `version`). Agents on plugin 0.9.0 write files that older extensions read as Addressed.
- Plugin version bump 0.8.0 → 0.9.0 (`plugin/.claude-plugin/plugin.json`).
- New persisted workspace-state key `deltaReview.pendingReadMarks`. Users' VS Code storage gets data that later versions must keep reading or ignore.
- The notes-file schema is not changed: pending persists as `"addressed"`.

## Task index

| Task file | What it does | Files |
| --- | --- | --- |
| 01_01_markdown_note_bodies.md | Render reviewer and agent turns and the row tooltip as markdown | src/commentController.ts, src/notesTreeProvider.ts, src/markdown.ts, DEVELOPMENT.md |
| 01_02_pending_status_derivation.md | Add `ThreadStatus` with pending, its derivation, persistence mapping, reply box, and base pending UI | src/noteThreads.ts, src/threadRender.ts, src/notesStore.ts, src/commentController.ts, src/notesTreeProvider.ts |
| 01_03_pending_response_flag.md | Parse `pending` on response entries, carry it into threads, and gate menus on pending context values | src/notes.ts, src/noteThreads.ts, package.json |
| 01_04_pending_read_state.md | Workspace-local read/unread for pending notes with Mark as Read on the thread and row | src/pendingRead.ts, src/extension.ts, src/commentController.ts, src/notesTreeProvider.ts, package.json |
| 01_05_contract_and_docs.md | Amend the review-notes contract, bump the plugin version, and document pending in DEVELOPMENT.md and README.md | plugin/skills/review-notes/SKILL.md, plugin/.claude-plugin/plugin.json, DEVELOPMENT.md, README.md |
