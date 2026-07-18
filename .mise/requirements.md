# Requirements

This document specifies the user-facing requirements for inline review notes in the Delta Review diff:
notes added in the review diff, persisted per branch inside `.git`, worked by an agent through a
file-based contract, and overseen from a sibling REVIEW NOTES view. "Reviewer" is the human user;
"agent" is a Claude Code (or equivalent) session reading the contract via the `review-notes` skill.

## 1. Adding notes in the diff (NOTE)

- **REQ-NOTE-1:** In a review diff opened from the Delta Review panel, hovering a line on **either
  side** MUST offer VS Code's native commenting gutter (`+`), and clicking it MUST open the native
  comment widget to compose a note.
- **REQ-NOTE-2:** A note MUST be attachable to a single line and to a selected multi-line range.
- **REQ-NOTE-3:** Saving a note MUST persist it immediately (no separate save/export step). Canceling
  (Esc/Cancel) MUST discard it.
- **REQ-NOTE-4:** If persisting fails, the extension MUST show an error notification and MUST keep the
  widget open with the typed text intact.
- **REQ-NOTE-5:** A right-side note MUST record the working-tree file + line(s); a left-side note MUST
  record the base snapshot (blob) + line(s), so notes on deleted/old code are expressible.
- **REQ-NOTE-6:** The reviewer MUST be able to edit and delete their own turns in a thread, and MUST
  be able to delete an entire thread (including agent turns) at any status.
- **REQ-NOTE-7:** Notes MUST NOT affect review state: adding, editing, resolving, or deleting notes
  never changes what is marked reviewed. Conversely, marking reviewed never changes note **content,
  turns, or status** — but it may change *derived* presentation (position, outdated flag) via the
  Section 2 re-anchoring, since it advances the diff's base document.

## 2. Anchoring and drift (ANCHOR)

- **REQ-ANCHOR-1:** A note MUST be anchored by content, not by raw line number: at creation it records
  its line number(s), the anchored line text (snapshot — for a range, the text of every line in the
  range), and the file content at note time.
- **REQ-ANCHOR-2:** Whenever notes are rendered, each note's position MUST be re-derived by mapping
  its creation-time position through the changes between its creation-time content and the document
  currently displayed on its side — independently per note, so multiple notes in one file shift,
  survive, or expire each on their own. This single rule applies to both sides: right-side notes map
  against the current working-tree content; left-side notes map against the diff's current base
  document.
- **REQ-ANCHOR-3:** A note whose anchored line(s) were themselves edited or deleted (relative to the
  currently displayed document on its side — for a range, when **any** line of the range changed)
  MUST be flagged **outdated**, positioned at the nearest
  surviving location, and MUST still display its original snapshot ("line was: …"). Outdated is a
  flag, not a status: it never alters a note's status, and work-set membership follows status alone
  (an open outdated note is in the agent's work set; an addressed one is not).
- **REQ-ANCHOR-4:** The diff's base document is not fixed: it is the merge base until a file is first
  marked reviewed, then the last-reviewed snapshot, and a rebase can move the merge base. Left-side
  notes MUST survive all such base progressions (never silently dropped) by the REQ-ANCHOR-2 mapping:
  while the displayed base blob equals the note's creation blob they render exactly where written;
  when it differs, they re-map and go outdated per REQ-ANCHOR-3 if their line is absent from the new
  base. Working-tree edits alone MUST NOT move or outdate a left-side note.
- **REQ-ANCHOR-5:** If a noted file is deleted from the working tree, its right-side notes MUST be
  flagged outdated and remain listed in the REVIEW NOTES view.

## 3. Persistence and ownership (STORE)

- **REQ-STORE-1:** Notes MUST persist per branch in the git common dir (zero footprint: nothing in the
  working tree, nothing pushed), keyed by branch name — surviving window reloads, commits, amends,
  rebases, and visible from every worktree of the clone.
- **REQ-STORE-2:** The extension MUST be the only writer of the notes file, and the agent the only
  writer of the responses file (one writer per file).
- **REQ-STORE-3:** Note snapshots (creation-time file content) MUST be protected from `git gc` (stored
  via the object store anchored the same way review snapshots are, or equivalent).
- **REQ-STORE-4:** Clearing review state (`Delta Review: Clear Review State`) MUST NOT delete notes.
  Notes are removed only by reviewer deletion or the Clear Resolved action (REQ-VIEW-6).

## 4. Thread model and lifecycle (LIFE)

- **REQ-LIFE-1:** A thread MUST hold alternating turns: reviewer note, agent response, optional
  reviewer follow-up, further agent response, … — rendered in chronological order with distinct
  authorship (reviewer vs "Claude").
- **REQ-LIFE-2:** Note status MUST be one of **open**, **addressed**, **resolved**. Unresolved
  statuses derive from the last speaker: last turn reviewer → open; last turn agent → addressed.
  Resolved is set only by an explicit reviewer action.
- **REQ-LIFE-3:** The reviewer MUST be able to resolve a thread at any status (including skipping the
  agent entirely), rendered with VS Code's native resolved thread state.
- **REQ-LIFE-4:** An addressed thread MUST offer a reply box; submitting a reply reopens the note
  (status → open) with the follow-up as the newest turn. There MUST NOT be a way to reopen without
  writing a reply ("no bare keep-open").
- **REQ-LIFE-5:** Open and addressed threads MUST be visually distinguishable in the diff (status
  badge on the thread), and outdated MUST be an additional visible flag, not a status.
- **REQ-LIFE-6:** Resolved notes MUST drop out of the agent's work set (REQ-AGENT-4) but remain
  viewable until cleared or deleted.
- **REQ-LIFE-7:** A resolved thread MAY be unresolved via VS Code's native unresolve affordance;
  unresolving re-derives the status from the last speaker (REQ-LIFE-2). Replying directly on a
  resolved thread is not offered — unresolve first.

## 5. Agent contract (AGENT)

- **REQ-AGENT-1:** The notes storage itself is the contract: a versioned JSON file per branch at
  `<git-common-dir>/delta-review/notes-<sanitized-branch>.json` (same branch sanitization as the
  clusters contract). No export step and no hand-off UI exist.
- **REQ-AGENT-2:** Each note entry MUST expose at least: stable `id`, `file` (repo-relative path),
  `side` (base | working), line position, anchored-line snapshot text, all reviewer turns with
  timestamps, `status`, and an `outdated` flag. Base-side notes MUST carry enough context for an agent
  to understand code that no longer exists (the snapshot).
- **REQ-AGENT-3:** The agent MUST respond by appending entries to
  `<git-common-dir>/delta-review/responses-<sanitized-branch>.json`, each carrying a note `id`, status
  `addressed`, response text, a timestamp, and an OPTIONAL `anchor` (`file`, `line`, line snapshot —
  always a working-tree location) pointing at the code that addresses the note. Multiple entries for
  the same note id accumulate as successive agent turns (a reopened note gets a second entry; nothing
  is overwritten).
- **REQ-AGENT-4:** The agent's work set is the notes whose **effective** status is open (including
  outdated ones). Because the notes file's `status` is refreshed only while the extension is running
  (REQ-AGENT-9), the agent MUST compute effective status itself by joining the responses file: a note
  whose newest turn across both files is an agent response is addressed, not open, even if the notes
  file still says open. For a reopened note the agent MUST read the whole thread; the newest reviewer
  turn is the instruction.
- **REQ-AGENT-5:** When a response carries an anchor, the thread MUST relocate to it (across files if
  needed) and MUST NOT be flagged outdated by the addressing edit itself; the original snapshot stays
  visible as context. Without an anchor, normal re-anchoring (REQ-ANCHOR-2/3) applies. An anchored
  response to a **base-side** note moves the thread to the working-tree side from then on (its `side`
  becomes working; the view drops the base indicator; subsequent re-anchoring follows working-tree
  rules). A structurally valid anchor that does not resolve (missing file, out-of-range line) MUST be
  ignored entirely — no relocation, no side flip — falling back to normal re-anchoring.
- **REQ-AGENT-6:** The extension MUST merge responses into threads by note id automatically as the
  responses file changes (no manual refresh), so agent progress appears live: reply added, status
  flips to addressed. Responses referencing unknown/deleted note ids MUST be ignored. A response
  landing on an already-**resolved** note merges its turn into the thread but MUST NOT change the
  status — an explicit reviewer resolve is never overridden by a late agent response.
- **REQ-AGENT-7:** A new companion skill `review-notes` MUST ship in the existing plugin (alongside
  `cluster-review`), documenting the contract (locations, schemas, rules REQ-AGENT-2..5) such that a
  session prompted "address my review notes" performs the full loop. It MUST instruct agents to locate
  target code by snapshot content rather than trusting line numbers, to compute the effective work set
  per REQ-AGENT-4 (never re-addressing a note it already responded to), and to never write the notes
  file.
- **REQ-AGENT-8:** Malformed contract files MUST NOT crash the extension. An invalid responses file is
  surfaced as a non-fatal warning and otherwise ignored (mirroring clusters-contract behavior). An
  invalid or unknown-version **notes** file is surfaced as a warning and treated as **read-only
  broken**: existing notes are not rendered, and the extension MUST NOT rewrite or truncate the file
  (never "treat as empty and overwrite" — no data destruction); adding notes is unavailable until the
  file is fixed or removed.
- **REQ-AGENT-9:** The extension MUST refresh the derived fields it persists in the notes file
  (current position, outdated flag, and **status** — including flips to addressed caused by merged
  responses) as part of its watcher-driven refresh, so the contract is near-current and a second agent
  run does not re-address already-addressed notes; agents MUST still treat position and outdated as
  best-effort hints and locate code by snapshot content (REQ-AGENT-7).

## 6. REVIEW NOTES view (VIEW)

- **REQ-VIEW-1:** A new **REVIEW NOTES** section MUST appear in the SCM sidebar as a sibling of DELTA
  REVIEW (independent header, collapsible independently).
- **REQ-VIEW-2:** Notes MUST be grouped by file. File headers MUST show basename plus dimmed directory
  path (disambiguating same-named files), full path in the tooltip, and a note count.
- **REQ-VIEW-3:** Each note row MUST show a status icon (open / addressed / resolved), the note text
  (first line, truncated), and its current line reference (with a base-side indicator for left-side
  notes).
- **REQ-VIEW-4:** Clicking a note row MUST open that file's review diff (the same diff the Delta
  Review panel opens) with the note's thread revealed at its current position.
- **REQ-VIEW-5:** The view MUST update live: reviewer actions, agent responses, and re-anchoring after
  edits are reflected without manual refresh.
- **REQ-VIEW-6:** The view title MUST offer **Clear Resolved**, deleting all resolved notes for the
  branch.
- **REQ-VIEW-7:** With no notes on the branch, the view MUST show an empty message telling the
  reviewer how to add one (hover a line in a review diff, click `+`).
- **REQ-VIEW-8:** Switching branch or repository MUST swap the view to that branch's notes (same
  branch-follows-SCM behavior as the existing panel).

## 7. Existing behavior preserved (PRESERVE)

- **REQ-PRESERVE-1:** The DELTA REVIEW tree, its groups, hover actions, badges, status bar, cluster
  grouping, and auto-review behavior MUST be unchanged by this feature (no note counts there).
- **REQ-PRESERVE-2:** The clusters contract file and its watcher behavior MUST continue to work; the
  notes/responses files MUST NOT collide with `clusters-<sanitized-branch>.json` naming.
- **REQ-PRESERVE-3:** Threads MAY additionally appear in VS Code's built-in Comments panel (automatic
  aggregation); no behavior is built for or against it.

## Out of Scope

- Multi-user discussion (one reviewer voice, one agent; no additional human participants).
- Syncing notes to GitHub PR comments or any remote service; cross-machine sync.
- Hand-off/export buttons or snapshot-freeze steps (v1 mock's ⇪ button was removed by decision).
- Note counts on DELTA REVIEW file rows (removed by decision; counts live in REVIEW NOTES only).
- Agent-initiated notes (the agent never creates threads, only responds).

## Deviations from goals

- Goals state left-side notes "anchor to the immutable base blob and never move." DEVELOPMENT.md shows
  the diff's base is not fixed (merge base → last-reviewed snapshot; rebases move the merge base), so
  REQ-ANCHOR-2/4 deliberately supersede that wording with the base-progression re-mapping model. Do
  not "fix" the requirements back toward the goals text.

## Assumptions

- **Commenting surface:** commenting ranges are offered on documents belonging to the current review
  set (the right side's `file://` document and the left side's `delta-review-base` document). The
  right-side document is the same document as the normal editor, so threads and the `+` gutter may
  also appear when that file is opened normally — acceptable (matches how PR extensions behave), and
  threads there still follow REQ-ANCHOR rules.
- **Timestamps:** turn ordering within a thread uses recorded timestamps; the extension tolerates
  clock skew by falling back to file-order within each writer's file.
- **Deleted-file diffs:** notes remain visible in the REVIEW NOTES view for deleted files; clicking
  opens the review diff for the deletion (right side empty), with outdated threads shown on the
  closest available position.
- **Renames:** when the review model already tracks a move (`movedFrom`), notes follow the file to its
  new path; otherwise a rename reads as delete+add and notes go outdated on the old path.
- **Agent identity:** all agent turns render as author "Claude" regardless of which agent wrote the
  responses file; no per-agent identity model.
- **Edited turns:** editing a reviewer turn does not change thread status (status still derives from
  last speaker); editing an outdated note's text does not clear the outdated flag.
- **Concurrent runs:** one agent run at a time is assumed (matching the state-file convention of the
  clusters workflow); simultaneous runs appending to the responses file are not corrupted by design
  (append + merge by id) but are not otherwise coordinated.
- **Note length:** no enforced limit on note text; the view truncates display to the first line.
- **Detached HEAD:** notes are keyed by branch name; with no current branch (detached HEAD) the notes
  feature is unavailable, matching how branch-keyed review state behaves there.
- **File leaves the review set:** if a noted file drops out of the review set (edits reverted, or the
  change absorbed into the base by a rebase), its notes survive and stay listed in REVIEW NOTES.
  Clicking such a note opens the plain file at the note's current position (there is no review diff to
  open). Existing threads render on any open document of a noted file; only the offering of *new*
  commenting ranges is limited to review-set documents.
