is it possible to render comments with markdown? Also, is there a way for the agent to respond to my notes and I can see it, but it is still marked as... some work pending. Like if I ask a question, the agent can respond an answer, but the state somehow reflects that the work went into a queue so there is more to do.

## Investigation

Not a bug fix. Two features. Nothing reproduced.

1. Markdown is escaped on purpose: `escapeMarkdownText(turn.text)` at src/commentController.ts:217-218; rules src/markdown.ts:25-35; no-escape-hatch rule DEVELOPMENT.md:194-196; REVIEW NOTES tooltip escapes at src/notesTreeProvider.ts:151.
2. Unescaped precedent: provenance threads use `new vscode.MarkdownString(body)` at src/commentController.ts:472. Other `escapeMarkdownText` callers out of scope: src/moveDisplay.ts:216, src/provenance.ts:43, src/treeProvider.ts:554, :558.
3. Raw markdown loses the hard-line-break height trick (src/markdown.ts:12-24). Reviewer edits swap in raw text (`turnText`), DEVELOPMENT.md:164, :194.
4. Comment identity compares `bodyText` and `bodyIsMarkdown` (src/threadRender.ts:25-50); keep `displayFor` consistent (src/commentController.ts:~250).
5. `NoteStatus = "open" | "addressed" | "resolved"` (src/notes.ts:14); parser accepts only those (:185-193). Status derived from last speaker in `mergeThreads` (src/noteThreads.ts:83-88); `workSet` is open-only (:114-115).
6. Status persisted into notes file: `refreshDerived` (src/notesStore.ts:715-718), `recomputeStatus` (:482-500), reply (:473-476). A new status value changes the notes-file schema.
7. Hard-coded statuses: src/commentController.ts:40-51, :309-320; src/threadRender.ts:10-11 (`canReplyFor` addressed-only); src/notesTreeProvider.ts:45-60, :152, :159; src/extension.ts:294-297 (badge = not resolved); package.json `when` clauses :386, :391, :442, :452, :464, :469.
8. `ResponseEntry` = `noteId`, `response`, `at`, optional `anchor` (src/notes.ts:61-66); parser drops unknown keys (:258-262) — a new optional flag is read-compatible (old extension shows Addressed).
9. Contract: plugin/skills/review-notes/SKILL.md:139-141 requires a `version` bump for any schema change, same commit as parser change; version checks reject anything but 1 (src/notes.ts:312-316); responses file append-only (SKILL.md:96); bump also needs plugin version bump (plugin/.claude-plugin/plugin.json).
10. Actionable rule (SKILL.md:119-125) is "newest turn is the reviewer's" — a pending reply would hide the note from the next run's work set; rule must change so pending notes stay actionable for the agent. Channel discipline (SKILL.md:133-136) already lets the agent post a question and skip.
11. Open: pending note keeps reply box? (`canReply` addressed-only; false→true flip forces dispose/recreate, src/threadRender.ts:17-21); badge counts it?; reviewer can resolve it?
12. Docs/tests: DEVELOPMENT.md:155, :273; README.md:83; src/noteThreads.test.ts, src/notes.test.ts, src/markdown.test.ts, src/threadRender.test.ts.
13. Mock condition matches (new status label, icon, thread state).

## Decisions

1. Markdown renders in both reviewer notes and agent replies (comment threads and the REVIEW NOTES tooltip). Other `escapeMarkdownText` callers stay escaped.
2. The agent marks a reply pending with an optional `pending: true` on its responses entry. No schema `version` bump; old extensions ignore the key and show Addressed. The contract's bump rule (SKILL.md:139-141) is amended to exempt additive optional keys that older readers safely ignore.
3. A pending note keeps the reviewer's reply box, counts in the badge, is resolvable, and stays in the agent's work set (actionable) on the next run. It is visually distinct from Open and Addressed (own label, icon, thread state).
4. Pending replies have read/unread. A new pending reply is unread; the reviewer marks it read with an explicit **Mark as Read** action on the thread and on the REVIEW NOTES row (opening/expanding does not mark read). Read state lives only in VS Code workspace state — the notes/responses files and agents never see it. Unread pending shows a highlighted icon; read pending shows a dimmed clock. The badge counts every pending note, read or unread (badge = "not done yet").

## Assumptions

- Pending is a fourth derived status ("pending") persisted like the others; it clears when the agent posts a non-pending reply, the reviewer resolves, or the reviewer replies (→ open).
- Plugin version bumps for the contract text change.
- Reviewer edit still swaps in raw text; markdown loses the hard-line-break height trick and that is accepted.
- Mock: unread pending = bright purple clock with a dot, label "Pending • Unread", bold row; read = dimmed clock, plain "Pending"; Mark as Read uses the `eye` codicon and disappears once read (no Mark as Unread); tooltip says "(unread)".
- Read state is keyed per note to its newest agent turn, so a later pending reply is unread again.
- Mock: Pending icon is the `clock` codicon in purple (charts.purple), purple thread accent; context values `pendingNote` / `noteRow-pending`; tooltip reads "Status: pending"; reply button stays "Reply & Reopen" on pending notes.

## Owner feedback (proposal round 1)

> I want to be able to see when there are "unread" notes. Today it is easy. Anything with a Claude message is something I need to read. But sometimes Claude responds with, I queued the work. This is interesting, but I want to know that this is not resolved, but there is nothing for me to do yet. In the case of pending, right now there is no way to say.. i looked at this

## Proposal

Issue: note bodies are always escaped, and the agent can't answer a note while keeping it visibly queued.
Approach: render reviewer and agent turns as markdown; add a `pending` status (purple clock) set by an optional `pending: true` on a response, kept actionable for the agent, counted in the badge, resolvable, with a workspace-local Mark as Read (unread highlighted, read dimmed); amend the contract and bump the plugin version.
Skips: nothing — spec and critic run because it adds a status and changes the agent-facing contract.
