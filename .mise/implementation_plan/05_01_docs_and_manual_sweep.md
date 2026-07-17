# Task 5.1: Documentation + full manual acceptance sweep

## Goal

User-facing docs cover the two features and the skill install; a scripted manual pass in the F5 dev host verifies every user-visible requirement end-to-end (this is the substitute verification the project's Test exception prescribes, run once over the whole feature set).

## Requirements addressed

Verification pass for REQ-VIEW-*, REQ-CLUS-*, REQ-CONTRACT-*, REQ-AUTO-*, REQ-PRESERVE-1..4; docs for REQ-SKILL-2 (install instructions).

## Background

The preceding tasks built: `triage` classification (`src/triage.ts`, `src/model.ts`), Auto subgroups + bulk actions + `markAutomatically` (`src/treeProvider.ts`, `src/extension.ts`), the clusters contract reader (`src/clusters.ts`), the grouping lever + contract watcher, clustered rendering, and the plugin (`.claude-plugin/marketplace.json`, `plugin/`). Settings added: `deltaReview.autoReview.globs`, `deltaReview.autoReview.markAutomatically`. Build is now esbuild-bundled (`esbuild.mjs`; `yarn build` = typecheck + bundle).

Docs today: `README.md` is a short skimmable overview (features, install, settings — the repo intentionally keeps it lean; a recent commit moved dev details out); `DEVELOPMENT.md` holds build/run, how review state works, repository selection, and the manual test script.

## Files to modify/create

- `README.md` — add the two features to the overview (clustered review + auto-review globs), the new settings, and a short "Cluster with Claude Code" section with the install commands (`/plugin marketplace add ericvera/delta-review`, `/plugin install cluster-review@delta-review`) and a one-line contract explanation.
- `DEVELOPMENT.md` — document: the contract file (path, sanitization, version), the `ClusterModel` flow, the esbuild build (replacing the tsc description), triage inputs, and extend the manual test script with the new scenarios (the sweep below, condensed).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. Write the docs (match the existing tone: terse, skimmable bullets — the README explicitly stays an overview).
2. Prepare a scratch test repo with: normal source changes, a lockfile-style change, a `linguist-generated` entry in `.gitattributes`, and a hand-written (or skill-produced, from Task 4.1) contract file.
3. Run the sweep in the F5 dev host, checking off each item (record results in the task report):

   **Preserved behavior** (no contract, default settings, no linguist-generated): panel, counts, badges, M/A/D, diffs, mark/unmark, folder actions, collapse persistence, repo switching — indistinguishable from `main` build (REQ-PRESERVE-2).
   **Auto**: globs → Auto subgroup (collapsed, ⚙, count, flat, dir descriptions) first under Needs Review in both layouts; bulk ✓; reviewed auto files inspectable under Reviewed → Auto; `linguist-generated` file classified with empty globs; markAutomatically on → self-marks via snapshot path, edited file resurfaces; Mark All still covers everything; settings changes apply without reload.
   **Levers**: grouping button only with valid contract; icon-swap idiom; four combos render; both levers persist across reload; invalid contract → ⚠ message + fallback + preference survives; contract create/change/delete refreshes live.
   **Clustered**: contract order; `n/m` counts (non-auto); summary tooltips; reviewed rows dimmed-with-✓ inside clusters; Unclustered warning-styled, after clusters, omitted when empty; Auto last, collapsed; empty cluster → message row; flat vs tree inside clusters incl. per-cluster folder collapse + scoped folder actions; cluster/Unclustered/Auto bulk actions; per-file actions + diff titles unchanged; lever flips change no state (`git ls-tree -r refs/review/<branch>` identical before/after).
   **Zero footprint**: `git status` clean in the test repo throughout; contract stays under `.git` (REQ-PRESERVE-4, REQ-CONTRACT-6).

4. Fix anything the sweep catches (small fixes in this task; anything structural → report it rather than bolting on).

## Testing suggestions

- The sweep IS the test (Test exception: no e2e infrastructure — unit tests exist for triage and clusters core; this manual pass covers the extension-host behavior).
- `yarn build`, `yarn lint`, `yarn test`, `yarn package` all green as the final gate.

## Gotchas

- Keep README lean — the user deliberately slimmed it (commit 1e93743 "Slim README to a skimmable overview"); details go to DEVELOPMENT.md.
- The sweep needs a *baseline comparison* for REQ-PRESERVE-2 — either an installed previous vsix or checking out `main` in a second window; note which was used.

## Verification checklist

- [ ] README + DEVELOPMENT.md updated (features, settings, contract, install commands, esbuild)
- [ ] Every sweep item above checked in the dev host and recorded in the task report
- [ ] `yarn build` / `yarn lint` / `yarn test` / `yarn package` green
- [ ] End-to-end: Test exception (no e2e infra) — the recorded manual sweep is the substitute verification
