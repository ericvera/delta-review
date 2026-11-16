# 01_05 Contract amendment, plugin version bump, and docs for pending replies

## Goal

Update the agent-facing review-notes contract so agents can post a pending reply (`pending: true`). Pending notes stay actionable on the agent's next run. The schema-change rule exempts additive optional keys. Bump the plugin version, and document pending status and read/unread in DEVELOPMENT.md and README.md.

## Files to modify/create

- plugin/skills/review-notes/SKILL.md
- plugin/.claude-plugin/plugin.json
- DEVELOPMENT.md
- README.md

## Background

What the extension does after tasks 01_02–01_04:
- The responses-file entry accepts an optional boolean `pending`. Any other type rejects the whole file with `"pending" must be a boolean`. `pending: false` equals absent.
- A note whose newest turn is an agent reply with `pending: true` derives status **pending**. It shows a purple clock and the label "Pending", keeps the reply box ("Reply & Reopen"), is resolvable, and counts in the view badge.
- In the notes file, pending persists as `"addressed"` (`persistedStatus` in `src/noteThreads.ts`), so the notes-file schema is unchanged.
- Read/unread is local to VS Code workspace state (`deltaReview.pendingReadMarks`, logic in `src/pendingRead.ts`), keyed per note to the newest agent turn's `at`. Mark as Read (`deltaReview.markNoteRead` / `deltaReview.markNoteRowRead`) appears only on unread pending threads and rows. Unread rows show a bold label and the label "Pending • Unread". Read rows show a dimmed clock.
- Older extensions drop the unknown key and show Addressed.
- Task 01_01 made turns render as markdown and already updated DEVELOPMENT.md "Long notes".

SKILL.md sections to change (current line numbers):
- Intro loop sentence `:16` ("flips the note to **Addressed**").
- Responses file example and rules `:68-104`.
- Work set `:117-124`.
- Channel discipline `:126-137`.
- Schema changes `:139-141`.
- Default workflow step 2 `:149`.
- Watch mode wake step `:173`.

DEVELOPMENT.md spots:
- `:141` (responses entry shape `{ noteId, response, at, anchor? }`).
- `:160` (status derivation bullet).
- `:171` (`styleThread` invariants, if they mention statuses).
- `:177` (provenance bullet "every comment menu … gates on one of `openNote`/`addressedNote`/`resolvedNote` or `reviewerTurn`").
- Manual test script steps 32–46 under "Notes:" (`:255-273`).

README.md: Review notes "Lifecycle" bullet `:83`, and the REVIEW NOTES view badge bullet `:96`.

Repo rules (CLAUDE.md):
- SKILL.md and DEVELOPMENT.md are agent-facing.
- SKILL.md keeps a binding **Contract** section plus a separate overridable **Default workflow**.
- Keep them terse, with every line normative and each rule stated once, in the Contract. Workflow steps reference Contract sections by name.
- README uses a one-liner plus skimmable bullets.

Design decisions:
- Questions to the reviewer are plain (non-pending) replies, because the reviewer must act.
- `pending: true` means "you owe more work on this note on a later run."
- A note you marked pending is skipped for the rest of the current session, including across watch-mode rounds. A later invocation picks it up through the Work set.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

1. SKILL.md Contract:
   - **Responses file**:
     - Add an optional `"pending": true` to the parser-rejection list: "`pending` optional; when present must be a boolean."
     - Add one entry-convention rule: "`pending: true` marks a reply that leaves work queued for a later run — the reviewer sees the answer and a Pending status; omit it when the note is done or when you ask the reviewer a question."
     - Do not add `pending` to the JSON example unless a second example entry is clearer. One line in the rules is enough.
   - **Work set**: actionable iff `status` is not `"resolved"` and either the newest turn is a reviewer turn, or the newest turn is your response entry with `pending: true`. Keep the "never trust `status` alone" sentence. Note that the notes file shows a pending note as `"addressed"`.
   - **Channel discipline**: one bullet. "A note you mark pending is skipped for the rest of the session (all watch rounds included); the next invocation picks it up via Work set."
   - **Schema changes**: an additive optional key that older readers ignore (the parser drops unknown keys) needs no `version` bump. Any other change still bumps `version` and updates `src/notes.ts` in the same commit.
   - Intro sentence: the extension flips the note to **Addressed**, or **Pending** when the reply is marked pending.
2. SKILL.md Default workflow:
   - Step 2: "excluding notes skipped earlier this pass" becomes "skipped earlier this session per Channel discipline". Reference only; do not restate the rule.
   - Watch mode wake step: recompute the Work set "minus skipped notes per Channel discipline".
3. `plugin/.claude-plugin/plugin.json`: `"version": "0.9.0"`.
4. DEVELOPMENT.md:
   - `:141`: `{ noteId, response, at, anchor?, pending? }`.
   - `:160`: status derivation adds "agent last with `pending: true` → **pending**", plus "persisted as `addressed` (`persistedStatus`) so older readers still parse the notes file".
   - Add one bullet in the same section covering read/unread. It is workspace state only (`deltaReview.pendingReadMarks`, per branch, keyed to the newest agent turn's `at`, pruned on successful notes loads, logic in `src/pendingRead.ts`), and it never touches the contract files.
   - `:177`: update the gating list to include `pendingNote`/`pendingNoteUnread`.
   - Manual test script: add a step after 36. Append a response with `"pending": true`, and check:
     - The thread shows Pending • Unread with a purple clock, a bold row, the tooltip "Status: pending (unread)", a reply box, Resolve available, and the badge counting it.
     - Expanding or opening it does not mark it read.
     - Mark as Read on the thread or the row dims the clock and the action disappears.
     - Another pending reply makes it unread again.
     - A non-pending reply → Addressed. Reply & Reopen → Open.
     - The notes file shows `"status": "addressed"`.
     - `"pending": "yes"` → a responses warning.
5. README.md:
   - The Lifecycle bullet adds: **Pending** → the agent answered but queued more work; you can read, reply, or resolve; **Mark as Read** clears its unread highlight.
   - The badge bullet says pending notes count.
   - Mention that note text renders as markdown.

## Gotchas

- Do not change the responses `version` in any example (it stays `1`).
- The contract must not mention read/unread state. Agents never see it.
- Per memory, `.mise/` and `.claude/` stay in `.prettierignore`. Do not run `yarn format` over them.
- Do not bump the extension `package.json` version. That happens at release.

## Verification

- Run `yarn lint`, `yarn build` and `yarn test`. All must pass. These are docs and JSON only, so this confirms nothing else broke.
- Substitute checks:
  - `grep -n '"version"' plugin/.claude-plugin/plugin.json` shows `0.9.0`.
  - `grep -n "pending" plugin/skills/review-notes/SKILL.md` shows the Responses file, Work set, Channel discipline and Schema changes mentions, and no restatement in the workflow beyond a reference.
  - Read SKILL.md top to bottom to confirm each rule is stated once.
