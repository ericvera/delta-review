# Task 4.1: Claude Code plugin — marketplace, plugin manifest, cluster-review skill

## Goal

The repo doubles as a Claude Code plugin marketplace shipping one plugin with the `cluster-review` skill: prompt instructions that diff the branch, group changed files into logical clusters, and write the version-1 contract JSON the extension (Tasks 3.x) renders. No extension code changes.

## Requirements addressed

REQ-SKILL-1 through REQ-SKILL-8, REQ-CONTRACT-1/2/6 (writer side).

## Background

Delta Review's clustered view is fed exclusively by `.git/delta-review/clusters-<sanitized-branch>.json` — the extension has no AI code; this skill is the producer. Contract schema (version 1, validated by `parseClustersContract` in `src/clusters.ts` — read it and mirror the rules exactly):

```json
{
  "version": 1,
  "clusters": [
    { "label": "Rename fetchUser → getUser", "summary": "Mechanical rename across call sites", "files": ["src/api.ts"], "patterns": ["**/*.test.ts"] }
  ]
}
```

Each cluster: string `label`, string `summary`, at least one non-empty array among `files` (repo-relative `/`-separated paths) / `patterns` (picomatch globs, for genuinely glob-shaped catch-alls only — tests, docs, generated output). No commit/blob shas anywhere. Extension-side membership: explicit files beat patterns, first cluster wins, patterns in cluster order, unmatched → Unclustered (prominent), auto-triaged files render separately regardless.

Claude Code plugin layout (verified against docs mid-2026):

```
.claude-plugin/marketplace.json      ← repo root; marks the repo as a marketplace
plugin/
  .claude-plugin/plugin.json
  skills/cluster-review/SKILL.md
```

Install flow: `/plugin marketplace add ericvera/delta-review` → `/plugin install cluster-review@delta-review`.

The extension resolves its base branch via merged VS Code configuration `deltaReview.baseBranch` (default `main`, `src/extension.ts:125-128`) and computes the review set as `git diff --name-only --no-renames -z $(git merge-base <base> HEAD)` plus `git ls-files --others --exclude-standard -z` (`src/model.ts:50-68`). Branch filename sanitization (must match `sanitizeBranchForFilename` in `src/clusters.ts`): every character outside `[A-Za-z0-9._-]` → `-`. The contract directory is `$(git rev-parse --git-common-dir)/delta-review/` (create if absent).

## Files to modify/create

- `.claude-plugin/marketplace.json` (new, repo root) — marketplace manifest: name `delta-review`, owner metadata, one plugin entry `{ "name": "cluster-review", "source": "./plugin", "description": ... }`.
- `plugin/.claude-plugin/plugin.json` (new) — plugin manifest: name `cluster-review`, description, version `0.1.0`.
- `plugin/skills/cluster-review/SKILL.md` (new) — the skill (frontmatter `name`, `description` with trigger conditions; body = instructions).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

SKILL.md body must instruct the executing agent to:

1. **Resolve the base branch**: read `deltaReview.baseBranch` from the repo's `.vscode/settings.json` if present, else `main`. Document the known divergence: the extension reads merged VS Code configuration, so a user-scope setting is invisible to the skill (REQ-SKILL-6).
2. **Compute the review set** exactly as the extension does: `git merge-base <base> HEAD`, `git diff --name-only --no-renames -z <mergeBase>`, plus untracked via `git ls-files --others --exclude-standard -z`, deduplicated.
3. **Incremental re-run** (REQ-SKILL-5): if the contract file exists, read it first; keep existing cluster labels/identity stable; place new/unclustered files into existing clusters where they belong or new clusters; refresh labels/summaries only where the change's meaning shifted; derive everything from the current diff (never bookkeeping in the contract).
4. **Cluster** the files into named logical changes with a one-line `summary` each. Quality bar: clusters tell the change's narrative ("Rename X → Y", "New caching layer"), not directory structure. Use the agent's own knowledge of the change when invoked end-of-task; infer from diff content when invoked cold (REQ-SKILL-4 — both modes, same output). Use `patterns` only for genuinely glob-shaped catch-alls (REQ-SKILL-7). Every changed file should be claimed unless it genuinely belongs to no logical change — unclaimed files surface prominently as "Unclustered" in the extension, which is the scope-creep detector, so don't invent a junk-drawer cluster.
5. **Write the contract** atomically to `$(git rev-parse --git-common-dir)/delta-review/clusters-<sanitized-branch>.json` (mkdir -p the directory; sanitize the branch per the rule above, restated in SKILL.md verbatim) with `"version": 1`. Never commit or push it; never add it to the working tree (REQ-CONTRACT-6).
6. State the schema inline in SKILL.md (the writer's spec) with the "at least one of files/patterns" rule, and note that schema changes require bumping `version` and updating `src/clusters.ts` in the same commit (REQ-SKILL-8).

marketplace.json / plugin.json: keep minimal and valid per current Claude Code plugin docs — verify field names against the docs (or a locally installed plugin's cache, e.g. `~/.claude/plugins/cache/*/*/.claude-plugin/`) rather than inventing them.

## Testing suggestions

- Validate both JSON manifests parse (`node -e 'JSON.parse(...)'` or `jq`).
- Dry-run the skill instructions by hand on this very repo/branch: follow SKILL.md step by step, produce a contract for `agentic-change-review`, and confirm the extension (F5 dev host opened on this repo) renders the clusters — this exercises skill + extension against each other (the real acceptance for Feature 3).
- Verify `parseClustersContract` accepts the hand-produced file (a scratch Vitest case or node REPL against `src/clusters.ts`).
- If a local Claude Code is available: `/plugin marketplace add <path-to-repo>` and install, confirming the layout is loadable. Otherwise verify layout field-by-field against the docs.
- Test exception applies (no e2e infrastructure): manual dry-run verification above.

## Gotchas

- `.vscodeignore` must exclude `plugin/` and `.claude-plugin/` from the vsix (extension packaging must not ship the plugin).
- The sanitization rule appears in two places (SKILL.md prose, `src/clusters.ts`) — they must match character-for-character in effect; SKILL.md should show the regex (`[^A-Za-z0-9._-]` → `-`).
- `git rev-parse --git-common-dir` can return a relative path — the skill instructions should `cd` to the repo root first or make it absolute.
- Don't have the skill read `deltaReview.autoReview.globs` or replicate triage — auto-triage is extension-side and orthogonal to clustering.

## Verification checklist

- [ ] Layout matches the documented marketplace/plugin structure; manifests valid JSON with doc-verified fields
- [ ] Hand-executed SKILL.md produces a contract that `parseClustersContract` accepts and the dev-host extension renders
- [ ] Re-running the skill on the same branch keeps cluster labels stable and assigns new files (edit a file, re-run, check)
- [ ] vsix packaging still excludes plugin files (`yarn package`, inspect the vsix file list)
- [ ] End-to-end: Test exception (no e2e infra) — manual dry-run above
