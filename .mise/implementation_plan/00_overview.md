# Implementation Plan

## Summary

Add a **Reviewed** bucket to Delta Review's grouped (cluster) view: reviewed files move out of their clusters into one always-present bucket at the bottom of the view, making review progress obvious. Clusters keep `reviewed/total` counts, a fully reviewed cluster shows a dim "All files reviewed." row, and the ungrouped view is untouched.

## Design

The load-bearing decision: **bucket membership stays full; only rendering filters.** `ClusterModel`, `clusterFilesForKey`, `clusterCountDescription`, `clusterContextValue`, and every bulk command in `extension.ts` keep operating on full membership (reviewed + needs-review), so header counts and header `+`/`−` semantics (REQ-COUNT-1/2, REQ-FLOW-4) are preserved with zero changes. The tree provider alone decides what to *render*:

```
Grouped root (getChildren, no element)
  cluster c0..cN      — render only needs-review members; body message when none
  unclustered         — pushed only when it has ≥1 needs-review member (flat)
  auto                — pushed only when it has ≥1 needs-review member (flat)
  reviewedBucket      — always pushed; every reviewed file (any triage, any origin)
```

- **New pure helpers in `src/clusters.ts`** (unit-testable, no `vscode` import): status filters and a cluster body-state discriminator (`no-files` → existing message, `all-reviewed` → new message, `has-needs-review` → file rows). The tree provider consumes them.
- **New element kind `reviewedBucket`** in `src/treeProvider.ts`, plus a reviewed-bucket scope on `FolderElement`. Its TreeItem reuses contextValue `reviewedGroup`, so the existing `unmarkAllReviewed` inline `−` menu entry applies unchanged — and that command already unmarks exactly the bucket's contents (all reviewed files). Reviewed rows are ordinary FileElements (`reviewedFile` contextValue → existing `−`/Open File menus). **No `package.json` changes at all.**
- **Collapse keys**: bucket → `reviewedBucket`, its folders → `folder:reviewedBucket:<path>` — distinct namespaces from the ungrouped group's `reviewed` / `folder:reviewed:...` keys (REQ-EDGE-3).
- **`✓` suffix removal**: the `FileElement.grouped` flag exists solely to render the in-place ✓; with reviewed rows gone from clusters the flag is dead code and is deleted (REQ-REV-4).
- **One `extension.ts` touch**: its `folderScopeFiles` learns the reviewed-bucket scope so folder `−` inside the bucket covers auto files that render there inline (REQ-COLLAPSE-2); everything else in extension.ts stands.
- No decoration changes: no status-based coloring exists today, so "rows look like ungrouped Reviewed rows" is automatic.

Testing: pure helpers get Vitest coverage in `src/clusters.test.ts`; tree/extension behavior falls under the config's Test exception (no e2e infrastructure) → manual verification in the F5 Extension Development Host, with DEVELOPMENT.md's manual test script updated to cover the new behavior.

## Assumptions

- The Reviewed bucket header uses `ThemeIcon("check")` per the approved mock; the ungrouped view's headers keep having no icon.
- Reusing contextValue `reviewedGroup` for the bucket header intentionally shares the ungrouped header's menu binding; TreeItem `id` differs (`reviewedBucket` vs `group:reviewed`) so selection/collapse identity never collides (grouped and ungrouped roots never render simultaneously anyway).
- Cluster-scoped folder rows can only exist while a needs-review descendant exists (the tree is built from the filtered list), so their contextValue is always `needsReviewFolder`; the old `hasNeedsReview` folder check becomes unnecessary.
- The existing empty-cluster message text and the new `All files reviewed.` text are exact strings; both render via the existing `message` element kind.

## Phases

- **Phase 1: Pure logic** — status-filter and body-state helpers in `clusters.ts` with unit tests.
- **Phase 2: Rendering and wiring** — tree-provider restructuring for grouped mode, the extension.ts folder-scope fix, and documentation.

## Phase Rationale

Phase 1 lands the testable core first (the only part Vitest can cover) so Phase 2 is pure consumption of verified helpers. Within Phase 2, the tree provider change (2.1) is self-contained and buildable before the extension folder-scope fix and docs (2.2); both tasks end green independently.

## Task Index

| File | Task | Phase | Requirements |
| --- | --- | --- | --- |
| `01_01_pure_helpers.md` | Status filters + cluster body-state helpers in clusters.ts, with tests | 1 | REQ-STRUCT-3/4/5/6, REQ-REV-1 (logic layer) |
| `02_01_tree_provider.md` | Reviewed bucket + needs-review-only cluster rendering in treeProvider.ts | 2 | REQ-STRUCT-1..6, REQ-REV-1..7, REQ-COUNT-1/2, REQ-FLOW-1/2/4, REQ-COLLAPSE-1/2 (rendering), REQ-EDGE-1..4, REQ-PRESERVE-1/3/4 |
| `02_02_folder_scope_and_docs.md` | extension.ts reviewed-bucket folder scope; DEVELOPMENT.md updates | 2 | REQ-COLLAPSE-2, REQ-REV-5/6, REQ-FLOW-1/3, REQ-PRESERVE-2 |
