# Implementation Plan

## Summary

Add inline review notes to Delta Review's diffs: reviewers comment on either side of the review diff
via VS Code's native Comments API; notes persist per branch inside `.git`; a Claude Code agent reads a
file-based contract, addresses open notes, and responds live into the same threads; a sibling REVIEW
NOTES SCM view oversees the loop (open → addressed → resolved).

## Design

Components (new files unless noted):

```
                    ┌───────────────────────────────┐
                    │ extension.ts (modified)        │
                    │  wiring + refresh integration  │
                    └───┬───────────┬───────────┬───┘
                        │           │           │
        ┌───────────────▼──┐  ┌─────▼───────┐  ┌▼──────────────────┐
        │ commentController │  │ notesTree   │  │ notesStore         │
        │ .ts  (diff UI)    │  │ Provider.ts │  │ .ts (git + files)  │
        └───────────┬──────┘  │ (SCM view)  │  └─┬──────────────────┘
                    │         └─────┬───────┘    │ reads/writes
                    └───────┬───────┘            │
                    ┌───────▼────────────────┐   │  <commonDir>/delta-review/
                    │ noteThreads.ts (pure)   │   │    notes-<branch>.json      ← extension writes
                    │ merge + status + anchor │   │    responses-<branch>.json  ← agent writes
                    │ application             │   │  refs/review-notes/<branch> ← blob gc-anchor
                    ├────────────────────────┤   │
                    │ notes.ts (pure parse)   │◄──┘
                    │ noteAnchor.ts (pure map)│
                    └────────────────────────┘
```

- **`src/notes.ts`** — contract types + parse/validate for both files (mirrors `clusters.ts` exactly:
  version-1 integer check, one-line user-facing errors, unknown keys ignored, `{missing|invalid|ok}`
  load results). Pure; no `vscode` import.
- **`src/noteAnchor.ts`** — hunk parsing of `git diff -U0` output and line-range mapping (shift /
  unchanged / outdated when any anchored line is touched). Pure.
- **`src/noteThreads.ts`** — merges notes + responses into display threads: interleaves turns by
  timestamp (file-order fallback), derives status from last speaker (explicit resolved wins; late
  response on resolved merges without status change; orphan responses dropped), applies response
  anchors (relocation, base→working side flip, dangling anchor ignored). Pure.
- **`src/notesStore.ts`** — the only module touching git for notes: resolves the common dir (same flow
  as `loadClustersContract`, `clusters.ts:286-317`), reads/writes the two JSON files, snapshots note
  content blobs (`hash-object -w`) and anchors them on `refs/review-notes/<branch>` via the temp-index
  commit-tree pattern of `writeReviewState` (`reviewState.ts:38-87`), computes re-anchored positions
  by diffing blobs (`git diff -U0 <blobA> <blobB>` → `noteAnchor`), and persists derived fields
  (position/outdated/status) idempotently (skip write when content unchanged — avoids watcher loops).
- **`src/commentController.ts`** — Comments API integration: commenting ranges on review-set `file://`
  docs and `delta-review-base` docs; thread lifecycle (render from merged model, one comment per
  turn); create/edit/delete/resolve/unresolve/reply-to-reopen commands; status labels + outdated
  "line was" context; save-failure toasts.
- **`src/notesTreeProvider.ts`** — REVIEW NOTES view (sibling SCM section): file groups
  (basename + dimmed dir + count), note rows (status icon, first-line text, line ref, base marker),
  click → review diff at the note (plain file fallback when the file left the review set).
- **`plugin/skills/review-notes/SKILL.md`** — the agent-facing contract documentation.
- **`package.json`** — second `views.scm` entry `deltaReviewNotes`, `viewsWelcome` empty state, new
  commands, `comments/*` and view menus.
- **Data model** (all schemas version 1):
  - Note: `id` (uuid), `file`, `side` ("base"|"working"), `startLine`/`endLine` (1-based, at
    creation), `snapshot` (array of the anchored lines' text), `contentBlob` (sha of the whole
    side-document at creation), `turns` (reviewer turns `{text, at}`), `status`
    ("open"|"addressed"|"resolved"), `outdated`, `currentStartLine`/`currentEndLine` (derived),
    `createdAt`. Extension-owned.
  - Response entry: `{noteId, status: "addressed", response, at, anchor?: {file, line, snapshot}}`,
    appended; multiple entries per noteId accumulate as turns. Agent-owned.
- **Refresh integration**: the existing `watchContractDir` watcher (`extension.ts:325-353`) already
  fires on any `*.json` in `<commonDir>/delta-review/`, and `refresh()` reloads contracts every run —
  notes piggyback on both. No new watcher.

Migration/removal: none — purely additive; the DELTA REVIEW tree, review state, and clusters code
paths are untouched (REQ-PRESERVE-1/2).

## Assumptions

- `crypto.randomUUID` (Node ≥ 16) is available in the extension host for note ids.
- `git diff <blobA> <blobB>` (two blob shas) is a stable plumbing form for hunk extraction.
- Comment UI affordances (input box on `+`, reply box, edit mode) are VS Code-native; only their
  commands/menus are ours. Thread reveal is approximated by opening the diff with a `selection` at the
  note's line and setting that thread's `collapsibleState` to Expanded (no stable `thread.reveal()`
  in 1.90).
- Turn timestamps are ISO-8601 UTC strings; ordering falls back to per-file array order on ties/skew
  (requirements Assumption).
- The REVIEW NOTES view shows resolved notes (counts include them) until Clear Resolved, matching
  mock 6A.

## Phases

- **Phase 1: Contract + pure logic** — schemas, anchoring math, thread merging; fully unit-tested.
- **Phase 2: Store** — git-backed persistence, blob anchoring, derived-field refresh.
- **Phase 3: Diff UI** — comment controller: create/render, thread actions, live agent loop.
- **Phase 4: REVIEW NOTES view** — tree, navigation, clear-resolved, branch switching.
- **Phase 5: Agent skill + docs** — `review-notes` SKILL.md, README/DEVELOPMENT, manual test pass.

## Phase Rationale

Pure logic first (1) so every later layer builds on tested primitives; the store (2) isolates all git
side effects and unblocks the UI; the diff UI (3) is the core user loop and exercises store+logic
end-to-end in the dev host; the view (4) consumes the same merged model read-only; the skill/docs (5)
freeze the contract only after the extension side is proven. Every task compiles green: new modules
are additive, wiring lands with the feature that uses it.

## Task Index

| File                          | Task                                          | Phase | Requirements |
| ----------------------------- | --------------------------------------------- | ----- | ------------ |
| `01_01_notes_contract.md`     | Contract types, parse/validate, load results  | 1     | REQ-AGENT-1, REQ-AGENT-2, REQ-AGENT-3, REQ-AGENT-8, REQ-STORE-2, REQ-PRESERVE-2 |
| `01_02_anchor_mapping.md`     | Hunk parsing + line-range mapping             | 1     | REQ-ANCHOR-1, REQ-ANCHOR-2, REQ-ANCHOR-3 |
| `01_03_thread_merge.md`       | Merge notes+responses, status, anchors        | 1     | REQ-LIFE-1, REQ-LIFE-2, REQ-LIFE-6, REQ-AGENT-3, REQ-AGENT-5, REQ-AGENT-6 |
| `02_01_notes_store.md`        | Git-backed store, blob anchoring, derived     | 2     | REQ-STORE-1, REQ-STORE-2, REQ-STORE-3, REQ-STORE-4, REQ-ANCHOR-2, REQ-ANCHOR-4, REQ-AGENT-9 |
| `03_01_comment_create.md`     | Controller, gutters, create + render threads  | 3     | REQ-NOTE-1, REQ-NOTE-2, REQ-NOTE-3, REQ-NOTE-4, REQ-NOTE-5, REQ-LIFE-5 |
| `03_02_thread_actions.md`     | Edit/delete/resolve/unresolve/reply-to-reopen | 3     | REQ-NOTE-6, REQ-NOTE-7, REQ-LIFE-3, REQ-LIFE-4, REQ-LIFE-7 |
| `03_03_live_agent_loop.md`    | Response merge, anchors, outdated, live flips | 3     | REQ-AGENT-5, REQ-AGENT-6, REQ-AGENT-8, REQ-AGENT-9, REQ-ANCHOR-3, REQ-ANCHOR-4, REQ-ANCHOR-5, REQ-NOTE-7 |
| `04_01_notes_view.md`         | REVIEW NOTES tree, empty state, icons, counts | 4     | REQ-VIEW-1, REQ-VIEW-2, REQ-VIEW-3, REQ-VIEW-7, REQ-PRESERVE-1 |
| `04_02_view_actions.md`       | Navigation, clear resolved, branch switching  | 4     | REQ-VIEW-4, REQ-VIEW-5, REQ-VIEW-6, REQ-VIEW-8, REQ-LIFE-6 |
| `05_01_agent_skill_docs.md`   | review-notes skill, docs, manual test pass    | 5     | REQ-AGENT-4, REQ-AGENT-7, REQ-PRESERVE-3 |
