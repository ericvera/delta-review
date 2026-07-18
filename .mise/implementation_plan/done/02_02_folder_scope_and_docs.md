# Task 2.2: Reviewed-bucket folder scope in extension.ts and documentation

## Goal

Make folder bulk `−` inside the Reviewed bucket cover every visible child (including auto files), and update DEVELOPMENT.md — "How it works" and the manual test script — for the new grouped-mode behavior.

## Requirements addressed

REQ-COLLAPSE-2 (action side), REQ-REV-5, REQ-REV-6, REQ-FLOW-1, REQ-FLOW-3, REQ-PRESERVE-2

## Background

Delta Review is a VS Code extension (SCM sidebar tree). This feature adds a **Reviewed** bucket to the grouped (cluster) view: reviewed files render there instead of inside their clusters. Task 1.1 added pure status helpers to `src/clusters.ts`. Task 2.1 restructured `src/treeProvider.ts`: a new `reviewedBucket` element kind renders last in the grouped root; its folders (tree mode) carry a reviewed-bucket scope marker on `FolderElement` (e.g. `inReviewedBucket?: true` — check the exact name Task 2.1 used) and contextValue `reviewedFolder`; the tree provider's own `folderScopeFiles` resolves that scope to all reviewed files of the model, all triages.

`src/extension.ts` has a parallel `folderScopeFiles` (extension.ts:405-412) used by the folder bulk commands `deltaReview.markFolderReviewed` / `deltaReview.unmarkFolderReviewed` (extension.ts:482-530): cluster scope → `clusterFilesForKey(clusterModel, element.clusterKey)`; otherwise → `model.files` filtered to `triage === "normal"`. The commands then filter by status and `file.path.startsWith(`${element.path}/`)`. Because reviewed-bucket folder elements have no `clusterKey`, they currently fall into the normal-triage branch — folder `−` would silently skip an auto file (e.g. a reviewed `dist/bundle.js`) that visibly sits under that folder in the bucket. The requirement (REQ-COLLAPSE-2) is visible-scope semantics: folder `−` in the Reviewed bucket unmarks every visible child, auto included. (Elsewhere folder actions still exclude auto files — those never render under cluster or ungrouped folders.)

Auto-file caveat that stays true (REQ-REV-5): with `deltaReview.autoReview.markAutomatically` on, `refresh()` re-marks needs-review auto files before the tree updates (extension.ts:213-233), so an unmarked auto file returns to Reviewed on the next refresh — for every unmark path. This is existing behavior; nothing to change, but the docs should state it in the clusters context.

DEVELOPMENT.md documents "How it works" (a "Clusters contract" section with a "ClusterModel flow" subsection describing grouped rendering, including the now-outdated "reviewed files stay marked in place with a `✓`" behavior in the manual script step 18) and a "Manual test script" with numbered steps; steps 17-22 cover clusters.

## Files to modify/create

- `src/extension.ts` — `folderScopeFiles` reviewed-bucket branch + comment update.
- `DEVELOPMENT.md` — ClusterModel flow bullets and manual test script steps.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. In `src/extension.ts`, extend `folderScopeFiles` (extension.ts:405-412) with the reviewed-bucket scope first: when the element carries Task 2.1's reviewed-bucket marker, return `model?.files ?? []` unfiltered by triage (the command's own status+prefix filter narrows it; only reviewed files render under bucket folders anyway). Keep the cluster and normal-triage branches as they are. Update the comment above the function: folder bulk actions cover the folder's *visible* children — auto files render inline in the Reviewed bucket (so they're covered there) but in the Auto bucket elsewhere (so they're excluded elsewhere).
2. The element parameter type is `{ clusterKey?: string }` today — widen it to accept the reviewed-bucket marker (match `FolderElement`'s field, importing the type from `./treeProvider` if that's cleanest).
3. Update `DEVELOPMENT.md` (follow the file's existing style: short bullets, dense, skimmable):
   - "ClusterModel flow" bullets: replace the reviewed-in-place description with the new model — clusters/Unclustered/Auto render only needs-review files; Unclustered/Auto headers hide when nothing in them needs review; an always-present Reviewed bucket renders last (check icon, plain count, follows the list/tree toggle, no subgrouping, contextValue reuses `reviewedGroup` so header `−` = Unmark All); fully reviewed clusters stay with `n/n` + `All files reviewed.` row; counts and header `+`/`−` still derive from full membership; grouping remains pure presentation (lever flips write nothing to `refs/review/<branch>`; mark/unmark writes through the normal snapshot path and that ref write is what moves rows — REQ-FLOW-3).
   - Manual test script: rewrite step 18 (and touch neighbors as needed) to assert the new behavior — reviewed files move to the Reviewed bucket (no in-place `✓`), `All files reviewed.` message, Unclustered/Auto hiding, Reviewed at `0` when fresh, folder `−` in the bucket covering auto files, `markAutomatically` bounce-back behavior, and step 20's `git ls-tree` invariant kept.
4. Run `yarn format` — the Prettier config ignores `.mise/` (keep it that way; formatting workflow dirs breaks mise approval hashes).

## Testing suggestions

- `yarn build`, `yarn lint`, `yarn test` — all green (no new unit-testable logic; the scope branch is three lines inside vscode-coupled code).
- Manual, in the F5 Extension Development Host (config Test exception — no e2e infrastructure): in a repo with a clusters contract and an auto-triaged file (set `deltaReview.autoReview.globs` to e.g. `["**/*.lock"]`), review files across a cluster and the Auto bucket so several land in the Reviewed bucket under a common folder; switch to tree mode; folder `−` on that folder → **every** visible child leaves the bucket, auto file included. Then flip `deltaReview.autoReview.markAutomatically` on and repeat: the auto file bounces back into Reviewed on the next refresh (expected, documented). Confirm `git ls-tree -r refs/review/<branch>` changes only on mark/unmark, never on lever flips (REQ-FLOW-3). Re-run DEVELOPMENT.md manual script steps 21-22 (invalid contract → ⚠ message + ungrouped fallback with preference surviving; deleted contract → button and message disappear) to confirm contract loading/fallback is untouched (REQ-PRESERVE-2).

## Gotchas

- Return `model.files` (all triages) for the bucket scope — reusing the `triage === "normal"` filter is exactly the bug this task fixes.
- Don't reorder the branches so a cluster-scoped folder hits the new branch: cluster folders have `clusterKey` set and must keep cluster scope.
- DEVELOPMENT.md's step numbering is referenced by config Test exceptions and habit — keep the numbered-list structure intact rather than renumbering everything.

## Verification checklist

- [ ] `yarn build`, `yarn lint`, `yarn test` all green
- [ ] Manual dev-host pass: bucket folder `−` unmarks auto children; `markAutomatically` bounce-back confirmed; `git ls-tree` invariant on lever flips; manual script steps 21-22 re-run (REQ-PRESERVE-2)
- [ ] DEVELOPMENT.md describes the Reviewed bucket (flow + manual script) with no stale "stays in place with a ✓" text: `grep -n "✓" DEVELOPMENT.md`
- [ ] End-to-end tests: none — config Test exception (no e2e infrastructure); substitute is the manual dev-host pass above
