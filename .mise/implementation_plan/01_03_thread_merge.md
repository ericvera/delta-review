# Task 1.3: Thread merge — notes + responses → display threads with derived status

## Goal

Create `src/noteThreads.ts`: pure merging of the extension-owned notes file and the agent-owned
responses file into display-ready threads — interleaved turns, last-speaker status derivation,
response-anchor application — with unit tests.

## Requirements addressed

REQ-LIFE-1, REQ-LIFE-2, REQ-LIFE-6, REQ-AGENT-3, REQ-AGENT-5, REQ-AGENT-6

## Background

The feature: inline review notes worked by an agent. Two files exist per branch (defined in Task
1.1, `src/notes.ts`): `NotesFile` (notes with reviewer `turns: ReviewerTurn[]`, persisted `status`,
anchoring fields) and `ResponsesFile` (`ResponseEntry[]`: `{noteId, status:"addressed", response,
at, anchor?}`, appended by the agent; multiple entries per noteId accumulate). This task derives the
truth the UI renders. Pure module — no `vscode`, no git.

Lifecycle rules (from requirements):
- Status is one of open/addressed/resolved. Unresolved statuses derive from the last speaker: last
  turn reviewer → open; last turn agent → addressed (REQ-LIFE-2).
- Resolved is set only by explicit reviewer action and is stored on the note (`status: "resolved"`).
  A late agent response landing on a resolved note merges its turn but MUST NOT change status
  (REQ-AGENT-6).
- Responses referencing unknown note ids are ignored (REQ-AGENT-6).
- An anchored response relocates the thread to the anchor (working-tree side; a base-side note flips
  `side` to working from then on) and suppresses outdated for that relocation (REQ-AGENT-5). Whether
  the anchor *resolves* against the working tree (file exists, line in range) is runtime knowledge —
  this module takes a callback/flag per anchor (see below); a dangling anchor is ignored entirely
  (no relocation, no side flip).

## Files to modify/create

- `src/noteThreads.ts` — new module.
- `src/noteThreads.test.ts` — new unit tests.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Types:
   - `export type ThreadTurn = { author: "reviewer" | "agent"; text: string; at: string;
     anchor?: ResponseAnchor }` (import `ResponseAnchor`, `Note`, `NotesFile`, `ResponsesFile`,
     `NoteStatus` from `./notes`).
   - `export interface NoteThread { note: Note; turns: ThreadTurn[]; status: NoteStatus;
     effectiveAnchor?: ResponseAnchor }` — `effectiveAnchor` is the newest applied (non-dangling)
     anchor; consumers use it for relocation and side flip.
2. `mergeThreads(notes: NotesFile, responses: ResponsesFile | undefined,
   anchorResolves: (anchor: ResponseAnchor) => boolean): NoteThread[]`:
   - Group response entries by `noteId`; drop groups with no matching note.
   - Turns = reviewer turns (author "reviewer") + response entries (author "agent", text =
     `response`), sorted by `at` ascending; ties/unparsable timestamps fall back to stable
     interleave preserving each source array's order (requirements Assumption: file-order fallback).
   - Status: if `note.status === "resolved"` → resolved (explicit resolve wins). Else last speaker:
     last turn author agent → addressed, reviewer → open. (A note always has ≥1 reviewer turn —
     enforced by the Task 1.1 parser.)
   - `effectiveAnchor`: newest agent turn's `anchor` for which `anchorResolves(anchor)` is true;
     dangling anchors are skipped (fall through to the next-newest, else none).
3. `export const workSet = (threads: NoteThread[]): NoteThread[]` — threads with derived status
   `open` (outdated irrelevant — flag not status). Used by tests to document REQ-AGENT-4 semantics
   from the extension's perspective and by the store when persisting derived `status`.
4. Keep functions total: `responses === undefined` (missing/invalid file) behaves as empty.

## Testing suggestions

- `src/noteThreads.test.ts` (fixtures via small local factories, clusters.test.ts style):
  - single note, no responses → open, turns = its reviewer turn;
  - note + one response → addressed, turns interleaved chronologically;
  - note + response + newer reviewer follow-up turn → open (reopen);
  - two responses for one noteId → both turns present in order (accumulate, REQ-AGENT-3);
  - resolved note + later response → status stays resolved, turn merged (REQ-AGENT-6);
  - response with unknown noteId → dropped;
  - anchored response with `anchorResolves` true → `effectiveAnchor` set; false → undefined
    (dangling ignored); newest-wins across two anchored responses;
  - timestamp tie / malformed `at` → stable order fallback;
  - `workSet` filters exactly derived-open threads.
- Run `yarn test`.

## Gotchas

- Do not mutate the input `Note` objects (the store persists them separately); derive into the
  `NoteThread` wrapper.
- Sorting must be stable across Node versions — `Array.prototype.sort` is stable in Node ≥ 12, rely
  on it but keep the comparator returning 0 for ties so file-order survives.
- "Last speaker" reads the merged, sorted turn list — not the raw arrays.

## Verification checklist

- [ ] `yarn test` passes with the new `noteThreads.test.ts` suite.
- [ ] `yarn lint` and `yarn build` pass.
- [ ] End-to-end tests: Test exception applies (no e2e infrastructure exists): unit tests above are
      the verification; no runtime surface exists yet.
