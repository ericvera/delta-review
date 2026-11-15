import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git, parseLsTreeOutput } from "./git";

// Snapshot content recorded when a file was deleted from the working tree at
// the moment it was marked reviewed. A deletion has no blob of its own, so a
// deterministic sentinel blob stands in for it in the review tree.
export const DELETED_SENTINEL_CONTENT = "delta-review: file deleted\n";

export const reviewRefForBranch = (branch: string): string =>
  `refs/review/${branch}`;

// Pre-deletion state: refs/review-predeletion/<branch> maps a path to the
// snapshot it held just before its deletion was marked reviewed, which the
// deleted sentinel overwrote in the review ref. A moved file whose origin's
// deletion row was marked inherits through it.
export const preDeletionRefForBranch = (branch: string): string =>
  `refs/review-predeletion/${branch}`;

// Reads a path -> blob sha map from a snapshot ref; a missing ref reads empty
const readSnapshotTree = async (
  git: Git,
  ref: string,
): Promise<Map<string, string>> => {
  try {
    const output = await git.run(["ls-tree", "-r", "-z", ref]);
    return parseLsTreeOutput(output);
  } catch {
    return new Map();
  }
};

// Persists a path -> blob sha map as a commit on the ref. The commit tree
// anchors the snapshot blobs so `git gc` never collects them, and the parent
// chain keeps a browsable history of review sessions.
const writeSnapshotTree = async (
  git: Git,
  ref: string,
  state: Map<string, string>,
): Promise<void> => {
  // A temporary index keeps this fully isolated from the user's real index
  const indexFile = join(
    tmpdir(),
    `delta-review-${randomBytes(8).toString("hex")}`,
  );
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git.run(["read-tree", "--empty"], { env });
    if (state.size > 0) {
      const indexInfo = [...state.entries()]
        .map(([path, sha]) => `100644 ${sha} 0\t${path}\0`)
        .join("");
      await git.run(["update-index", "-z", "--index-info"], {
        env,
        stdin: indexInfo,
      });
    }
    const tree = (await git.run(["write-tree"], { env })).trim();

    let parentArgs: string[] = [];
    try {
      const parent = (
        await git.run(["rev-parse", "--verify", "--quiet", ref])
      ).trim();
      if (parent !== "") {
        parentArgs = ["-p", parent];
      }
    } catch {
      // No previous state on this ref
    }
    const commit = (
      await git.run([
        "commit-tree",
        tree,
        ...parentArgs,
        "-m",
        "delta-review state",
      ])
    ).trim();
    await git.run(["update-ref", ref, commit]);
  } finally {
    await unlink(indexFile).catch(() => undefined);
  }
};

// Reads the reviewed-content map (path -> blob sha) from the review ref.
// A missing ref means nothing has been reviewed yet on this branch.
export const readReviewState = (
  git: Git,
  branch: string,
): Promise<Map<string, string>> =>
  readSnapshotTree(git, reviewRefForBranch(branch));

export const writeReviewState = (
  git: Git,
  branch: string,
  state: Map<string, string>,
): Promise<void> => writeSnapshotTree(git, reviewRefForBranch(branch), state);

export const readPreDeletionState = (
  git: Git,
  branch: string,
): Promise<Map<string, string>> =>
  readSnapshotTree(git, preDeletionRefForBranch(branch));

export const deletePreDeletionRef = async (
  git: Git,
  branch: string,
): Promise<void> => {
  try {
    await git.run(["update-ref", "-d", preDeletionRefForBranch(branch)]);
  } catch {
    // Ref did not exist — nothing to delete
  }
};

// Snapshots the current working-tree content of the given paths as reviewed
export const markReviewed = async (
  git: Git,
  branch: string,
  paths: string[],
): Promise<void> => {
  const state = await readReviewState(git, branch);
  const preDeletion = await readPreDeletionState(git, branch);
  let preDeletionChanged = false;
  const existingPaths = paths.filter((path) =>
    existsSync(join(git.repoRoot, path)),
  );
  const deletedPaths = paths.filter(
    (path) => !existsSync(join(git.repoRoot, path)),
  );

  for (const path of existingPaths) {
    preDeletionChanged = preDeletion.delete(path) || preDeletionChanged;
  }
  if (existingPaths.length > 0) {
    const output = await git.run(["hash-object", "-w", "--stdin-paths"], {
      stdin: existingPaths.join("\n") + "\n",
    });
    const shas = output.trim().split("\n");
    existingPaths.forEach((path, index) => state.set(path, shas[index]));
  }
  if (deletedPaths.length > 0) {
    const sentinelSha = (
      await git.run(["hash-object", "-w", "--stdin"], {
        stdin: DELETED_SENTINEL_CONTENT,
      })
    ).trim();
    for (const path of deletedPaths) {
      const prior = state.get(path);
      if (prior === undefined) {
        preDeletionChanged = preDeletion.delete(path) || preDeletionChanged;
      } else if (prior !== sentinelSha && preDeletion.get(path) !== prior) {
        preDeletion.set(path, prior);
        preDeletionChanged = true;
      }
      state.set(path, sentinelSha);
    }
  }

  // Pre-deletion first: a failed review write then leaves only a harmless
  // extra entry, never a sentinel with the inherited snapshot lost behind it
  if (preDeletionChanged) {
    await writeSnapshotTree(git, preDeletionRefForBranch(branch), preDeletion);
  }
  await writeReviewState(git, branch, state);
};

export const unmarkReviewed = async (
  git: Git,
  branch: string,
  paths: string[],
): Promise<void> => {
  const state = await readReviewState(git, branch);
  for (const path of paths) {
    state.delete(path);
  }
  await writeReviewState(git, branch, state);

  const preDeletion = await readPreDeletionState(git, branch);
  let preDeletionChanged = false;
  for (const path of paths) {
    preDeletionChanged = preDeletion.delete(path) || preDeletionChanged;
  }
  if (preDeletionChanged) {
    await writeSnapshotTree(git, preDeletionRefForBranch(branch), preDeletion);
  }
};

// Drops every snapshot on the branch, including snapshots for paths that are
// no longer in the review set — leaving those behind is what makes a diff open
// against a stale base. Committing an empty tree rather than deleting the ref
// keeps the history browsable and keeps the superseded blobs anchored against
// `git gc`; deleting the ref outright is the palette command's job.
export const clearAllReviewSnapshots = async (
  git: Git,
  branch: string,
): Promise<void> => {
  const state = await readReviewState(git, branch);
  const preDeletion = await readPreDeletionState(git, branch);
  if (state.size > 0) {
    await writeReviewState(git, branch, new Map());
  }
  if (preDeletion.size > 0) {
    await writeSnapshotTree(git, preDeletionRefForBranch(branch), new Map());
  }
};
