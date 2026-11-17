the "watch" icon was a really bad idea. Is there a better icon?

## Investigation

- Only use: cluster header icon `tone.hourglass ? "watch" : "layers"` at src/treeProvider.ts:647-650. File/folder rows only dim + tooltip (src/decorations.ts:115; src/treeProvider.ts:505, :594).
- `clusterHeaderTone` returns `{ dimmed, hourglass }` (src/clusters.ts:161-175), used at src/treeProvider.ts:645, :659; tests at src/clusters.test.ts:1283-1333 cover the boolean, not the icon name.
- Docs naming `watch`: README.md:68; DEVELOPMENT.md:132 (dim rule); DEVELOPMENT.md:267 (manual step 31e).
- Icons already taken: `gear` (auto), dim `check` (reviewed bucket), `warning` (unclustered), `layers` (cluster), notes tree `circle-large-filled`/`circle-large-outline`/`clock`/`check`; status bar `checklist`; toolbar `eye`, `check`, `check-all`, etc. `watch`/`history` read too close to notes' `clock`.
- Candidates (all valid codicons; no `hourglass` codicon exists): `git-pull-request-draft` (GitHub "draft, not ready for review"), `debug-pause` (on hold), `issue-draft` (dashed circle, close to notes circles), `loading~spin` (animated — rejected).

## Open questions

1. Which codicon replaces `watch`?
2. Rename the `hourglass` field to match?
