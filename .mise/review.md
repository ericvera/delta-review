# Review

## Tasks

1. 01_01 (22bfebd) List mode orders a cluster's files by the contract's `files` order; pattern-only members after, in path order; tree mode stays folders-first alphabetical. Verify: clusters.test.ts / treeParents.test.ts; DEVELOPMENT.md manual step 31g.
2. 01_02 (767a28e) Clusters contract v4: `levels` map (any version), array `notes` with `{ text, lines }` (v4 only); skill writes 4 only when a ranged note exists; ranged notes re-anchored or dropped on every re-run. Verify: clusters.test.ts, model.test.ts; plugin/skills/cluster/SKILL.md.
3. 01_03 (c869fb4) `skim` tag in file row description (`skim · <dir>`) and tooltip line. Verify: reviewLevel.test.ts; manual step 31h (not yet run by eye).
4. 01_04 (cc7c9dd) Ranged agent notes render as read-only Claude threads on their lines; tooltip summary line. Verify: provenance.test.ts; manual step 21; scripted host check passed (re-clamp after late open not covered).
5. 01_05 (fa14a8e) Document discovery by convention: `branch-<branch>.md`, `cluster-notes-<branch>/<slug>.md`; skill "Documents" section with rename/delete guard. Verify: documents.test.ts.
6. 01_06 (836c009) "Branch overview" root row and "Cluster notes" first child row; open/preview commands (inline preview action); watcher widened to `.md`. Verify: treeParents.test.ts; manual steps 31i–31m; scripted host check passed.
7. 01_07 (6259d35) Notes file v2 (`document: "clusterNotes"`), written only while such a note exists; review-notes skill updated. Verify: notes.test.ts, notesStore.test.ts.
8. 01_08 (53bcedc) Commenting on cluster notes documents; REVIEW NOTES groups `<cluster label> — notes` first; clicking opens the document (or its snapshot). Verify: noteTarget.test.ts, notesGrouping.test.ts; manual step 45a; scripted host check passed.

## Reviewer notes (non-blocking)

- README.md:95-96 still says notes are "grouped by file" and "click opens its diff" — false for cluster notes document notes.

## Open assumptions

- Row labels/icons: "Branch overview" (book), "Cluster notes" (note).
- Cluster notes row opens the markdown source; branch row opens the preview.
- Document rows carry no reviewed state; the branch document takes no review notes.
- Only `skim` is tagged; `review` is the untagged default.
- Branch row also shows in ungrouped view.
- Ranged agent note thread sits on its range (rendered under its last line).
- Renaming a cluster orphans its notes file unless the agent renames it (skill rule); slug collisions never delete/overwrite.

## Amendments

None.
