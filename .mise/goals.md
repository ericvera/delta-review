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

## Open questions

1. Markdown for agent turns only, or reviewer turns too?
2. How the agent signals pending, and whether the schema version bumps.
3. Pending note: reply box, badge count, resolvable?
