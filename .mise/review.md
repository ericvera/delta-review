# Review

## Tasks

- 01_01 (0853b63) — `src/model.ts`, `src/extension.ts`: a moved file with no snapshot of its own inherits the old path's reviewed snapshot as its diff base (`selectReviewSnapshot`, `inheritedSnapshotFrom`); new `"unchanged"` classification; unmark drops both paths (`reviewSnapshotPaths`). Verify: `yarn test` (`src/model.test.ts`: `selectReviewSnapshot`, `resolveFileBase`, `computeReviewModel`, `reviewSnapshotPaths`).
- 01_02 (2fc64f0) — `src/moveDisplay.ts`, `src/treeProvider.ts`: row reads `· unchanged`; tooltip leads with `Unchanged since last reviewed`, warnings still follow it; `Changed since last reviewed` hidden for unchanged files. Verify: `yarn test` (`src/moveDisplay.test.ts`).
- 01_03 (05f6cef, efa2df0) — `DEVELOPMENT.md`, `README.md`, `plugin/skills/cluster/SKILL.md`: inheritance rules, the `unchanged` word, new manual step 15 (later steps renumbered). Verify: read DEVELOPMENT.md "How it works" and manual step 15; run step 15 in the dev host.

## Not verified

- No extension-host run: unit tests only (705 pass), plus lint and build. The Needs Review placement, row wording and unmark of both paths have not been seen in a running VS Code.

## Open assumptions

- Not inherited, by design: an extraction (`fromLines`), several declarations sharing one origin, a declared move whose old path is still on disk, an old path that is still its own row. These keep today's behaviour, so `verbatim` can still show there even when the old path has a snapshot.
- Case-only renames (file or folder) inherit.
- A file with its own snapshot never reads `verbatim`; a Reviewed move row reads `unchanged`.
- An inherited snapshot outranks a declared `baseBlob` and the origin base; a file's own snapshot outranks an inherited one.
- Marking the moved file writes a snapshot at the new path only; the old path's snapshot stays until unmark.
- Folder, cluster and Auto unmark also clear an inherited old-path snapshot, even when the old path is outside that folder or cluster.
- A moved file that differs from its inherited snapshot reads `adapted`.
- Repo-move `baseBlob` behaviour is unchanged (out of scope).

## Amendments

None.
