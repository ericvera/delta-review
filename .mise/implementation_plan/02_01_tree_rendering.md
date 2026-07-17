# Task 2.1: R badge, move descriptions, and tooltip

## Goal

Move rows render like the built-in git view's staged renames: an `R` badge in the renamed decoration color, the origin path dimmed in the row description (`<dir> ← <old>` in list mode, `← <old>` in tree mode), and a "Moved from" tooltip line.

## Requirements addressed

REQ-REND-1, REQ-REND-2, REQ-REND-3, REQ-REND-4, REQ-REND-5, REQ-REND-6, REQ-STATE-3

## Background

Delta Review is a VS Code extension listing files changed since the merge base in a Source-Control-style tree. Task 1.2 added the required field `movedFrom: string | undefined` to `ReviewFile` (`src/model.ts`) — the old repo-relative path when git paired the file as a rename; such files have exactly one row, at the new path. They are never `deleted` (a rename destination exists in the working tree), and `existsInMergeBase` is `false` for them.

Rendering today:

- `src/decorations.ts` — `ChangeKind = "modified" | "added" | "deleted"` (line 8); `changeKindFor` (10–11) maps a `ReviewFile`; the kind travels in the row URI query (`createReviewItemUri`, 15–20) and `DECORATIONS` (49–65) maps kind → `vscode.FileDecoration(badgeLetter, tooltip, themeColor)` using `gitDecoration.modifiedResourceForeground` etc. A move currently renders as `added`.
- `src/treeProvider.ts` file-row branch of `getTreeItem` (385–431):
  - contextValue (392–396): status value + `Deleted` suffix (the suffix hides Open File via package.json `when` clauses — move rows must never get it; they won't, since `file.deleted` is false).
  - Description (399–414): `showDirectory` = `alwaysFlat` row or list mode; `directoryText` = `dirname(file.path)` unless `"."`; grouped reviewed rows append `✓` (`${directoryText} ✓` or bare `"✓"`).
  - Tooltip (417–425): `MarkdownString` starting with `appendCodeblock(file.path, "text")`, then `appendMarkdown` lines for "Deleted from the working tree" / "Changed since last reviewed".

Mock reference (`.mise/mocks.html`): scenario 1 (list mode, `src/core ← src/utils/config.ts`), scenario 2 (tree mode, `← src/utils/config.ts`), scenario 3 (tooltip).

## Files to modify/create

- `src/decorations.ts` — `renamed` change kind + decoration
- `src/treeProvider.ts` — move-aware description and tooltip

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `src/decorations.ts`:
   - Extend `ChangeKind` with `"renamed"`.
   - `changeKindFor`: return `"renamed"` when `file.movedFrom !== undefined`, checked before the existing `existsInMergeBase` ternary (`deleted` first or after is equivalent — a move is never deleted — but keep `deleted` first for shape: `deleted ? "deleted" : movedFrom ? "renamed" : …`).
   - Add a `DECORATIONS.renamed` entry: badge `"R"`, tooltip `"Moved since merge base"`, color `new vscode.ThemeColor("gitDecoration.renamedResourceForeground")` — mirroring the three existing entries (REQ-REND-1).
2. `src/treeProvider.ts` description (399–414): build the move origin text when `file.movedFrom` is defined: `← ${file.movedFrom}`. Compose the row description as:
   - moved + directory shown (`showDirectory` true and `directoryText` defined): `${directoryText} ← ${file.movedFrom}` (REQ-REND-2);
   - moved otherwise (tree mode, or root-level file in list mode): `← ${file.movedFrom}` (REQ-REND-3 and the root-dir case of REQ-REND-2);
   - not moved: today's `directoryText`;
   - then the existing `reviewedMark` logic appends `✓` to whatever text resulted, or is bare `"✓"` when there is no text (REQ-REND-5) — restructure so the ✓ suffix applies uniformly to the composed description rather than only to `directoryText`.
3. Tooltip (417–425): after the `file.path` codeblock, when `file.movedFrom` is defined, `appendMarkdown(\`Moved from \${file.movedFrom}\`)` alongside the existing note lines (REQ-REND-4). Keep the existing notes untouched.
4. No contextValue changes: move rows keep `needsReviewFile`/`reviewedFile`, so click-to-diff, Open File, and Mark/Unmark Reviewed all behave as on any live file (REQ-REND-6). Auto-triage routing is untouched — a moved file lands in Auto only if its new path matches the user's globs/attributes, never for being a move (REQ-STATE-3).

## Testing suggestions

- The description/tooltip logic lives in `treeProvider.ts`, which imports `vscode` and thus cannot be unit-tested (config Test conventions). If you extract a pure description-composer helper into a vscode-free module, colocate tests; otherwise verify manually.
- Manual (F5 dev host, per DEVELOPMENT.md): with one pure move and one move+edit on a branch — list mode shows `dir ← old/path` + R badge in the renamed color; tree mode shows `← old/path` under the new folder; hover shows the path codeblock + "Moved from"; mark one reviewed under cluster grouping and confirm the `✓` still appends after the move description.

## Gotchas

- `appendMarkdown` renders the old path as markdown — path characters in normal repos are fine, but keep the existing pattern (plain text, no backticks) consistent with the "Changed since last reviewed" lines.
- The `✓` currently concatenates onto `directoryText` only; if you leave that structure untouched a moved+reviewed row in a cluster would lose either the origin or the mark — this is the one real restructuring in the task.
- `gitDecoration.renamedResourceForeground` is a standard VS Code theme color (used by the built-in SCM view) — do not invent a custom color contribution.

## Verification checklist

- [ ] `yarn test`, `yarn lint`, `yarn build` all pass
- [ ] Dev-host checks above match mock scenarios 1–3 (R badge/color, list + tree descriptions, tooltip, ✓ append)
- [ ] End-to-end tests: none automated — visual/extension-host behavior; config Test exceptions apply (no e2e infrastructure; purely visual changes verified manually in the dev host)
