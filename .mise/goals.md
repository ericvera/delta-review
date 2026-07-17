# Goals: Agentic-Change Review Features

Make Delta Review efficient for reviewing large agentic changes (50–500 files). Three features: an AI-generated cluster view, glob-based auto-review triage, and a Claude Code plugin (skill) that generates the clusters. Full brief: `PLAN.md` (repo root, committed on this branch) — decisions there are binding; this file adds the clarifications and decisions made at the goals gate.

## Feature 1 — Cluster view

- Third view mode `'clusters'` alongside `'list' | 'tree'`.
- Clusters come exclusively from a contract file written by the Claude Code skill: `.git/delta-review/clusters-<branch>.json` (version field, clusters with `label`, `summary`, `files`, optional `patterns`). No AI code, keys, or model calls in the extension.
- No cluster file → clusters mode unavailable/hidden.
- Explicit `files` win over `patterns`; patterns evaluate in cluster order; a file matching nothing lands in a visually prominent **Unclustered** group (scope-creep detector — never hidden).
- Staleness = existing per-file review state only; no shas in the contract.
- Clusters are presentation only; review state stays per-file in `refs/review/<branch>`.

## Feature 2 — Glob-based auto-review

- Classification inputs only: `deltaReview.autoReview.globs` setting + `linguist-generated` from `.gitattributes`. No diff-content analysis.
- `triage: 'auto' | 'normal'` on `ReviewFile`, computed in `computeReviewModel`.
- Auto files: distinct collapsed subgroup with one-click bulk mark-reviewed.
- Optional `deltaReview.autoReview.markAutomatically` (default false) auto-marks via the normal snapshot path.
- Auto files are never hidden.

## Feature 3 — Clustering skill as Claude Code plugin

- Repo doubles as a plugin marketplace: `.claude-plugin/marketplace.json` at root, plugin under `plugin/` with `skills/cluster-review/SKILL.md`.
- Skill: diff branch vs merge-base with the base branch, group files into named logical clusters (one-line summaries), write the contract JSON. Works end-of-task (agent knows intent) and cold on-demand. Re-runs are incremental: keep cluster identity stable, assign new files, refresh labels.
- Skill resolves the base branch the same way the extension does (`deltaReview.baseBranch`, default `main`), reading VS Code settings files when present; documents its resolution.
- Schema `version` lets the extension reject files from a mismatched skill version.

## Decisions from the goals gate (2026-07-16)

1. **Two independent view levers instead of a third view mode**: layout (flat ⇄ tree, today's toggle) × grouping (clusters on ⇄ off, new button that exists only when a valid clusters file is present). Four combinations; both persist per workspace. When grouping is on, clusters are top-level: each cluster header shows label + reviewed/total (non-auto) count + summary tooltip, with both statuses visible inside (reviewed rows dimmed with ✓ in the description). No Needs Review/Reviewed outer split when grouped. With layout=tree, each cluster nests its files using the existing folder rendering scoped to the cluster (cluster-prefixed collapse keys, folder mark-all scoped to the cluster); with layout=flat, files render list-style with directory as description. This supersedes PLAN.md's "third view mode `'clusters'`" phrasing — same feature, better control surface.
2. **Auto subgroup appears in every view mode.** In clusters mode, auto-triage files are pulled out of their clusters into a distinct Auto group (collapsed, bulk-approvable), overriding cluster membership. Cluster reviewed/total counts therefore count only the cluster's non-auto files.
3. **Bundling: adopt esbuild + picomatch.** Switch packaging from plain `tsc` output to an esbuild bundle so the extension can ship runtime deps; use picomatch for all glob matching (settings globs and cluster `patterns`).

## Assumptions (approved with this document)

- Cluster and file ordering follow the contract JSON order; files within a cluster sort alphabetically like existing groups.
- A file listed explicitly in several clusters belongs to the first listing cluster.
- Invalid JSON or unsupported `version` in the contract file → treated as no cluster file (mode hidden), with a non-blocking warning surfaced in the view.
- If the contract file disappears (or becomes invalid) while grouping is on, the grouping lever disappears and grouping switches off; the layout lever is untouched. The stored grouping preference survives, so a fresh valid contract restores the clustered view.
- The extension file-watches `.git/delta-review/` so skill re-runs refresh the view live.
- The Unclustered group renders after the clusters (before Auto) in warning color with a warning icon (mock 1B chosen at the gate).
- In tree mode, the Auto subgroup sits first under Needs Review with a flat file list inside it; the folder tree below contains only non-auto files.
- Clustered rendering stays within existing TreeView mechanisms: counts as TreeItem `description` text, colors via the FileDecorationProvider, summaries as tooltips, warnings via `treeView.message`, both levers as icon-swapping title-bar buttons driven by context keys (the existing list/tree idiom).
- Group-level "Mark All Reviewed" continues to cover every needs-review file, auto and normal alike; the Auto subgroup's action covers only auto files.
- Marketplace `source` uses the relative `./plugin` form; the documented install slug assumes the repo publishes as `ericvera/delta-review`.
- `deltaReview.autoReview.globs` defaults to `[]` (nothing auto-triaged until configured); `linguist-generated` applies regardless of the setting.

## Out of scope (from PLAN.md)

Risk scoring; any hunk/diff-content analysis; heuristic clustering; sha-based staleness in the contract; hiding files; changes to the review-state model.
