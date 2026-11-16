# 01_01 Markdown note bodies

## Goal

Render review-note turns, both the reviewer's and Claude's, as markdown in the inline comment threads and in the REVIEW NOTES row tooltip. Today they are escaped to literal text. All other escaped surfaces stay escaped.

## Files to modify/create

- src/commentController.ts
- src/notesTreeProvider.ts
- src/markdown.ts (header comment only)
- DEVELOPMENT.md

## Background

- Delta Review is a VS Code extension. Review notes are threads rendered through the VS Code Comments API (`src/commentController.ts`) and listed in a REVIEW NOTES tree view (`src/notesTreeProvider.ts`).
- Turn bodies are escaped on purpose today:
  - `commentsFor` at `src/commentController.ts:214-238` does `body.appendMarkdown(escapeMarkdownText(turn.text))` (line 218).
  - The row tooltip at `src/notesTreeProvider.ts:150-151` does `tooltip.appendMarkdown(escapeMarkdownText(thread.turns[0]?.text ?? ""))`.
- `escapeMarkdownText` (`src/markdown.ts:25-35`) keeps its other callers: `src/moveDisplay.ts:216`, `src/provenance.ts:43`, `src/treeProvider.ts:554,558`. Do not touch them, and do not change the function's behavior or tests.
- Precedent for an unescaped body: provenance threads use `new vscode.MarkdownString(body)` (`src/commentController.ts:472`).
- Comment identity is `CommentDisplay` in `src/threadRender.ts:25-50`, fed by `displayFor` (`src/commentController.ts:240-252`). It compares `bodyText` and `bodyIsMarkdown`. Rendered turns stay `MarkdownString`, so `bodyIsMarkdown` stays true and `bodyText` becomes the raw markdown. Neither function changes.
- Edit mode swaps in `NoteComment.turnText` (the raw text). That is unchanged.
- Design decision: markdown loses the hard-line-break height trick (`src/markdown.ts:12-24`), and that is accepted. A single newline inside a paragraph now soft-wraps, as in standard CommonMark.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

1. In `src/commentController.ts`, change `commentsFor` to call `body.appendMarkdown(turn.text)`. Keep the outdated suffix (`\n\n*line was: …*`) exactly as it is. Drop the `escapeMarkdownText` import if it becomes unused. Update the `NoteComment.turnText` comment ("`body` holds display markdown (escaped, …") so it says the body is the rendered markdown.
2. In `src/notesTreeProvider.ts:151`, append `thread.turns[0]?.text ?? ""` raw. Drop the import if it becomes unused.
3. In `src/markdown.ts`, the header comment says "in review note bodies". Reword it to name the surfaces that still use it: file and move notes in the review tree, provenance, and move display. Leave the rest of the comment alone.
4. DEVELOPMENT.md "Long notes" section (around lines 192-198):
   - Replace the sentence saying `commentsFor` puts `escapeMarkdownText(turn.text)` in the body verbatim with: turns render as markdown, in full, with no budget, truncation or escape hatch.
   - Delete the "Height tracks the text" bullet, or reduce it to one line stating that markdown rendering gives up the hard-line-break height trick.
   - Keep the other bullets.
   - Also check manual test step 46: "Blank lines inside a note still separate paragraphs" is still true. Add to the step that `**bold**` and inline code in a note or reply render formatted.
   - Follow CLAUDE.md: terse, every line normative, each rule stated once.

## Gotchas

- An unclosed code fence in a turn would swallow the appended `*line was: …*` suffix. That is accepted; do not add fence-closing logic.
- Do not set `isTrusted` or `supportHtml` on the `MarkdownString`. Note text is user and agent content.
- Row labels (`noteLabel`) stay plain text. Markdown source shows raw there, and that is out of scope.
- Do not touch `escapeMarkdownText` or `src/markdown.test.ts`.

## Verification

- Run `yarn lint`, `yarn build` and `yarn test`. All must pass.
- No pure function changes, so no new unit test. Substitute check: `grep -n escapeMarkdownText src/commentController.ts src/notesTreeProvider.ts` returns nothing, and `grep -rn escapeMarkdownText src` still lists `moveDisplay.ts`, `provenance.ts` and `treeProvider.ts`.
- Do not launch a VS Code test instance. The manual check is DEVELOPMENT.md step 46, done by the owner.
