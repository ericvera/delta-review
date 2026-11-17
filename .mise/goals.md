the "watch" icon was a really bad idea. Is there a better icon?

## Investigation

- Only use: cluster header icon `tone.hourglass ? "watch" : "layers"` at src/treeProvider.ts:647-650. File/folder rows only dim + tooltip (src/decorations.ts:115; src/treeProvider.ts:505, :594).
- `clusterHeaderTone` returns `{ dimmed, hourglass }` (src/clusters.ts:161-175), used at src/treeProvider.ts:645, :659; tests at src/clusters.test.ts:1283-1333 cover the boolean, not the icon name.
- Docs naming `watch`: README.md:68; DEVELOPMENT.md:132 (dim rule); DEVELOPMENT.md:267 (manual step 31e).
- Icons already taken: `gear` (auto), dim `check` (reviewed bucket), `warning` (unclustered), `layers` (cluster), notes tree `circle-large-filled`/`circle-large-outline`/`clock`/`check`; status bar `checklist`; toolbar `eye`, `check`, `check-all`, etc. `watch`/`history` read too close to notes' `clock`.
- Candidates (all valid codicons; no `hourglass` codicon exists): `git-pull-request-draft` (GitHub "draft, not ready for review"), `debug-pause` (on hold), `issue-draft` (dashed circle, close to notes circles), `loading~spin` (animated — rejected).

## Decisions

- Rename `clusterHeaderTone`'s `hourglass` field to `waiting`; update its tests.
- Icon: built-in `agent` codicon (VS Code's vendor-neutral agent icon, in VS Code since ≤1.115; engine is ^1.140). Applies to waiting cluster headers only; dims via existing DIM_COLOR.

## Assumptions

- Tooltips (WAIT_TOOLTIP, SOME_WAITING_TOOLTIP) unchanged.
- Docs naming `watch` (README.md:68, DEVELOPMENT.md:132, :267) updated to `agent`.
- Icon swap is visual-only: manual check in dev host, no test; field rename covered by existing tests.

## Proposal

- Issue: waiting cluster headers use `watch`, which reads poorly and sits too close to the notes tree's `clock`.
- Fix: swap to the `agent` codicon, rename `hourglass` → `waiting` (with tests), update the three doc lines.
- Skips: spec and critic (one module, no schema/API change).
