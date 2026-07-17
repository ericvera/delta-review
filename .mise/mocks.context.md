# Mock Context

## Original Description

Use @PLAN.md for details on what we need to build.

(PLAN.md: agentic-change review features — AI-generated cluster view fed by a Claude Code skill via `.git/delta-review/clusters-<branch>.json`, glob-based auto-review triage, and shipping the clustering skill as a Claude Code plugin in this repo.)

## Clarifying Q&A

1. In the new clusters view mode, what is the top-level structure?
   - a. Clusters top-level — each cluster shows all its files, reviewed ones checked/dimmed; header shows reviewed/total
   - b. Keep Needs Review / Reviewed as top groups with clusters nested inside each

   **Answer: a** — clusters top-level.

2. How should auto-review triage (Feature 2) compose with the clusters view mode?
   - a. Auto subgroup only in list/tree modes; clusters mode leaves auto files in their clusters
   - b. Auto subgroup everywhere — clusters mode also pulls auto files into a separate Auto group, overriding cluster membership

   **Answer: b** — Auto subgroup in every view mode.

3. How do we get a glob matcher into the extension (vsce packages with `--no-dependencies`)?
   - a. Add esbuild bundling and use picomatch
   - b. Hand-rolled minimal glob matcher, no bundler

   **Answer: a** — esbuild + picomatch.

4. Can/should the clustered view have a tree version? → settled as: two independent UI levers — layout (flat ⇄ tree) and grouping (clusters on ⇄ off) — giving four combinations; the grouping button only exists when a valid clusters file is present. Supersedes the "third view mode" framing.

(Earlier, during mise setup: Prettier + format-on-save, ESLint + tsc as Check, Vitest for unit tests were added to the repo.)

## New Concepts

- **Cluster** — an AI-authored logical grouping of changed files with a label and one-line summary. New concept, core to the feature; behaves like the familiar folder grouping (expand/collapse, mark-all action), so the learning cost is the idea, not the interaction.
- **Unclustered group** — files in the review set that no cluster claims; deliberately prominent as a scope-creep detector. Reuses the group row idiom.
- **Auto group** — files matching auto-review globs / `linguist-generated`; a collapsed subgroup with one-click bulk approve. Reuses the group row idiom; the ⚙ marker is the only new visual vocabulary.

## UI Tweaks Log

- 2026-07-16 — Offered Unclustered-on-top (1A) vs Unclustered-last-with-warning-color (1B); user chose **1B**. Mock v2 keeps only the chosen layout (scenario 1).
- 2026-07-16 — User: "What about tree views? I don't see those in mockups." → added scenario **2B**: tree mode with the Auto subgroup first under Needs Review (flat file list inside it), folder tree below containing only non-auto files.
- 2026-07-16 — User: "is it possible to have two levers in the UI? clustered/unclustered and tree/flat?" → yes; mock v3 replaces the 3-mode cycle with two icon-swapping buttons (scenario 3), retitles scenario 1 to "Clustered · flat", and adds scenario **1T** "Clustered · tree" (existing folder rendering nested inside each cluster, no compaction).
- 2026-07-16 — User: "ground yourself in existing functionality and what is available in the current API." → mock v2 redrawn to match real TreeView rendering: counts/secondary text as TreeItem `description` (dim text, no count pills); reviewed-in-cluster rows dimmed via decoration color with ✓ in the description (no check icon column — file rows keep icon-theme icons); Unclustered warning color via the existing FileDecorationProvider mechanism; header icons as codicon ThemeIcons; contract warnings via the existing `treeView.message`; view-mode toggle stays the single cycle button driven by context keys. Per-scenario API-mapping notes added to the mock.
