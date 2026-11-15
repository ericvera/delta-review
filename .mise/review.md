# Review

## Tasks

- 01_01 (9ac7367) — `src/model.ts`: only whole-file moves count toward the shared-origin rule; a moved file inherits from an origin whose only change is its deletion (still not from an origin that exists on disk). Verify: `src/model.test.ts` inheritance tests; DEVELOPMENT.md manual step 18.
- 01_02 (58525b0) — `src/reviewState.ts`, `src/model.ts`, `src/extension.ts`: new ref `refs/review-predeletion/<branch>` keeps the snapshot a path held before its deletion row was marked, so marking the origin's deletion row no longer cancels inheritance; Clear Review State deletes the ref. Verify: `src/reviewState.test.ts`, `src/model.test.ts`; DEVELOPMENT.md manual step 18a. The Clear Review State change has no extension-host test.
- 02_01 (e6e9517) — `src/clusterChanges.ts` (new, no `vscode` import): file selection, unique titles, messages and the mark guard for the combined cluster diff. Verify: `src/clusterChanges.test.ts`.
- 02_02 (c3b1deb) — `src/extension.ts`, `package.json`: "Open Cluster Changes" command on the cluster row (inline and first in the context menu) opens every needs-review file of the cluster in the multi-diff editor, each against its own base; reopening closes the earlier tab. Verify: scripted extension-host check passed; DEVELOPMENT.md manual steps 31a/31b.
- 02_03 (e825d15) — `src/extension.ts`, `package.json`: "Mark Cluster Reviewed" button in the combined diff's title bar marks only the files the tab listed that still need review; refuses on a renamed cluster, repo or branch switch, ambiguous or duplicate tab, or another group's editor that could own the button. Verify: scripted extension-host check of 8 scenarios passed; DEVELOPMENT.md manual step 31c. Button visibility in the title bar is eyeball-only.
- 02_04 (70d74a8) — `src/extension.ts`: clicking into a file's text in the combined diff selects its row in the pane. Verify: DEVELOPMENT.md manual step 31d (eyeball-only; no scripted check, the test hook cannot read tree selection).

## Open assumptions

- Both tasks ship in this one run and branch.
- The command is titled "Open Cluster Changes" (`$(diff-multiple)`), tab title "Cluster Changes: <label>"; the title-bar button uses `$(check-all)`.
- The Unclustered and Auto buckets get the command too.
- Files are listed in the cluster's path order; a changed-then-deleted file shows an empty right side.
- If nothing needs review at click time an info message says so.
- The combined diff tab stays open after a mark and is not refreshed; reopen it to see current bases.
- Row selection follows clicks only while the combined diff is the active tab; a click on a file's header alone does not select; nothing happens if the pane is hidden.
- Unmarking a moved file that inherits also unmarks the origin's deletion row (accepted).
- An inheriting overwrite destination no longer shows the content it overwrote.
- In a split layout the title-bar button refuses when another group's active tab could also show it (VS Code does not tell the command which tab it was pressed in).
- A cluster whose label itself ends in " (N files)" can make a tab ambiguous; the mark button then refuses.

## Amendments

None.
