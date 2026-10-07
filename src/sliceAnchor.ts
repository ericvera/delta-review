import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Git } from "./git";

// Slice anchor: keeps the origin slices written for declared extractions
// (`src/originSlice.ts`) reachable from refs/review-slices/<branch>, so `git
// gc` cannot prune the base a review diff still opens. Node + Git only — no
// vscode.
//
// Why a third ref: refs/review/<branch> and refs/review-notes/<branch> are
// each rebuilt from their own live set on every write, so neither can carry a
// foreign blob, and Clear Review State deletes the first outright.

export const sliceRefForBranch = (branch: string): string =>
  `refs/review-slices/${branch}`;

export const deleteSliceRef = async (
  git: Git,
  branch: string,
): Promise<void> => {
  try {
    await git.run(["update-ref", "-d", sliceRefForBranch(branch)]);
  } catch {
    // Ref did not exist — nothing to delete
  }
};

// Resolves what the ref points at, or undefined when it does not exist —
// `rev-parse --verify --quiet` reports that by failing.
const readRefCommit = async (
  git: Git,
  ref: string,
): Promise<string | undefined> => {
  try {
    const commit = (
      await git.run(["rev-parse", "--verify", "--quiet", ref])
    ).trim();
    return commit === "" ? undefined : commit;
  } catch {
    return undefined;
  }
};

// Anchors every slice sha as a commit tree on refs/review-slices/<branch>,
// with the sha as its own tree path so the tree is exactly the anchored set.
// With no slices left the ref is deleted. A commit is only created when that
// tree actually changed — this runs on every refresh, and an unchanged model
// would otherwise pile up empty commits.
export const anchorSlices = async (
  git: Git,
  branch: string,
  shas: readonly string[],
): Promise<void> => {
  const ref = sliceRefForBranch(branch);
  // Sorted so an unchanged set always writes the same tree regardless of the
  // order the model resolved its moves in
  const entries = [...new Set(shas)].sort();
  if (entries.length === 0) {
    // Deleting a ref that is already gone still succeeds, but it churns lock
    // files under `.git`, which the extension's own file watcher turns back
    // into a refresh — an endless cycle on any branch that declares no
    // extractions, the common case. So write only when there is something to
    // remove.
    if ((await readRefCommit(git, ref)) !== undefined) {
      await deleteSliceRef(git, branch);
    }
    return;
  }
  // A temporary index keeps this fully isolated from the user's real index
  const indexFile = join(
    tmpdir(),
    `delta-review-${randomBytes(8).toString("hex")}`,
  );
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git.run(["read-tree", "--empty"], { env });
    const indexInfo = entries
      .map((sha) => `100644 ${sha} 0\t${sha}\0`)
      .join("");
    await git.run(["update-index", "-z", "--index-info"], {
      env,
      stdin: indexInfo,
    });
    const tree = (await git.run(["write-tree"], { env })).trim();

    const parent = await readRefCommit(git, ref);
    const parentArgs = parent === undefined ? [] : ["-p", parent];
    if (parent !== undefined) {
      const currentTree = (
        await git.run(["rev-parse", `${ref}^{tree}`])
      ).trim();
      if (currentTree === tree) {
        return;
      }
    }
    const commit = (
      await git.run([
        "commit-tree",
        tree,
        ...parentArgs,
        "-m",
        "delta-review slices",
      ])
    ).trim();
    await git.run(["update-ref", ref, commit]);
  } finally {
    await unlink(indexFile).catch(() => undefined);
  }
};

// Anchors one refresh's slice set and makes the shared slice cache match it,
// as one step meant to run inside the review-state queue so no other ref
// write lands between the two. A refresh computes against its own copy of the
// cache (`candidates`) and only this step publishes from it, so a refresh
// superseded before or during anchoring adds nothing: every cached sha is one
// the ref anchors. Returns whether the anchor ran: a refresh already
// superseded skips it, one superseded during it empties the cache, and a
// failed anchor empties the cache and rethrows.
export const anchorSlicesIntoCache = async (options: {
  anchor: (shas: readonly string[]) => Promise<void>;
  isCurrent: () => boolean;
  shas: readonly string[];
  candidates: ReadonlyMap<string, string>;
  cache: Map<string, string>;
}): Promise<boolean> => {
  const { anchor, isCurrent, shas, candidates, cache } = options;
  // A stale refresh anchoring after a newer one would roll the ref back to a
  // set no published model names
  if (!isCurrent()) {
    return false;
  }
  try {
    await anchor(shas);
  } catch (error) {
    // The ref's state is unknown, so no cached slice is known to be reachable
    cache.clear();
    throw error;
  }
  // Superseded while anchoring — possibly by a repo switch that already
  // cleared the cache — so publish nothing from this refresh's candidates
  if (!isCurrent()) {
    cache.clear();
    return true;
  }
  // Rebuilt from the anchored set rather than kept from the previous cache: a
  // slice that left the set is unreachable now, so it has to be written again
  // if it comes back
  const anchored = new Set(shas);
  cache.clear();
  for (const [key, sha] of candidates) {
    if (anchored.has(sha)) {
      cache.set(key, sha);
    }
  }
  return true;
};
