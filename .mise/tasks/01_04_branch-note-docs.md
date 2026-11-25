# 01_04 Public notes contract, internals doc, version bumps

## Goal

Document `"document": "branch"` in the public notes contract, DEVELOPMENT.md and README.md, and bump the plugin to `0.13.0` and the extension to `0.18.0`.

## Files to modify/create

- `plugin/skills/review-notes/SKILL.md`
- `DEVELOPMENT.md`
- `plugin/.claude-plugin/plugin.json`
- `package.json`
- `README.md`

## Background

- Tasks 01_01–01_03 shipped: notes may carry `"document": "branch"` (version 2, no version bump), `file` = the Branch overview file name `branch-<sanitized-branch>.md` matching `^branch-[A-Za-z0-9._-]+\.md$`, `side` always `"working"`; the document lives at `<COMMON_DIR>/delta-review/<file>`. Only the current branch's Branch overview is commentable. Response anchors on document notes are ignored (unchanged). A missing branch document falls back to the creation snapshot, like cluster notes documents. REVIEW NOTES groups them as `Branch overview` (description `branch overview · <n>`, id `notesFile:branch:<file>`, collapse key `notes:branch:<file>`), ahead of cluster notes groups. Detection lives in `documentNoteRefFor` (`src/documents.ts`), called from `documentNoteRef` in `src/commentController.ts`; paths via `documentNotePath`. The Branch overview row tooltip mentions Open Source for notes. Detection compares real paths (`canonicalDir` in `src/documents.ts`, composed with `vscode.Uri.file` in the controller), so differing spellings of the git common dir (symlinks, macOS `/var` vs `/private/var`) still match; threads attach to the tree's path. `__inspect` gains `commentableDocuments`, and each `treeRows` entry gains `commandUri` (the row command's first `Uri` argument, as a string).
- Contract text to change: `plugin/skills/review-notes/SKILL.md:75-77` (`version`/`document` bullet says the value is always `"clusterNotes"`; Document note bullet gives only the cluster notes path; missing-file bullet).
- DEVELOPMENT.md: noteTarget paragraph `:204-206`; section "Notes on cluster notes documents" `:219-226` (says the branch overview offers no commenting ranges; names `clusterNotesFileName`); "Scripted extension-host checks" `__inspect` field list `:247-251`; Documents rows bullet `:147` if it describes the tooltip.
- README.md: Clusters bullet `:69` ("You can leave review notes on a cluster notes document like on any diff."); REVIEW NOTES view bullets `:98` ("Notes on a cluster notes document come first, under `<cluster label> — notes`.") and `:99` ("A cluster notes document note opens that document ...").
- Versions: `plugin/.claude-plugin/plugin.json:4` `0.12.0`; `package.json:5` `0.17.0`.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

- SKILL.md: Keep its Contract / Default workflow structure (CLAUDE.md: binding Contract section, each rule stated once, terse, no motivational prose). Change the `version` bullet to say version 2 adds `document` with value `"clusterNotes"` or `"branch"`. Change the Document note bullet: `file` is the document's file name, at `<COMMON_DIR>/delta-review/cluster-notes-<sanitized-branch>/<file>` for `"clusterNotes"` and `<COMMON_DIR>/delta-review/<file>` (the branch overview, `branch-<sanitized-branch>.md`) for `"branch"`; rest unchanged. Leave the missing-file rule generic. Check nothing in the workflow restates the old single value.
- DEVELOPMENT.md: rename the section to "Notes on review documents" and rewrite its bullets for both kinds (key, version unchanged, detection via `documentNoteRefFor`/`documentNoteRef`, thread, missing document, REVIEW NOTES label/description/order). Mention the realpath comparison and that threads attach to the tree's path. Update the noteTarget paragraph, the `__inspect` field list (`commentableDocuments`: open documents offering commenting ranges; `treeRows` gains `commandUri`), and any tooltip description. Fix any link anchor that pointed at the old heading (`grep -n "notes-on-cluster-notes-documents"`).
- README.md (bullets, one-liner style, user-facing): `:69` says review notes can be left on the Branch overview and on cluster notes documents (Open Source, then select lines); `:98` says Branch overview notes come first under `Branch overview`, then cluster notes document notes under `<cluster label> — notes`; `:99` says a review-document note (Branch overview or cluster notes) opens that document (or its snapshot) at the note. Keep the preview unchanged statement implicit; do not claim notes show in the preview.
- Bump `"version"` in `plugin/.claude-plugin/plugin.json` to `0.13.0` and in `package.json` to `0.18.0`.

## Gotchas

- No `REQ-*` identifiers anywhere.
- Don't run `yarn format` over `.mise/` (prettier ignores it; keep it so).
- `plugin/skills/cluster/SKILL.md` says the branch document is written by another skill and never written by the cluster skill; that stays true — no change there.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test` (docs and version fields only; must stay green).
- Substitute check: `grep -n "clusterNotes\|branch" plugin/skills/review-notes/SKILL.md` shows both values and both paths; `grep -n "clusterNotesFileName\|clusterNotesDocumentLabel\|offers no commenting ranges" DEVELOPMENT.md` returns nothing; `grep -n "Branch overview" README.md` shows the notes bullets; `grep -n '"version"' plugin/.claude-plugin/plugin.json package.json` shows `0.13.0` and `0.18.0`.
