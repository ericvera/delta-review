# Task 4.1: REVIEW NOTES view — sibling SCM section, groups, icons, empty state

## Goal

Create `src/notesTreeProvider.ts` and register a REVIEW NOTES view in the SCM sidebar as a sibling
of DELTA REVIEW: notes grouped by file (basename + dimmed dir + count), per-note rows with status
icons and first-line text, and a welcome empty state.

## Requirements addressed

REQ-VIEW-1, REQ-VIEW-2, REQ-VIEW-3, REQ-VIEW-7, REQ-PRESERVE-1

## Background

The feature: inline review notes overseen from a dedicated SCM section (mock 6A/6B). Prior tasks:
- Task 1.3 — `src/noteThreads.ts`: `NoteThread { note, turns, status, effectiveAnchor }`; note
  fields (`src/notes.ts`): `file`, `side`, `currentStartLine`, `outdated`, `status`, `turns[0].text`.
- Task 3.x — extension `refresh()` produces the merged `NoteThread[]` each cycle (module-level
  variable next to `model`/`clusterModel`, `src/extension.ts:40-42` pattern).

Patterns to mirror (from the DELTA REVIEW tree):
- Provider shape `src/treeProvider.ts:124-150`: discriminated-union elements (:74-81),
  `EventEmitter<Element | undefined>` (:126-129), `refresh()` fires `undefined` (:148-150),
  constructor-injected callbacks (:131-141).
- `getTreeItem` conventions: stable `item.id`, `contextValue` strings, `description` for dimmed
  text (:471-486), `tooltip` MarkdownString for full paths (:489-502), click command attach
  (:503-507).
- View registration `src/extension.ts:98-100` (`createTreeView("deltaReview", …)`); collapse
  persistence wiring `extension.ts:124-148` (only if groups need it — file groups default expanded,
  reuse the same collapsed-set with keys namespaced `notes:<path>`).
- Sibling section: second entry in `contributes.views.scm` (`package.json:19-26`).

## Files to modify/create

- `src/notesTreeProvider.ts` — new module: `NotesTreeElement` union (`fileGroup` | `note`),
  provider class.
- `src/extension.ts` — instantiate + `createTreeView("deltaReviewNotes", …)`; refresh it in the
  notes portion of `refresh()`; collapse wiring.
- `package.json` — `views.scm` entry `{ id: "deltaReviewNotes", name: "Review Notes" }`;
  `viewsWelcome` entry for the empty state; no changes to the existing `deltaReview` view
  (REQ-PRESERVE-1).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Elements: `{ kind: "fileGroup"; file: string; threads: NoteThread[] }` and
   `{ kind: "note"; thread: NoteThread }`. Root = file groups sorted by path; children = that
   file's notes sorted by `currentStartLine`.
2. File group item (REQ-VIEW-2): label = `basename(file)`; `description` = dirname + `" · <n>"`
   count (dimmed automatically); `tooltip` = full repo-relative path; `id = notesFile:<path>`;
   collapsible, default expanded; count includes resolved notes (mock 6A).
3. Note row item (REQ-VIEW-3):
   - `iconPath` by status: open → `new ThemeIcon("circle-large-filled",
     new ThemeColor("charts.blue"))`; addressed → `ThemeIcon("circle-large-outline",
     ThemeColor("charts.yellow"))` (half-full ◐ has no codicon; outline+yellow reads as "awaiting
     you"); resolved → `ThemeIcon("check", ThemeColor("charts.green"))`.
   - label = first line of `turns[0].text` (truncate ~60 chars with …);
   - `description` = `:<currentStartLine>` plus `" base"` when `side === "base"` and `" ⚠"` when
     outdated;
   - `tooltip` = full note text + status + outdated note;
   - `contextValue` = `noteRow-<status>` (Task 4.2 menus);
   - `id = note:<noteId>`;
   - click command `deltaReview.openNoteInDiff` with the thread as argument — **declare the command
     and register a stub in this task** (real navigation in Task 4.2; stub may call the existing
     `deltaReview.openDiff` when the file is in the review set, `extension.ts:371-399`).
4. Empty state (REQ-VIEW-7): `contributes.viewsWelcome`:
   `{ "view": "deltaReviewNotes", "contents": "No review notes on this branch.\nHover a line in a review diff and click + to add one." }`
   — renders whenever the provider returns no children.
5. Live updates: call `notesTreeProvider.refresh()` wherever `renderThreads` runs (same generation
   guard) — full REQ-VIEW-5 verification lands in Task 4.2.
6. Badge: set `treeView.badge` on the notes view with the count of open+addressed notes (mirrors
   `extension.ts:264-270`); tooltip "n review notes to handle".

## Testing suggestions

- Manual, F5 dev host:
  1. No notes → REVIEW NOTES section shows under DELTA REVIEW with the welcome text (mock 6B).
  2. Add notes in two files (one in a subdir with a same-named file elsewhere if convenient) → groups
     show basename + dimmed dir + count; rows show icon/status/text/line ref (mock 6A).
  3. Base-side note row shows the `base` marker; outdated note shows `⚠`.
  4. Collapse a file group, refresh (edit a file) → collapse state survives.
  5. DELTA REVIEW section renders exactly as before (no counts, no new rows) — REQ-PRESERVE-1.

## Gotchas

- View ids are global: `deltaReviewNotes` must match everywhere (`views.scm`, `viewsWelcome`,
  `when` clauses in Task 4.2 menus).
- `viewsWelcome` only shows when `getChildren(root)` returns `[]` — return an empty array, never a
  message element (unlike the main tree's `message` kind).
- Don't share the `ReviewTreeProvider` element types — the views must stay decoupled
  (REQ-PRESERVE-1); a second provider class is the pattern (exploration notes: "second, simpler
  tree view").
- `ThemeColor` ids must exist (`charts.*` are stable theme colors since 1.65).

## Verification checklist

- [ ] Manual dev-host checks 1–5 above pass.
- [ ] `yarn lint`, `yarn build`, `yarn test` pass.
- [ ] End-to-end tests: Test exception applies (no e2e infrastructure exists — verify with unit
      tests plus manual verification in the F5 Extension Development Host): manual checks above are
      the substitute verification.
