# 01_05 Contract amendment, plugin version bump, and docs for pending replies

## Goal

Update the agent-facing review-notes contract so agents can post a pending reply (`pending: true`). Pending notes stay actionable on the agent's next run. The schema-change rule exempts additive optional keys in the responses file only. Bump the plugin version, and document pending status and read/unread in DEVELOPMENT.md and README.md.

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
- Read/unread is local to VS Code workspace state (`deltaReview.pendingReadMarks`, per repo root and branch, logic in `src/pendingRead.ts`), keyed per note to the newest agent turn's `at`. Mark as Read (`deltaReview.markNoteRead` / `deltaReview.markNoteRowRead`) appears only on unread pending threads and rows; it re-styles in place (`restyleThreads` on the controller plus `notesTreeProvider.setThreads`) and never calls `renderThreads`.
- Unread: the comment thread's label is "Pending • Unread"; the REVIEW NOTES row keeps its `noteLabel` text but renders as a full-span highlight (bold, in the theme's `list.highlightForeground`, usually blue — not white as in the mock), with a purple clock and no dot and the tooltip "Status: pending (unread)". Read: thread label "Pending", dimmed clock, tooltip "Status: pending".
- Older extensions drop the unknown key and show Addressed.
- Task 01_01 made turns render as markdown and already updated DEVELOPMENT.md "Long notes".

SKILL.md sections to change (current line numbers):
- Intro loop sentence `:18` ("flips the note to **Addressed**").
- Responses file example and rules `:76-111`.
- Work set `:119-126`.
- Channel discipline `:128-137` (the existing question-skip bullet is `:134`).
- Schema changes `:139-141`.
- Default workflow step 2 `:148`.
- Watch mode wake step `:173`.

DEVELOPMENT.md spots:
- `:141` (responses entry shape `{ noteId, response, at, anchor? }`).
- `:155` (status derivation bullet).
- `:163-164` (`styleThread` invariants, if they mention statuses).
- `:171` (provenance bullet "every comment menu … gates on one of `openNote`/`addressedNote`/`resolvedNote` or `reviewerTurn`").
- Manual test script steps 32–46 under "Notes:" (`:269-283`). Step 36 (`:273`) includes "Reply & Reopen → it answers again" in watch mode; that behavior must keep working.

README.md: Review notes "Lifecycle" bullet `:83`, and the REVIEW NOTES view badge bullet `:96`.

Repo rules (CLAUDE.md):
- SKILL.md and DEVELOPMENT.md are agent-facing.
- SKILL.md keeps a binding **Contract** section plus a separate overridable **Default workflow**.
- Keep them terse, with every line normative and each rule stated once, in the Contract. Workflow steps reference Contract sections by name.
- README uses a one-liner plus skimmable bullets.

Design decisions:
- Questions to the reviewer are plain (non-pending) replies, because the reviewer must act.
- `pending: true` means "you owe more work on this note on a later run."
- Within one session (watch-mode rounds included), a note is skipped only while its newest turn is still your own pending reply. A newer reviewer turn lifts the skip at once: the reviewer replying clears pending (→ Open), so the note is actionable again in the same session. A later invocation picks up still-pending notes through the Work set.
- The existing question skip ("skip that note for the rest of the pass", SKILL.md:134) keeps its pass scope. Do not widen it to the session; DEVELOPMENT.md step 36 relies on a reviewer reply to a question being answered on the next watch round.

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
   - **Channel discipline**: one bullet. "A note whose newest turn is your own `pending: true` reply is skipped for the rest of the session (all watch rounds included) until a newer reviewer turn arrives — that turn makes it actionable again at once; a later invocation picks still-pending notes up via Work set." Leave the question-skip bullet (`:134`, "for the rest of the pass") unchanged.
   - **Schema changes**: an additive optional key in the responses file needs no `version` bump — older extensions drop unknown keys and never rewrite that file. Every other change, including any notes-file change (additive or not), bumps `version` and updates `src/notes.ts` in the same commit: the extension rebuilds notes from known keys and re-saves them on each refresh, so an older extension would strip a newer notes key.
   - Intro sentence: the extension flips the note to **Addressed**, or **Pending** when the reply is marked pending.
2. SKILL.md Default workflow:
   - Step 2: "excluding notes skipped earlier this pass per Channel discipline" becomes "excluding notes skipped per Channel discipline". The durations (pass for questions; session-until-reviewer-turn for pending) live only in Channel discipline. Reference only; do not restate the rule, and do not write "this session" here.
   - Watch mode wake step: recompute the Work set "minus notes skipped per Channel discipline". A pending note whose reviewer replied since is not skipped, so the wake handles it.
3. `plugin/.claude-plugin/plugin.json`: `"version": "0.9.0"`.
4. DEVELOPMENT.md:
   - `:141`: `{ noteId, response, at, anchor?, pending? }`.
   - `:155`: status derivation adds "agent last with `pending: true` → **pending**", plus "persisted as `addressed` (`persistedStatus`) so older readers still parse the notes file".
   - Add one bullet in the same section covering read/unread. It is workspace state only (`deltaReview.pendingReadMarks`, per repo root then branch — per repo because the extension follows the SCM-selected repo and all repos share one `workspaceState` — keyed to the newest agent turn's `at`, pruned on successful notes loads (including zero-note loads; never on an invalid or missing notes file) only inside the loaded repo's map to present notes and that repo's existing local branches, logic in `src/pendingRead.ts`). Mark as Read re-styles in place (`restyleThreads`, `setThreads`) and never calls `renderThreads`. It never touches the contract files.
   - `:171`: update the gating list to include `pendingNote`/`pendingNoteUnread`.
   - Manual test script: add a step after 36. Append a response with `"pending": true`, and check:
     - The thread label shows Pending • Unread; the row keeps its note text, bold in the list highlight color (usually blue, not white), with a purple clock and the tooltip "Status: pending (unread)"; plus a reply box, Resolve available, and the badge counting it.
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
- The pending skip must never outlive a newer reviewer turn. Check every skip mention (Channel discipline, step 2, watch wake) against this: reviewer replies to a pending note mid-watch → the next wake answers it.
- Per memory, `.mise/` and `.claude/` stay in `.prettierignore`. Do not run `yarn format` over them.
- Do not bump the extension `package.json` version. That happens at release.

## Verification

- Run `yarn lint`, `yarn build` and `yarn test`. All must pass. These are docs and JSON only, so this confirms nothing else broke.
- Substitute checks:
  - `grep -n '"version"' plugin/.claude-plugin/plugin.json` shows `0.9.0`.
  - `grep -n "pending" plugin/skills/review-notes/SKILL.md` shows the Responses file, Work set, Channel discipline and Schema changes mentions, and no restatement in the workflow beyond a reference.
  - Read SKILL.md top to bottom to confirm each rule is stated once.
  - Walk two watch-mode traces against the edited text: (a) agent posts `pending: true`, files change with no new reviewer turn → the note stays skipped; reviewer then replies → the next wake works the note. (b) agent asks a question, reviewer replies → the next round answers it (DEVELOPMENT.md step 36).
