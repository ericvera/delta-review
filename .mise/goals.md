Consider the following. You alone are responsible for this repo so take the task details as informational.

Title: [infra] carry delta review state across renames so a renamed file diffs against its reviewed version

Description: 

delta-review repo. The "since my review" diff already ships, but the reviewed snapshot is looked up by the file's own path (resolveFileBase in src/model.ts). A file renamed on the branch, whether git found the rename or the contract declared it, loses its review state and diffs against the merge base or the origin's merge-base blob.

Wanted: when a rename or declared repo move links old → new, use the old path's reviewed snapshot as the diff base.

Optional: let a repo move set its base to an in-branch version. Today baseBlob on a repo move is dropped unless it declares extraction (src/clusters.ts).

Workaround today, though it bends the contract: declare the rename as an external move with baseBlob = the reviewed version.

Source: feat/pop-up-config review, where about 100 renamed or edited files went back into the queue.

## Investigation

Feature, not a bug fix; nothing was run. All from reading the code.

1. Root of the gap: `src/model.ts:575` looks up the snapshot by the file's own path only (`reviewState.get(path)`). `reviewed`, `snapshotUsable` and `useSnapshotBase` (:576-581) all build on that, and the move is only fetched afterwards at :582.
2. `resolveFileBase` (`src/model.ts:251-317`) puts the snapshot first, then the merge-base blob at the file's own path, then the origin (:280-291). `diffBasePath` stays the file's own path on a snapshot base (:279). `originDecidesBase` (:304) controls the "origin unavailable" and "lines out of range" flags.
3. Old-path snapshots outlive a rename: `markReviewed`/`unmarkReviewed` (`src/reviewState.ts:90-132`) only add or remove the keys they are given, and only `clearAllReviewSnapshots` (:139) wipes everything. `readReviewState` (:18) returns the full path→sha map, so the old key can be found at `model.ts:555`.
4. Both rename kinds already reach one map: `movesByPath` with `ResolvedMove.from` (`model.ts:134-147`), filled from git renames (:177-189) and declarations (:204-212). Repo moves are `origin: "repo"`. External moves should be left out, since their `from` is a donor path (`model.ts:30-32`).
5. Left open by goals, decided by nothing in the code yet:
   - (a) Should a renamed file whose content equals the old-path snapshot read as Reviewed? Status comes from :576.
   - (b) What should `hasReviewSnapshot` (:601) mean? It drives unmark scope: `pathsWithReviewSnapshot` at `model.ts:102`, the guard at `src/extension.ts:896`, and `src/rowContext.ts:25`. Unmark at `extension.ts:902-904` only deletes the new path, so an inherited old-path snapshot would keep coming back unless unmark also drops the old key.
   - (c) Which `diffBasePath` a snapshot base gets, old path or new. It is the base-document and note key (`src/baseDocument.ts:25`, `src/commentController.ts:193`, `src/noteTarget.ts:70`, `src/extension.ts:707`).
6. Collision to handle: a declaration that displaces a git rename puts the detected source back as its own deleted row (`model.ts:201-203`), and that row keeps its own snapshot. The old-path fallback should follow only the winning move's `from`.
7. Patterns to follow: keep the logic pure and testable inside `resolveFileBase`/`computeReviewModel`, with no vscode imports (`.claude/mise-config.md:29`). The UI wording ("last reviewed", "Changed since last reviewed") already depends only on `diffBaseIsReviewedSnapshot` (`src/extension.ts:711`, `src/treeProvider.ts:556`).
8. Tests belong in `src/model.test.ts`: the `describe("resolveFileBase")` block at :309, and `describe("computeReviewModel")` at :674. The latter has a fake-repo `reviewState` fixture (:700) and an R100 rename case (:787).
9. Goals is partly wrong on the optional item. `clusters.ts:275-276` drops a repo move's `baseBlob` only below contract version 3 (`allowsExtraction` = v3), not only when extraction is missing. On v3, a repo move without `fromLines` keeps the declared blob as its whole base (`src/originSlice.ts:165-169`), checked only with `blobExists` (:156-159), so an in-branch blob already passes. The blob still loses to a snapshot or a destination merge-base blob (`model.ts:280-284`).
10. Docs to update (CLAUDE.md requires Contract-style edits):
    - `DEVELOPMENT.md:25-37` (review-state rules) and :83 (diff-base order).
    - Manual steps 9/11/14 (`DEVELOPMENT.md:226-231`).
    - If repo `baseBlob` semantics change: `plugin/skills/cluster/SKILL.md:87` and `DEVELOPMENT.md:115-117`.
11. Hard to undo:
    - No schema or migration change is needed: snapshots stay keyed by path in `refs/review/<branch>`.
    - If unmark is extended to the old path, it writes ref history (`reviewState.ts:38-87`); recoverable through the parent chain.
    - Changing what the contract accepts for `baseBlob` is a public file-format change (`clusters.ts:256-348`, cluster SKILL.md).
12. No UI or `package.json` contributes changes are implied, so the mock condition does not apply.

## Decisions

Owner's goal, in their words: not have to re-review code already reviewed, but know when files moved; the move itself is something to review.

- A file renamed on the branch (git-detected rename or declared repo move) uses the old path's reviewed snapshot as its diff base when it has no snapshot of its own.
- A moved file always lands in Needs Review, even when its content is identical to the old path's reviewed snapshot. It leaves Needs Review once the owner marks it at the new path.
- Its row shows the previous path, and reads "unchanged" when its content is identical to what was last reviewed at the old path. Opening it shows an empty since-review diff.
- "verbatim" keeps today's meaning and is shown only when the moved file has no reviewed snapshot at either path: identical to the move origin. Each word means one thing.
- A moved file edited since the review shows only the changes since that review.
- Unmark on a moved file that inherits the old path's snapshot drops both the new path's and the old path's snapshots.
- Out of scope: the optional item. A repo move's declared `baseBlob` keeps its current behaviour and precedence.

## Assumptions

- "unchanged" is a new row/tooltip tag alongside the existing classification wording; the documented classification rule (`DEVELOPMENT.md:82`, cluster `SKILL.md:113`) is updated to describe it.
- A moved file with an inherited snapshot that differs from it shows neither "unchanged" nor "verbatim"; it keeps the existing non-verbatim wording ("adapted") and the existing "Changed since last reviewed" wording.
- An inherited snapshot outranks a declared `baseBlob` and the origin base, the same as a file's own snapshot does today. A file's own snapshot outranks an inherited one.
- Only the winning move's `from` is followed (Investigation 6); external moves never inherit (Investigation 4).
- Marking the moved file reviewed writes a snapshot at the new path only; the old path's snapshot is left in place.
- The previous path is already shown on moved rows by the existing move display; no tree structure, command or button changes, so no mock.
- No snapshot storage or contract file-format change.

## Proposal

- Issue: a file moved on the branch loses its review and shows its whole diff again.
- Approach: a moved file goes to Needs Review showing its previous path, diffs only against what was last reviewed at the old path, and reads "unchanged" when nothing changed since that review ("verbatim" stays for never-reviewed moves identical to their origin); unmark clears both paths.
- Skips: none. Spec and critic both run, because a new "unchanged" tag and the documented review-state rules change.
