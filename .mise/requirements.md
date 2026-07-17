# Requirements

This document specifies the user-facing requirements for the Reviewed bucket in Delta Review's grouped (cluster) view. The ungrouped view already places reviewed files in a top-level Reviewed group; this feature brings the grouped view to the same model. Approved mock: scenario 1A (main), 2 (tree mode), 3A (empty state).

## 1. Grouped view structure

- **REQ-STRUCT-1:** In grouped mode, the view MUST render a top-level **Reviewed** bucket as the last root item, after the clusters (contract order), Unclustered, and Auto.
- **REQ-STRUCT-2:** The Reviewed bucket MUST always be present while grouping is effective — including when nothing is reviewed yet, where the header renders with count `0` and has no child rows.
- **REQ-STRUCT-3:** Cluster, Unclustered, and Auto buckets MUST render only files whose status is Needs Review; reviewed rows MUST NOT appear inside them. (A bucket's *membership* — used by counts and header bulk actions — still spans all its files, reviewed included; rendering is the only thing filtered.)
- **REQ-STRUCT-4:** The Unclustered and Auto buckets MUST be hidden when they contain no needs-review files (they hold no rows anymore; their reviewed members live in the Reviewed bucket).
- **REQ-STRUCT-5:** A cluster whose files are all reviewed MUST remain in the root list with its `n/n` count and MUST show a single dim, non-actionable message row reading `All files reviewed.` when expanded.
- **REQ-STRUCT-6:** A cluster with no files in the current change MUST keep the existing message row `No files from this cluster are in the current change.` (unchanged behavior; the two messages are distinct states).

## 2. Reviewed bucket contents and rendering

- **REQ-REV-1:** The Reviewed bucket MUST contain every reviewed file in the review set, regardless of origin — real clusters, Unclustered, and Auto alike.
- **REQ-REV-2:** The Reviewed bucket MUST NOT subdivide its contents (no Auto subgroup, no per-cluster grouping).
- **REQ-REV-3:** The Reviewed bucket MUST honor the current list/tree toggle: in list mode a flat, path-ordered list with the directory in each row's description; in tree mode a single directory tree (folders first, then files, alphabetical — same ordering as elsewhere).
- **REQ-REV-4:** Reviewed rows MUST keep their existing muted color treatment and M/A/D/R letters. The `✓` description suffix on grouped reviewed rows MUST be removed everywhere — Reviewed-bucket membership is the reviewed signal.
- **REQ-REV-5:** Reviewed rows MUST behave like ungrouped Reviewed rows: clicking opens the review diff, hover offers **Open File** (except deleted files) and **−** (unmark). Unmarking moves the file out of Reviewed on the next render, into whichever bucket the normal cluster rules currently resolve it to — except that with `deltaReview.autoReview.markAutomatically` on, an unmarked auto file is re-marked on the next refresh and stays in Reviewed, exactly as that setting behaves today (this exception applies to every unmark path: inline `−`, folder `−`, and header unmark-all).
- **REQ-REV-6:** The Reviewed bucket header MUST offer the bulk **−** (unmark all) action unconditionally, matching the ungrouped Reviewed group header (whose **−** shows regardless of count; at zero files it is a no-op).
- **REQ-REV-7:** The Reviewed bucket header description MUST show the total number of reviewed files (plain count, e.g. `7`).

## 3. Counts

- **REQ-COUNT-1:** Cluster headers MUST keep showing `reviewed/total` counts over the cluster's full membership, so per-cluster progress stays visible after reviewed rows move out.
- **REQ-COUNT-2:** The Unclustered header MUST keep `reviewed/total`; the Auto header MUST keep its existing plain-total-until-first-reviewed, then `reviewed/total` behavior (whenever those buckets are visible per REQ-STRUCT-4).

## 4. Status transitions

- **REQ-FLOW-1:** Marking a file reviewed (inline `+`, folder `+`, cluster header `+`, or Mark All) MUST move its row into the Reviewed bucket on the next render (its former bucket simply no longer renders it); cluster header `+` continues to mark exactly that bucket's needs-review files.
- **REQ-FLOW-2:** A reviewed file whose working-tree content changes from its snapshot MUST return to its origin bucket (re-resolved by the normal cluster rules) as Needs Review, exactly as status derivation works today.
- **REQ-FLOW-3:** Grouping and the Reviewed bucket MUST remain pure presentation: re-renders and lever flips (list/tree, group/ungroup) MUST write nothing to `refs/review/<branch>` (`git ls-tree -r` identical before/after). Mark/unmark actions continue to write through the existing snapshot path — the ref write is what causes the row to move buckets.
- **REQ-FLOW-4:** Cluster header bulk actions MUST stay derived from the cluster's full membership (matching its `reviewed/total` count): `+` while any member needs review, `−` once all members are reviewed — so a fully reviewed cluster's header still bulk-unmarks its members even though their rows render in the Reviewed bucket. (For Unclustered and Auto the `−` state is unreachable: per REQ-STRUCT-4 those headers are hidden once nothing in them needs review.)

## 5. Collapse state

- **REQ-COLLAPSE-1:** The Reviewed bucket MUST start expanded, and its collapse state MUST persist across reloads like other headers.
- **REQ-COLLAPSE-2:** Folder rows inside the Reviewed bucket (tree mode) MUST persist their collapse state, scoped to the Reviewed bucket, and offer the folder-level `−` action. Unlike folder actions elsewhere (which exclude auto files because auto files never render under those folders), folder `−` in the Reviewed bucket MUST cover every visible child of the folder — including reviewed auto files, which render inline here per REQ-REV-2.

## 6. Preserved behavior

- **REQ-PRESERVE-1:** The ungrouped view MUST be unchanged, including its Needs Review/Reviewed groups and their Auto subgroups.
- **REQ-PRESERVE-2:** Contract loading behavior (missing/invalid contract, watcher-driven refresh, grouping lever visibility and fallback) MUST be unchanged.
- **REQ-PRESERVE-3:** The list/tree toggle MUST keep working inside clusters exactly as today (per-cluster folders, folder actions scoped to the cluster).
- **REQ-PRESERVE-4:** The grouped Unclustered and Auto buckets MUST keep rendering as always-flat lists with directory descriptions in both layouts (only the Reviewed bucket follows the list/tree toggle, per the goals).

## 7. Edge cases

- **REQ-EDGE-1:** Deleted reviewed files MUST render in the Reviewed bucket like they do in the ungrouped Reviewed group: row present, no Open File action.
- **REQ-EDGE-2:** Move rows (`R`) MUST keep their `← <old path>` description text in the Reviewed bucket, combined with the directory text in list mode exactly as in the ungrouped groups.
- **REQ-EDGE-3:** The Reviewed bucket's collapse state MUST be tracked separately from the ungrouped Reviewed group's — toggling one mode's header does not affect the other mode.
- **REQ-EDGE-4:** With grouping on and an empty review set, clusters MUST show their existing no-files message and the Reviewed bucket MUST show `0` — no special-casing.

## Out of Scope

- Origin-cluster annotation on Reviewed rows (mock variant 1B — not adopted).
- Hiding the Reviewed bucket when empty (mock variant 3B — not adopted).
- An Auto subgroup inside the Reviewed bucket (explicitly rejected during mock iteration).
- Any change to the ungrouped view, review-state storage, the clusters contract schema, or the cluster-review skill.

## Assumptions

- The Reviewed bucket header uses a check-style icon (per the mock) and needs no tooltip; the message rows reuse the existing dim, non-collapsible, non-actionable message-row treatment.
- The Reviewed header's plain count (REQ-REV-7) includes reviewed auto files — it is the size of the bucket's contents, consistent with what the user sees inside.
