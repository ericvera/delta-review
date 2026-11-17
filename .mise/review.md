# Review

- 01_01: waiting cluster headers show the `agent` codicon instead of `watch` (src/treeProvider.ts); `clusterHeaderTone` field `hourglass` → `waiting` (src/clusters.ts, src/clusters.test.ts); README.md:68 and DEVELOPMENT.md:132, :267 say `agent`. Verify: DEVELOPMENT.md manual step 31e in the dev host — waiting cluster header shows the agent icon, dimmed.

## Open assumptions

- Tooltips (WAIT_TOOLTIP, SOME_WAITING_TOOLTIP) unchanged.
- Icon swap is visual-only: manual check, no new test; rename covered by existing tests.

## Amendments

- None.
