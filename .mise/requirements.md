# Requirements

This document specifies the user-facing requirements for the agentic-change review features: cluster grouping fed by a Claude Code skill, glob-based auto-review triage, and the clustering skill shipped as a Claude Code plugin from this repo.

## 1. View levers (VIEW)

- **REQ-VIEW-1:** The Delta Review panel MUST offer two independent, persisted view levers: **layout** (`flat ⇄ tree`, today's toggle) and **grouping** (`clusters on ⇄ off`), yielding four combinations.
- **REQ-VIEW-2:** Each lever MUST be a title-bar button that swaps its icon to show the state a click switches to (the existing list/tree idiom).
- **REQ-VIEW-3:** The grouping button MUST be present only when a valid clusters contract file exists for the current branch. Without one, the title bar and all grouping-related rendering MUST be identical to current behavior, except for the invalid-contract warning required by REQ-CONTRACT-4 (the Auto subgroup of REQ-AUTO-3 is independent of any contract file).
- **REQ-VIEW-4:** Both lever states MUST persist per workspace across window reloads (as the current view mode does).
- **REQ-VIEW-5:** If the contract file disappears or becomes invalid while grouping is on, the view MUST fall back to ungrouped rendering and hide the grouping button, without erasing the stored grouping preference — a fresh valid contract restores the clustered view automatically.

## 2. Clustered rendering (CLUS)

- **REQ-CLUS-1:** With grouping on, top-level rows MUST be the clusters from the contract file, in contract order, with no Needs Review/Reviewed outer split.
- **REQ-CLUS-2:** Each cluster header MUST show the cluster label, a `reviewed/total` count of its non-auto files (as dim description text), and the cluster `summary` on hover.
- **REQ-CLUS-3:** Cluster membership MUST resolve as: explicit `files` paths win over `patterns`; patterns are evaluated in cluster order; a file explicitly listed by several clusters belongs to the first. Files matching nothing land in **Unclustered**.
- **REQ-CLUS-4:** The Unclustered group MUST render after the clusters (before Auto) with a warning icon, a warning-colored label, and a `reviewed/total` description like clusters. It MUST render whenever it has at least one file of either status (never hidden while non-empty); it MUST be omitted only when it has zero files.
- **REQ-CLUS-5:** Each cluster (and Unclustered) MUST expose a header-level mark-all-reviewed action covering its needs-review files, and an unmark action when all its files are reviewed (mirroring existing group/folder actions).
- **REQ-CLUS-6:** Reviewed files MUST remain visible inside their cluster, rendered dimmed with a ✓ in the description; per-file mark/unmark and open-diff actions MUST work exactly as in existing modes.
- **REQ-CLUS-7:** With layout=flat, cluster members MUST render as a flat list with the file's directory as description. With layout=tree, each cluster MUST nest its members using the existing folder rendering scoped to that cluster: folder collapse state keyed per cluster, folder mark-all actions scoped to files of that cluster under that folder. The Unclustered and Auto groups (including the reviewed Auto subgroup of REQ-AUTO-5) MUST render their contents as a flat list (directory as description) in every layout/grouping combination — auto files never appear in any folder tree (per mock 2B and the approved goals assumption).
- **REQ-CLUS-8:** A cluster referencing only files outside the current review set MUST render as empty without error (`0/0`); expanding it MUST show a single message row ("No files from this cluster are in the current change.", per mock 4). A contract MAY reference files that do not exist.
- **REQ-CLUS-9:** Cluster expand/collapse state MUST persist like existing groups/folders.
- **REQ-CLUS-10:** Switching either lever MUST NOT change any review state.

## 3. Clusters contract file (CONTRACT)

- **REQ-CONTRACT-1:** The extension MUST read clusters exclusively from `.git/delta-review/clusters-<branch>.json` in the active repo, where `<branch>` is the current branch name (sanitized deterministically for filesystem safety; the skill and extension MUST sanitize identically).
- **REQ-CONTRACT-2:** The contract MUST be JSON with a top-level integer `version` and a `clusters` array of `{ label, summary, files?, patterns? }`, where each cluster MUST have at least one of `files`/`patterns` (a refinement of the goals shape: pattern-only catch-all clusters are legal). The extension MUST accept only the version it supports (currently `1`).
- **REQ-CONTRACT-3:** A missing contract file MUST behave exactly like today (no grouping button, no warnings).
- **REQ-CONTRACT-4:** An unreadable, unparsable, schema-invalid, or version-mismatched contract MUST be treated as missing, plus a non-blocking warning in the view's message area naming the problem (e.g. unsupported version → suggest re-running the skill).
- **REQ-CONTRACT-5:** The extension MUST watch the contract path and refresh the view automatically when the file is created, changed, or deleted (e.g. after each skill run), and when the branch changes.
- **REQ-CONTRACT-6:** The extension MUST NOT write, commit, or push contract files; the contract carries no commit/blob shas — freshness comes solely from the existing review-state comparison.

## 4. Auto-review triage (AUTO)

- **REQ-AUTO-1:** Every file in the review set MUST get a triage classification, `auto` or `normal`, computed from exactly two inputs: the `deltaReview.autoReview.globs` setting (array of globs, default `[]`) and the `linguist-generated` attribute from `.gitattributes`. No diff-content analysis of any kind.
- **REQ-AUTO-2:** A file MUST be `auto` when it matches any configured glob OR has `linguist-generated` set; `linguist-generated` applies even when the globs setting is empty.
- **REQ-AUTO-3:** In every view combination, auto files needing review MUST appear in a distinct **Auto** subgroup, collapsed by default: under Needs Review (first, above files/folders) when ungrouped; as a final top-level group (after Unclustered) when grouped — overriding cluster membership and Unclustered assignment alike (auto wins: an auto file matching no cluster still renders under Auto, never Unclustered).
- **REQ-AUTO-4:** The Auto subgroup header MUST show a count — the plain count of its files when they share one status (ungrouped subgroups; grouped before any review), `reviewed/total` in the grouped Auto group once statuses mix — and expose a one-click bulk mark-reviewed action covering exactly the auto files needing review.
- **REQ-AUTO-5:** Auto files MUST never be hidden. Once reviewed: ungrouped mode MUST show them in an Auto subgroup under Reviewed; grouped mode MUST keep them in the top-level Auto group, dimmed with ✓ like reviewed cluster files (the group's count becomes `reviewed/total`). Either way what was auto-approved stays inspectable and each file remains individually unmarkable.
- **REQ-AUTO-6:** When `deltaReview.autoReview.markAutomatically` (default `false`) is true, auto files MUST be marked reviewed automatically on refresh via the normal snapshot path (current blob sha written to the review ref), so any later edit resurfaces the file as a delta.
- **REQ-AUTO-7:** Group-level "Mark All Reviewed" MUST continue to cover every needs-review file, auto and normal alike.
- **REQ-AUTO-8:** Changing `deltaReview.autoReview.*` settings MUST take effect on the next refresh without reload (the extension already refreshes on configuration change).
- **REQ-AUTO-9:** An empty Auto subgroup MUST be omitted, not rendered empty.

## 5. Clustering skill / plugin (SKILL)

- **REQ-SKILL-1:** The repo MUST double as a Claude Code plugin marketplace: `.claude-plugin/marketplace.json` at the root referencing a plugin at `./plugin`, which contains `.claude-plugin/plugin.json` and `skills/cluster-review/SKILL.md`. Extension code MUST be unaffected.
- **REQ-SKILL-2:** Users MUST be able to install via `/plugin marketplace add ericvera/delta-review` then `/plugin install cluster-review@delta-review`.
- **REQ-SKILL-3:** The skill MUST: determine the base branch, diff the current branch against `merge-base(base, HEAD)` including untracked files (the same review set the extension computes), group the changed files into named logical clusters with a one-line `summary` each, and write the version-1 contract JSON to `.git/delta-review/clusters-<branch>.json`.
- **REQ-SKILL-4:** The skill MUST work in both invocation modes with the same output: end-of-task (invoked by/after the agent that made the change, using its knowledge of intent) and on-demand (cold on any branch, inferring groupings from the diff).
- **REQ-SKILL-5:** Re-runs MUST be incremental: read any existing contract, keep cluster identity (labels) stable, assign new/unclustered files, refresh labels/summaries as needed — deriving what changed from the diff, not from bookkeeping in the contract.
- **REQ-SKILL-6:** The skill MUST resolve the base branch as: `deltaReview.baseBranch` from the repo's `.vscode/settings.json` when present, else `main`, and MUST document this in SKILL.md (including the known divergence: the extension reads merged VS Code configuration, so a user-scope `baseBranch` setting is invisible to the skill).
- **REQ-SKILL-7:** The skill MAY use `patterns` only for genuinely glob-shaped catch-all clusters (tests, docs, generated output); explicit `files` are the norm.
- **REQ-SKILL-8:** A schema change MUST bump `version` and update skill and extension in the same commit (they live in this repo precisely for lockstep evolution).

## 6. Preserved behavior (PRESERVE)

- **REQ-PRESERVE-1:** The review-state model is unchanged: per-file blob-sha snapshots in `refs/review/<branch>`, content-based status derivation, diff-against-snapshot for changed-since-review files.
- **REQ-PRESERVE-2:** With no contract file, default auto-review settings, and no `linguist-generated` attributes in effect, every existing behavior — groups, counts, badges, status bar, decorations, commands, collapse persistence, repo switching — MUST be byte-for-byte what it is today.
- **REQ-PRESERVE-3:** M/A/D letters/colors, open-diff titles, deleted-file handling, and the refresh triggers (watcher, save, focus, config, repo state) MUST apply unchanged in clustered rendering.
- **REQ-PRESERVE-4:** The extension MUST keep its zero-working-tree footprint: nothing written outside `.git`, nothing added to `git status`.

## Out of Scope

- Risk scoring or risk-ranked ordering; any hunk/diff-content analysis (whitespace/imports/rename detection); heuristic (non-AI) clustering.
- Sha-based staleness tracking in the contract (no `baseSha`, no per-file blob shas).
- Hiding files from review under any circumstance; changing the review-state model.
- Unclustered-on-top layout (mock 1A — rejected in favor of 1B: last, warning-colored).
- A third "clusters" view mode as a single cycle (superseded by the two-lever design).
- Folder compaction (single-child folder chains render nested, as current tree mode does).
- Cluster editing/authoring UI in the extension (clusters come only from the skill).
- `git-subdir` marketplace source optimization (relative `./plugin` source suffices).

## Assumptions

- Branch-name sanitization for the contract filename replaces `/` (and other non `[A-Za-z0-9._-]` characters) with `-`; documented in SKILL.md so both sides match.
- Cluster `files` paths are repo-relative, `/`-separated, matched exactly (case-sensitive). All glob matching — `deltaReview.autoReview.globs` and cluster `patterns` — uses picomatch semantics against repo-relative paths (goals-gate decision 3; picomatch ships in the extension via the esbuild bundle adopted there).
- `linguist-generated` truthiness follows `git check-attr`: values `set` or `true` mean generated; `unset`/`unspecified`/`false` do not.
- Within a cluster (flat layout) files sort alphabetically; Unclustered and Auto contents likewise. Tree layout inside clusters sorts folders-then-files alphabetically, matching existing tree mode.
- The Auto group renders with a gear icon; Unclustered with a warning icon; cluster headers with a neutral cluster icon — all codicon ThemeIcons.
- Duplicate labels in a contract are tolerated (clusters keep separate identity by index); an empty `clusters` array is valid and yields only Unclustered/Auto groups.
- A deleted-in-working-tree file behaves in clusters/Auto exactly as in existing groups (D decoration, no Open File action).
- `markAutomatically` marking happens as part of the refresh cycle; it does not fire for files that are already reviewed, and it never unmarks.
- The status bar and view badge keep their current semantics (counts across all files, regardless of levers).
- The grouping preference is stored in workspace state alongside the existing view-mode key.
- The plugin's SKILL.md is the skill implementation (prompt instructions); no executable code ships in the plugin.
- Intentional: with grouping on there is no view-wide "Mark All Reviewed" row (no Needs Review group exists); bulk approval is per cluster/Unclustered/Auto, matching the mocks. The command palette `deltaReview.markAllReviewed`/`unmarkAllReviewed` commands keep working regardless of levers.
