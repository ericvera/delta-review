# Plan: Agentic-Change Review Features

Make Delta Review efficient for reviewing large agentic changes (50–500 files): AI-generated change clusters supplied by a Claude Code skill, plus glob-based auto-review to bulk-approve mechanical files.

This document is the implementation brief. It records goals and decisions already made; the implementing agent owns the detailed design, mocks, and process.

## Context

- Delta Review (this repo) is a VS Code extension: files changed vs a base branch appear under **Needs Review** / **Reviewed**; marking a file reviewed snapshots its blob sha into `refs/review/<branch>`, and later edits diff against that snapshot.
- Target workflow: a coding agent (Claude Code) makes a large change; the human reviews it with this extension.
- Core problem at that scale: the change is one narrative smeared across hundreds of files, and much of the diff is mechanical noise. The two features below attack those two problems.

## Feature 1 — Cluster view (AI-generated logical groupings)

Group changed files by logical change ("Rename fetchUser → getUser", "New caching layer") instead of by folder.

### Decisions

- **AI-only.** No heuristic clustering (no co-change analysis, no token matching, no import graphs). Clusters come exclusively from a Claude Code skill (Feature 3). If no cluster file exists, the view mode is unavailable/hidden — that's acceptable.
- **No AI code in the extension.** No API keys, no model calls, no prompts. The extension is a renderer of a JSON file.
- **Contract file** written by the skill, read (and file-watched) by the extension:
  - Path: `.git/delta-review/clusters-<branch>.json` (inside `.git` — preserves the zero-working-tree-footprint principle; never committed, never pushed).
  - Shape (agent may refine, keep the semantics):

    ```json
    {
      "version": 1,
      "clusters": [
        {
          "label": "Rename fetchUser → getUser",
          "summary": "Mechanical rename across all call sites",
          "files": ["src/api.ts"],
          "patterns": ["**/*.test.ts"]
        }
      ]
    }
    ```

  - No commit or blob shas anywhere in the contract. Branch identity is carried by the filename; content freshness is carried by the review state (below).
- **Cluster membership:** explicit `files` paths, plus optional `patterns` globs per cluster for catch-all clusters that are genuinely glob-shaped (tests, docs, generated output). Explicit paths win over patterns; patterns are evaluated in cluster order. Files created in later agent iterations auto-join a matching pattern cluster.
- **Staleness is tracked by the existing review mechanism only.** A file that changes after review flips back to Needs Review via the content-based snapshot comparison that already exists — there is no second, cluster-level content-tracking channel. Within a cluster, each file's reviewed/needs-review status is the only freshness signal, and cluster headers show reviewed/total counts derived from it.
- Files in the review set but in no cluster (explicitly or by pattern) → an **Unclustered** group. This doubles as a scope-creep detector and must be visually prominent, not hidden.
- **UI:** a third view mode `'clusters'` alongside the existing `'list' | 'tree'` (`ViewMode` in `src/treeProvider.ts`). Cluster header rows show label + reviewed/total count, expose the same mark-all-inside action folders have, and show the cluster `summary` (tooltip or description).
- **Clusters are presentation only.** Review state stays per-file/per-sha in `refs/review/<branch>` exactly as today; switching view modes never changes state.

## Feature 2 — Glob-based auto-review (triage buckets)

Let mechanical files (lockfiles, snapshots, generated output) be approved in bulk so attention goes to real code.

### Decisions

- **Glob classification only. No hunk/diff-content analysis of any kind** (no whitespace-only, imports-only, or rename-only detection; no risk scoring). Classification inputs are:
  - Setting `deltaReview.autoReview.globs` (array of globs, e.g. `["**/*.lock", "**/*.snap", "dist/**"]`).
  - `linguist-generated` attribute from `.gitattributes`.
- Matching files get a triage field (e.g. `triage: 'auto' | 'normal'`) on `ReviewFile` (`src/model.ts`), computed in `computeReviewModel`.
- **UI:** auto files appear as a distinct subgroup under Needs Review (collapsed by default) with a header-level bulk mark-reviewed action — approving all of them is one click.
- Optional setting `deltaReview.autoReview.markAutomatically`: when true, auto files are marked reviewed automatically. This must go through the normal snapshot path (write current blob sha to the review ref) so a later edit to such a file still resurfaces as a delta.
- **Never hide auto files.** They stay visible (as marked/collapsed), so the human can verify what was auto-approved — an agent writing into `dist/` must not become invisible.

## Feature 3 — Ship the clustering skill as a Claude Code plugin in this repo

The repo doubles as a Claude Code plugin marketplace so users can install the skill; extension code is unaffected.

### Decisions

- Layout (verified against Claude Code docs, mid-2026):

  ```
  .claude-plugin/marketplace.json      ← repo root; marks repo as a marketplace
  plugin/
    .claude-plugin/plugin.json
    skills/cluster-review/SKILL.md
  ```

- `marketplace.json` references the plugin via relative `source: "./plugin"`. Optionally use a `git-subdir` source entry so installs sparse-clone only the plugin directory.
- User install: `/plugin marketplace add <owner>/delta-review` → `/plugin install cluster-review@delta-review`.
- **Skill behavior** (`cluster-review`): diff the current branch against the merge base with the configured base branch, group changed files into named logical clusters with a one-line summary each, write the contract JSON from Feature 1 to `.git/delta-review/`. Two invocation modes, same output:
  1. **End-of-task** — invoked by/after the agent that made the change (it knows the intent; best cluster quality).
  2. **On-demand** — run cold on any branch; the model infers groupings from the diff.
- **Re-runs are incremental:** if a clusters file already exists, the skill reads it, keeps cluster identity stable, assigns new/unclustered files, and refreshes labels/summaries as needed — it re-derives what changed from the diff itself rather than from any bookkeeping in the contract. Cheap to re-run after each agent iteration.
- The skill must read the same base-branch notion the extension uses (`deltaReview.baseBranch`, default `main`) or document how it resolves the base.
- Contract versioning: skill and extension live in one repo precisely so the JSON schema evolves in lockstep — a schema change updates both in the same commit. Include a schema `version` field to allow the extension to reject files written by a newer/older skill.

## Non-goals (explicitly cut)

- Risk scoring / risk-ranked ordering.
- Any hunk- or diff-content-based analysis in the extension (whitespace/imports/rename detection, content flags).
- Heuristic (non-AI) clustering.
- Sha-based staleness tracking in the cluster contract (no `baseSha`, no per-file blob shas) — freshness comes from the existing review state, nothing else.
- Hiding files from review under any circumstance.
- Changing the review-state model (`refs/review/<branch>`, content-based, per-file blob shas).

## Existing architecture anchors

- `src/model.ts` — `computeReviewModel` builds `ReviewFile[]`; new fields (`triage`) go here.
- `src/treeProvider.ts` — `ViewMode` (`'list' | 'tree'`), group/folder/file tree elements; clusters view mode goes here.
- `src/reviewState.ts` — read/write of `refs/review/<branch>`; unchanged, reused by bulk actions.
- `src/extension.ts` — command registration, settings, file watchers.
- Testing recipe and dev workflow: see `DEVELOPMENT.md`.
