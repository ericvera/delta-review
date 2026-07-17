# Implementation Plan

## Summary

Make Delta Review efficient for reviewing large agentic changes: (1) glob-based auto-review triage so mechanical files (lockfiles, snapshots, generated output) can be bulk-approved, (2) a clustered view that groups changed files by AI-authored logical change, read from a contract JSON written by (3) a `cluster-review` Claude Code skill shipped from this repo as a plugin. Two independent view levers (layout flat⇄tree, grouping clusters on⇄off) replace the single list/tree toggle.

## Design

```
                         ┌─ deltaReview.autoReview.globs (settings)
                         ├─ linguist-generated (.gitattributes via git check-attr)
                         ▼
src/triage.ts (pure) ──► triage: 'auto' | 'normal' per file
                                │
src/model.ts ── computeReviewModel ──► ReviewModel { files: ReviewFile[] (+triage) }
                                │
src/clusters.ts (pure core) ──► ClusterModel { clusters[], unclustered[], auto[] }
   ▲  reads .git/delta-review/clusters-<branch>.json (version 1)
   │  membership: explicit files > patterns (cluster order) > Unclustered; auto overrides all
   │
src/treeProvider.ts ──► renders 4 combos: {flat,tree} × {grouped,ungrouped}
src/extension.ts    ──► levers (context keys + workspaceState), contract watcher,
                        auto bulk/auto-mark commands, invalid-contract warning
plugin/…/SKILL.md   ──► writes the contract; .claude-plugin/marketplace.json publishes it
```

- **Data model.** `ReviewFile` gains `triage: 'auto' | 'normal'`, computed in `computeReviewModel` from a pure helper module `src/triage.ts` (picomatch on `deltaReview.autoReview.globs` + `git check-attr linguist-generated`). No other model changes; review state (`refs/review/<branch>`) untouched.
- **Cluster contract.** New `src/clusters.ts`: locate `<git-common-dir>/delta-review/clusters-<sanitized-branch>.json`, parse/validate (version 1, each cluster `{label, summary, files?|patterns?}` with at least one of the two), and resolve membership into a `ClusterModel`. Membership and validation are pure functions (vscode-free, unit-tested); only file loading touches I/O. Invalid/mismatched contract → `undefined` model + a warning string for `treeView.message`.
- **Rendering.** `treeProvider.ts` grows element kinds: `cluster` (real cluster, `unclustered`, or the grouped `auto` group), `autoGroup` (ungrouped Auto subgroup under either status group), and `message` (empty-cluster placeholder). Folder elements gain an optional cluster scope so tree layout works inside clusters with per-cluster collapse keys. Unclustered gets warning icon + label color via the existing decoration mechanism (new query value on the `delta-review-item` scheme). Counts stay TreeItem `description` text.
- **Levers.** Layout keeps `deltaReview.viewMode` (`list`/`tree`). Grouping is a new workspaceState boolean + context keys `deltaReview.clustersAvailable` / `deltaReview.grouped`; two new commands (`groupByCluster`, `ungroupClusters`) drive an icon-swapping title-bar button that exists only while a valid contract exists. Effective rendering = grouped only when enabled AND available, so a vanished contract falls back without erasing the preference.
- **Contract freshness.** The contract is re-read inside every `refresh()` (cheap), plus a dedicated `FileSystemWatcher` on the `.git/delta-review` directory for immediacy (the existing repo watcher never reports `.git` paths). Existing refresh triggers (save, focus, config, repo state) remain the fallback.
- **Plugin.** Static files only: `.claude-plugin/marketplace.json` (root), `plugin/.claude-plugin/plugin.json`, `plugin/skills/cluster-review/SKILL.md`. The skill prompt implements diffing, clustering, incremental re-runs, and contract writing; no extension code involved.
- **Packaging migration.** Switch `out/extension.js` production from `tsc` to an esbuild bundle (`--external:vscode`) so picomatch (first runtime dep) ships despite `vsce --no-dependencies`; `tsc --noEmit` becomes the typecheck. Quality commands in `.claude/mise-config.md` are updated in the same task so `yarn build` keeps meaning "typecheck + build".

## Assumptions

- Branch sanitization for the contract filename: every character outside `[A-Za-z0-9._-]` becomes `-` (documented in SKILL.md; both sides implement it identically).
- `git check-attr` runs once per refresh over the review-set paths only (bounded, not repo-wide).
- The grouped Auto group and ungrouped Auto subgroups collapse-persist under keys `auto:<scope>` via the existing collapsed-set mechanism.
- Contract `files` entries that duplicate each other or escape the repo are simply ignored beyond first-wins resolution — no validation errors for content-level oddities.
- The mise-config Check slot (`yarn lint`, `yarn build`) keeps working: `build` becomes `typecheck + bundle`.
- New codicons: clusters `$(layers)`, Auto `$(gear)`, Unclustered `$(warning)`; grouping button `$(group-by-ref-type)` / `$(ungroup-by-ref-type)`.

## Phases

- **Phase 1: Foundations** — esbuild bundling (unblocks picomatch), then triage classification in the model with unit tests.
- **Phase 2: Auto-review UI** — Auto subgroup + bulk action in the existing list/tree modes; `markAutomatically`. Feature 2 ships complete here.
- **Phase 3: Clusters** — contract reader + membership core with unit tests; grouping lever + contract watching; clustered rendering (flat + tree) with Unclustered/Auto groups and warnings. Feature 1 ships complete here.
- **Phase 4: Plugin** — marketplace + plugin + SKILL.md. Feature 3.
- **Phase 5: Docs & acceptance sweep** — user docs and a scripted manual verification pass in the dev host.

## Phase Rationale

Bundling must land before anything imports picomatch (every task ends green). Triage before the Auto UI because the UI renders the `triage` field. Feature 2 before clusters because the grouped view's Auto group reuses the same triage data and bulk command, and because Feature 2 alone is already shippable value. Cluster core before lever/rendering so the pure logic is testable before UI wiring. The plugin is independent of extension code and comes last before docs; the final sweep exercises the F5 dev host per the config's blanket e2e exception.

## Task Index

| File                            | Task                                                          | Phase | Requirements                                                                 |
| ------------------------------- | ------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| `01_01_esbuild_bundling.md`     | Switch build/package to esbuild bundle; add picomatch         | 1     | (enabler for REQ-AUTO-1, REQ-CLUS-3; goals decision 3)                        |
| `01_02_triage_model.md`         | `triage` on ReviewFile via globs + linguist-generated          | 1     | REQ-AUTO-1, REQ-AUTO-2, REQ-AUTO-8                                            |
| `02_01_auto_subgroup_ui.md`     | Auto subgroups + bulk actions in list/tree modes               | 2     | REQ-AUTO-3, REQ-AUTO-4, REQ-AUTO-5, REQ-AUTO-7, REQ-AUTO-9, REQ-CLUS-7 (auto flat), REQ-PRESERVE-2 |
| `02_02_mark_automatically.md`   | `markAutomatically` auto-marking on refresh                    | 2     | REQ-AUTO-6                                                                    |
| `03_01_clusters_contract.md`    | Contract locate/parse/validate + membership core (pure)        | 3     | REQ-CONTRACT-1, REQ-CONTRACT-2, REQ-CONTRACT-6, REQ-CLUS-3, REQ-CLUS-8, REQ-AUTO-3 (auto wins) |
| `03_02_grouping_lever.md`       | Grouping lever, context keys, contract watching, warnings      | 3     | REQ-VIEW-1..5, REQ-CONTRACT-3, REQ-CONTRACT-4, REQ-CONTRACT-5                 |
| `03_03_clustered_rendering.md`  | Clustered tree rendering: clusters, Unclustered, Auto, actions | 3     | REQ-CLUS-1..10, REQ-AUTO-3..5, REQ-PRESERVE-3                                 |
| `04_01_plugin_skill.md`         | Marketplace + plugin + cluster-review SKILL.md                 | 4     | REQ-SKILL-1..8                                                                |
| `05_01_docs_and_manual_sweep.md`| Docs; full manual acceptance sweep in dev host                 | 5     | REQ-PRESERVE-1..4 (verification), all UI REQs (manual pass)                   |
