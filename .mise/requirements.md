# Requirements

This document specifies the user-facing requirements for showing moved files as moves in the Delta Review view.

## 1. Move Detection

- **REQ-DET-1:** A file that git's rename detection reports as renamed between the merge base and the working tree MUST appear as a single review entry at its **new path**.
- **REQ-DET-2:** The old path of a detected move MUST NOT appear as a separate deleted entry anywhere in the view.
- **REQ-DET-3:** Detection MUST rely solely on git's built-in rename detection at its default similarity threshold. The extension MUST NOT implement its own content-similarity or exact-hash matching.
- **REQ-DET-4:** Changes git does not pair as a rename MUST keep today's rendering (separate added + deleted entries). This explicitly includes:
  - a move whose new path is untracked (e.g. moved via Finder without staging), and
  - a move with edits below git's similarity threshold.

## 2. Row Rendering (mock scenarios 1–3)

- **REQ-REND-1:** A moved file's row MUST show an `R` badge using VS Code's renamed decoration color (`gitDecoration.renamedResourceForeground`), in place of the A/M/D letters.
- **REQ-REND-2:** In list mode (and in always-flat placements: the Auto subgroup, grouped Auto/Unclustered buckets), the row description MUST read `<new directory> ← <old repo-relative path>` (mock 1). When the new path sits at the repo root, the description is `← <old repo-relative path>`.
- **REQ-REND-3:** In tree mode, where the hierarchy already conveys the new location, the row description MUST read `← <old repo-relative path>` (mock 2).
- **REQ-REND-4:** The row tooltip MUST lead with the full new path (existing behavior) and add a `Moved from <old repo-relative path>` line (mock 3). Existing status notes that can apply to a move row ("Changed since last reviewed") continue to stack beneath.
- **REQ-REND-5:** Under cluster grouping, a reviewed moved file MUST still append the ✓ mark after its description, as reviewed rows do today.
- **REQ-REND-6:** Move rows MUST keep the standard actions of a non-deleted file row: click opens the review diff, and the inline hover actions (Open File, Mark/Unmark Reviewed) behave as on any existing file (mock 1). The deleted-row convention of hiding Open File never applies to a move row.

## 3. Diff Behavior (mock scenarios 4A/4B)

- **REQ-DIFF-1:** When the diff base is the merge base, opening a moved file MUST diff the **old path's content at the merge base** against the **new path's working-tree file**, so a pure move shows the editor's standard "files are identical" state and a move-plus-edit shows only the edits on top of the move.
- **REQ-DIFF-2:** The diff title MUST indicate the origin using the **full old repo-relative path**, e.g. `config.ts (moved from src/utils/config.ts — merge base ↔ working tree)`, alongside the existing base labels ("merge base" / "last reviewed"). (The mock abbreviates the origin to the old directory; the full path is required so a same-directory rename — where old and new directories are equal — still shows a meaningful origin.)
- **REQ-DIFF-3:** After a moved file is marked reviewed and then edited again, the diff MUST use the last-reviewed snapshot as its base (existing delta-review behavior), with the "last reviewed" label as today. That snapshot was captured from the new path, so in this case the left side is the snapshot content, not the old path's merge-base content.

## 4. Review State and Counts

- **REQ-STATE-1:** A detected move MUST be reviewed as a single unit keyed by the new path: one mark-reviewed action covers the whole move, and no residual review action exists for the old path.
- **REQ-STATE-2:** All counts (group counts, view badge, status-bar `Review m/n`) MUST count a detected move as exactly one file.
- **REQ-STATE-3:** A pure move MUST appear as a normal needs-review entry — never auto-marked and never routed to the Auto bucket by virtue of being a move. (Auto triage still applies if the *new path* matches `deltaReview.autoReview.globs` or is linguist-generated, as for any file.)
- **REQ-STATE-4:** Bulk actions (mark folder/cluster/all reviewed) MUST treat a moved file by its new path, consistent with where its row renders.

## 5. Preserved Behavior

- **REQ-PRES-1:** Files that are not detected moves MUST render and behave exactly as today (rows, badges, diffs, counts, auto-triage, clusters).
- **REQ-PRES-2:** Cluster assignment matches files by path against the contract; a moved file matches by its **new path**. A contract that lists only the old path does not claim the moved file, which then lands in Unclustered like any unclaimed file.

## Out of Scope

- Custom rename/similarity detection of any kind (untracked-file moves, exact-sha matching, configurable thresholds).
- Copy detection (`git diff --find-copies`).
- Directory-level move aggregation (a moved directory renders as its individual moved files).
- Any change to how unstaged Finder-style moves render (mock scenario 5 documents the unchanged fallback).

## Assumptions

- **Auto triage vs. "pure moves stay normal rows" (goals Decision 2).** The goals' "not routed to the Auto bucket" is read as *being a move never causes Auto routing*. Auto triage driven by the file itself — the new path matching `deltaReview.autoReview.globs` or being linguist-generated — still applies to moved files exactly as to any other file (REQ-STATE-3); exempting moved files from the user's own auto-review configuration would be surprising.
- **Stale old-path review state is harmless.** If a file was reviewed at its old path and later moved, the new path has no snapshot, so the move surfaces as needs-review; the old-path entry in the review ref is simply never consulted again. No migration of review-state entries from old to new path is performed.
- **Rename detection runs against the merge base**, matching the existing diff (`merge base ↔ working tree`). The reviewed-snapshot diff base (REQ-DIFF-3) affects only which content the diff shows, not whether a file is classified as a move.
- **Move classification is per-refresh and stateless**: if a later change makes git stop (or start) pairing the rename, the view simply re-renders accordingly on refresh, with no memory of prior classification.
- **The old path shown in descriptions/tooltips is repo-relative**, matching how paths render elsewhere in the extension.
- **Deleted-file handling is unaffected**: a moved file is not "deleted", so deleted-row conventions (strikethrough label, hidden Open File action, sentinel snapshots) never apply to move rows.
