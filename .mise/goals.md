when a file is marked as reviewed, the multi-file diff should refresh. Also, would if be possible to have a way for agents to mark a cluster as "safe to review" because as it works those are not expected to change and that should refresh as plans change

## Investigation

Feature work; nothing to reproduce. All claims from reading the code.

1. **Where the combined diff is built.** `deltaReview.openClusterChanges` (src/extension.ts:1330-1385) closes any existing tab with the same title (1354-1357), records a `ClusterChangesEntry` in `clusterChangesTabs` (742, 1362-1373) and calls `vscode.changes` (1374-1382). After that, nothing updates the tab.
2. **Every review mark goes through one place.** `applyReviewStateChange` (extension.ts:605-621) queues the write and then calls `refresh()`. Per-file mark at 1045-1064, title-bar button at 1392-1457 (via `markClusterPaths` at 623-630), folder/cluster/auto/all variants at 1299, 1476, 1528, 1574. Background refresh also auto-marks files (383-420).
3. **Where a refresh hook fits.** `refresh()` assigns the new `model` and `clusterModel` at extension.ts:449-462 — the natural point to rebuild open `clusterChangesTabs` entries, keeping the generation guard style used at 350, 443, 504. Diff contents come from `clusterChangesFiles` (needs-review only, src/clusterChanges.ts:24-26) and `diffUris` (extension.ts:718-731).
4. **Limits of the multi-diff tab.** No stable API class; the code finds the tab by label (extension.ts:744-769). Reopening means closing it and calling `vscode.changes` again, which opens in the active group with a new random `multi-diff-editor:` source (1387-1391). Rebuilding a tab the user is not looking at could move it or take focus.
5. **Open on the diff refresh:** what happens when a cluster has no needs-review files left (today `nothingToReviewMessage`, clusterChanges.ts:77); whether contract or file edits also trigger a rebuild; how to handle a renamed cluster (`changedClusterMessage`, clusterChanges.ts:74-75; title/label check 100-106).
6. **The code already decides the base.** A reviewed file leaves the diff via the needs-review filter (clusterChanges.ts:26). A file changed after review is shown against its last-reviewed snapshot (`diffBaseIsReviewedSnapshot`, extension.ts:825).
7. **Docs this contradicts.** DEVELOPMENT.md:261 says the tab "is not refreshed; reopen it to see current bases"; DEVELOPMENT.md:262 says after a per-file `+` "the combined diff tab stays as it is". Both manual-test steps need rewriting.
8. **Where "safe to review" would live.** The agent-written clusters contract is the only channel. Parsing in `parseCluster` (src/clusters.ts:222-254); types `ClusterDefinition` (15-22) and `ClusterBucket` (54-58); `resolveClusterModel` (446-500) builds the buckets.
9. **Agent changes already show up live.** A watcher on the contract directory calls `scheduleRefresh` (extension.ts:668-694), so the flag can come and go with no new plumbing.
10. **Where the flag would render.** `clusterTreeItem` (src/treeProvider.ts:575-620) sets icon (`layers`, 610), tooltip (611), description (613), `contextValue` (618). The context value drives cluster row menus in package.json, which already wires `openClusterChanges` at 345/350/507.
11. **Hard to undo: the contract schema.** plugin/skills/cluster/SKILL.md:164-166 says any schema change must bump `version` and update `src/clusters.ts` in the same commit. The parser accepts versions 1-3 (clusters.ts:183-186, 366-378); a newer skill's files would be rejected by older extensions. Also touches SKILL.md:42-99, DEVELOPMENT.md:115-119, package.json:5 (0.12.0), plugin/.claude-plugin/plugin.json:4 (0.7.1). SKILL.md and DEVELOPMENT.md follow the Contract-plus-Default-workflow rule in CLAUDE.md. "Unknown keys are ignored" (clusters.ts:351) would let an unversioned optional key slip in, contradicting SKILL.md:166.
12. **Open on the flag:** its name and meaning; whether it applies only to clusters or also Unclustered/Auto (synthetic keys, clusterChanges.ts:11-14); how it shows in the tree (icon, description, sorting, gating the multi-diff action); whether the SKILL workflow tells agents when to set and clear it.
13. **Tests and patterns.** Pure logic in clusterChanges.ts and clusters.ts with colocated tests (src/clusterChanges.test.ts, src/clusters.test.ts). Tab rebuilding needs the scripted `@vscode/test-electron` recipe (DEVELOPMENT.md:201-214); `deltaReview.__inspect` already reports recorded combined-diff tabs. Tree changes are UI and match the config's Mock conditions.

## Decisions

- Diff refresh trigger: anything that changes the cluster's needs-review files or their diff bases — review marks, file edits, and agent changes to the clusters file.
- When the cluster's last needs-review file is marked reviewed: the tab is NOT closed; it stays open and shows something like "nothing to review".
- A combined diff tab that is not the active editor is not rebuilt in the background; it is rebuilt when the owner switches back to it. Only the active tab rebuilds immediately.

- Flag polarity (owner's call, replaces "safe to review"): agents flag a cluster as "wait" (name open to the planner, e.g. `wait: true`); an unflagged cluster is assumed ready to review. The flag is optional and additive.
- No contract `version` bump: older extensions ignore the unknown key and show the cluster as normal. The SKILL.md rule that every schema change bumps `version` is amended to exempt optional keys an older extension can safely ignore.
- Tree rendering: a "wait" cluster is shown muted, the way git-ignored directories show in Explorer. No sorting change.
- Flag honesty: the agent alone owns it. The skill doc tells agents to set "wait" on clusters they still expect to change and clear it when the cluster is settled or plans change. No extension-side "changed since flagged" tracking.
- The flag is informational only; it gates no action.

## Assumptions

- The flag applies to agent-defined clusters only, not the synthetic Unclustered/Auto groups.
- Muting covers the cluster row and the file rows under it, as an ignored directory mutes its contents; the tooltip says why (waiting on the agent).
- "Nothing to review" in a kept-open combined diff tab may be VS Code's own empty multi-diff state or a rebuilt empty tab; the planner picks whatever the multi-diff editor allows.
- A renamed or removed cluster with an open combined diff tab keeps today's behavior (`changedClusterMessage`), not a rebuild.
- DEVELOPMENT.md:261-262 manual-test steps are rewritten; package.json and plugin.json versions are bumped as releases normally are.
- Mock guesses: the contract key is `wait: true`; the tooltip reads "Waiting on the agent: still expected to change."; the empty combined diff tab reads "Nothing to review in '<label>'. Files reappear here if they change."; hover actions on muted rows stay enabled at full contrast.

## Proposal

- Issue: an open multi-file diff goes stale after marks, edits and clusters-file changes; agents cannot tell the reviewer which clusters are still in motion.
- Approach: rebuild the active combined diff tab on every refresh that changes its files or bases (background tabs on switch-back; empty state instead of closing); add an optional `wait: true` cluster key, no version bump, rendered muted, documented in the cluster skill.
- Skips: none — the contract change and new concept call for a spec and critic.
