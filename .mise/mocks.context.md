# Mock Context

## Original Description

the cluster view should have a Reviewed bucket so that any reviewed item moves out of the cluster into reviewed. It is currently hard to tell that something has been reviewed.

## Clarifying Q&A

1. Where should reviewed items go in the grouped (cluster) view?
   - Answer: one Reviewed bucket at the bottom of the view; its contents render flat or as a tree following the current list/tree toggle.
2. When every file in a cluster is reviewed, what happens to the cluster header?
   - Answer (a): it stays in place with its `n/n` count and shows a dim "All files reviewed" message row when expanded.
3. Do Unclustered and Auto follow the same rule?
   - Answer (a): yes — reviewed files from clusters, Unclustered, and Auto all move to the Reviewed bucket.
4. User confirmed the framing: reviewed files live under a Reviewed group in every view (the ungrouped view already works this way and is unchanged).

## New Concepts

- **Reviewed bucket in the grouped view** — not truly new to the user: it reuses the ungrouped view's existing Reviewed group concept (same label, same `−` unmark affordance), now present under cluster grouping.
- **"All files reviewed." message row** — new state text inside a fully reviewed cluster; reuses the existing dim message-row pattern ("No files from this cluster are in the current change.").
## UI Tweaks Log

- Requested: no further grouping inside the Reviewed bucket — drop the Auto subgroup. Changed: 1A/1B/2 now show reviewed auto files (yarn.lock) inline in the single flat list / tree; the Auto-subgroup rows were removed from all Reviewed buckets.
