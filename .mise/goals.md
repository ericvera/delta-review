Evaluate the following. I look forward to seeing the mocks.

[feat] show a notes document as the first entry of a cluster so its intro, reading order and check questions are read in place
[feat] accept review notes on a cluster notes document so the owner gives feedback on it like on code
[feat] show a branch document as the first entry of the tree so the plate opens from the sidebar
[feat] add a review level per file (review, skim) so depth shows on the row, not in the cluster name
[feat] show a cluster's files in contract order so the sidebar matches the reading order
[feat] accept agent notes anchored to a line range so a remark sits on the code it is about

## Investigation

1. Contract order: `resolveClusterModel` keeps path-sorted order per bucket (src/clusters.ts:517-519, 557-573; sort at src/model.ts:252, 617). Tree mode puts folders first then sorts alphabetically (src/treeProvider.ts:345-382) — conflicts with reading order. List mode and Unclustered/Auto use bucket order (src/treeProvider.ts:294-317).
2. Review level: clusters carry `label`/`summary`/`files`/`patterns`/`wait` (src/clusters.ts:15-24, 270-311); `files` is a string array. Per-file level needs a new key (e.g. top-level map like `waitPaths`, src/clusters.ts:492-499). Reaches row like `fileNote`: src/extension.ts:418-428 → src/model.ts:93, 777 → description/tooltip src/treeProvider.ts:540-571.
3. Line-range agent notes: today one string per file in clusters `notes` (src/clusters.ts:469-491); older extensions reject non-string (482-483) → version 4 bump plus parser and skill update in one commit (plugin/skills/cluster/SKILL.md "Schema changes"). Rendered as file-level read-only provenance thread (src/provenance.ts:47-92; DEVELOPMENT.md:169-177, range forced undefined). Line-ranged read-only thread pattern exists: controller cache + `ProvenanceThreadSnapshot` (src/commentController.ts:70-90).
4. Document tree rows: root lists only cluster, unclustered/auto, `reviewedBucket` (src/treeProvider.ts:183-211). New kinds touch `ReviewTreeElement` (94-101), `collapseKeyFor` (118-134), `getTreeItem`, `parentOf` (src/treeParents.ts:135-171). File rows run `deltaReview.openDiff` (src/treeProvider.ts:600-604); a document row needs its own command + package.json contribution.
5. Document location undefined in goals ("plate" undefined). Contract files live under `<git common dir>/delta-review/`, watched as `*.json` only (src/extension.ts:787-814), never committed.
6. Notes on the notes document: commenting ranges only for in-review-set `file`/base-scheme docs (src/commentController.ts:170-207); `repoRelativePath` rejects out-of-repo paths (159-167); response anchors reject traversal/absolute (DEVELOPMENT.md:158). `noteTargetFor` needs a new case (src/noteTarget.ts:36-60).
7. Notes file: new keys need a version bump (older extensions strip unknown keys; src/notes.ts:247-264, v1 enforced 333-337). Notes anchor blobs on `refs/review-notes/<branch>` (DEVELOPMENT.md:148-150).
8. Docs: plugin/skills/cluster/SKILL.md, plugin/skills/review-notes/SKILL.md, DEVELOPMENT.md "Clusters contract" (109-136).
9. Tests: src/clusters.test.ts, src/treeParents.test.ts, src/provenance.test.ts, src/notes.test.ts; plus scripted extension-host check (DEVELOPMENT.md:205).
10. Tree structure changes → mock condition met.

## Decisions

- Notes on a cluster notes document anchor to the selected line range, like code notes; agent replies use the existing responses file; the notes file format gets a version bump.

- Documents: the agent writes markdown files beside the contracts under `<git common dir>/delta-review/` (never committed), found by convention, not named in any contract: branch document `branch-<branch>.md`, cluster notes `cluster-notes-<branch>/<slug>.md` (slug = label lowercased, runs of other characters → single hyphen; `<branch>` sanitized as for `clusters-<branch>.json`). A row appears only when its file exists — no missing-file error. Watcher widens to `*.md`. Renaming a cluster means renaming its notes file (cluster skill says so).
- The branch document is the output of the owner's in-development "plate" skill; the row is labelled "Branch overview", never "plate".
- List mode keeps today's directory path in the row description (after any skim tag); root files show none.
- Contract order applies in list mode only; tree (folder) mode keeps folders-first alphabetical.

## Assumptions

- Row labels/icons: "Branch overview" (book icon), "Cluster notes" (note icon).
- A cluster notes row opens the markdown source (so notes can be added); the branch row opens the markdown preview.
- Document rows have no reviewed state.
- Only `skim` shows a tag on the row; `review` is the default and untagged.
- The branch row also shows in ungrouped view.
- The branch document takes no review notes.
- A line-range agent note renders as a read-only thread under the last line of its range.

## Proposal

Issue: cluster intros, reading order, review depth and agent remarks live in labels and file-level notes, not where they are read.
Approach: convention-located branch doc and per-cluster notes docs; clusters contract v4 (per-file `review`/`skim`, line-range agent notes), doc rows first in tree and cluster, list-mode contract order, notes file v2 for line notes on cluster docs; skill docs and DEVELOPMENT.md updated in step.
Skips: none — schema changes across both contracts need spec and critic.
