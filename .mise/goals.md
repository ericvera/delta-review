# Goals

The cluster view should have a Reviewed bucket so that any reviewed item moves out of the cluster into reviewed. It is currently hard to tell that something has been reviewed.

## Clarified behavior (user decisions)

1. **One Reviewed bucket at the bottom of the grouped view.** Its contents render flat or as a tree following the current list/tree toggle (unlike Auto/Unclustered, which are always flat).
2. **Fully reviewed clusters stay in place** with their `n/n` count; when expanded they show a dim "All files reviewed" message row (same pattern as the existing empty-cluster message).
3. **All reviewed files move to the Reviewed bucket** — from real clusters, Unclustered, and Auto alike.
4. **Symmetry across views:** reviewed files always live under a Reviewed group in every view. The ungrouped view already behaves this way and is unchanged.

## Consequences

- Clusters, Unclustered, and Auto only ever show needs-review files. Unclustered and Auto keep hiding entirely when they have no needs-review files left.
- Cluster header counts stay `reviewed/total`, so progress per cluster remains visible even though reviewed rows have moved out.
- The in-place `✓` description suffix on grouped reviewed rows is retired — membership in the Reviewed bucket is the signal now.
- Marking a file reviewed moves its row from its cluster into Reviewed; unmarking (or editing the file so it differs from its snapshot) moves it back to its cluster. All derived, no new state.

## Assumptions

- The Reviewed bucket sits last in the view order: clusters → Unclustered → Auto → Reviewed.
- The Reviewed bucket is always visible while grouping is on (like the ungrouped Reviewed group), showing its count — including `0` when nothing is reviewed yet — and starts expanded (collapse state persisted like other headers). Variant 3B in the mock shows the hide-when-empty alternative.
- Mirroring the ungrouped view, reviewed auto files render in a collapsed **Auto** subgroup inside the Reviewed bucket rather than mixed in with hand-reviewed files.
- The Reviewed bucket header offers the bulk `−` (unmark all) action, same as the ungrouped Reviewed group header.
- Grouping remains pure presentation: no lever flip or bucket move touches `refs/review/<branch>`.
