# Review

## Tasks

- 01_01 wait flag (3b82b85): optional `wait: true` per cluster in the clusters contract (versions 1-3, no bump); non-boolean rejects the file. Waiting cluster header, its folders and (grouped mode) its needs-review file rows render in the git-ignored color with tooltip "Waiting on the agent: still expected to change."; menus/hover actions unchanged. Documented in plugin/skills/cluster/SKILL.md (schema, **Wait**, preserved exceptions, version-bump exemption, workflow steps 3/6/7) and DEVELOPMENT.md. Verify: add `"wait": true` to a cluster in the contract file → rows mute live; remove it → back to normal; DEVELOPMENT.md step 31e. Not yet eyeballed in a dev host.
- 01_02 diff refresh (49d0a01): the active combined cluster diff tab rebuilds in place (same group/index, re-pinned if pinned) when its needs-review files or bases change — marks, file edits, contract edits. Background tabs rebuild on switch-back. Emptied cluster keeps the tab open, empty. New tab is adopted only once it opens (3000 ms timeout; failure shows "Couldn't refresh…" and is not retried for the same signature). Versions: extension 0.13.0, plugin 0.8.0. Verify: open Cluster Changes, press per-file `+` → file leaves the tab; mark the last file → tab stays, empty; DEVELOPMENT.md steps 31c, 31d, 31f. Scripted extension-host check passed 5/5.

## Open assumptions

- `wait` applies to agent-defined clusters only, not Unclustered/Auto.
- A renamed or removed cluster with an open combined diff keeps today's `changedClusterMessage` behavior.
- Rebuild moves keyboard focus to the combined diff (no stable API to preserve focus) — accepted.
- Rebuild opens as a preview and may replace an unrelated preview tab in the group — accepted.

## Review fixes (0ec7bbd)

- Open Cluster Changes now runs on the rebuild queue, so it waits for any in-flight rebuild (no duplicate same-title tabs).
- A tab that opens after a rebuild timeout is re-adopted (or the failure memo cleared), so Mark Cluster Reviewed matches what the tab shows.
- SKILL.md: `wait` field entry trimmed to type/meaning; cold-run line points to the preserved exceptions. DEVELOPMENT.md tooltip order includes the wait line.
- Verify: unit tests can't cover these (VS Code API code); exercise via DEVELOPMENT.md steps 31c/31f — open Cluster Changes twice quickly while marking files.

## Amendments

None.
