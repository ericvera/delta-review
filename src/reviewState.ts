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

export class ReviewStateConflictError extends Error {
  override readonly name = "ReviewStateConflictError";

  constructor(
    readonly ref: string,
    readonly kind: "moved" | "locked",
    readonly lockPath?: string,
  ) {
    super(
      kind === "moved"
        ? `${ref} changed while it was being written`
        : `${ref} is locked (${lockPath})`,
    );
  }
}

type Sleep = (ms: number) => Promise<void>;

export interface ConflictRetryOptions {
  sleep?: Sleep;
}

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Runs the whole read-modify-write again on a conflict, so each attempt
// re-reads the refs it is about to compare-and-set
const withConflictRetry = async <T>(
  fn: () => Promise<T>,
  {
    attempts = 3,
    delays = [50, 200],
    sleep = defaultSleep,
  }: { attempts?: number; delays?: number[]; sleep?: Sleep } = {},
): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof ReviewStateConflictError) || attempt >= attempts) {
        throw error;
      }
      await sleep(delays[attempt - 1] ?? delays[delays.length - 1] ?? 0);
    }
  }
};

// A missing ref resolves to undefined
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

// Reads a path -> blob sha map from a snapshot ref; a missing ref reads empty.
// The tree is read from the resolved commit rather than the ref, so the map
// and the commit a later compare-and-set expects always agree.
const readSnapshotWithCommit = async (
  git: Git,
  ref: string,
): Promise<{ state: Map<string, string>; commit: string | undefined }> => {
  const commit = await readRefCommit(git, ref);
  if (commit === undefined) {
    return { state: new Map(), commit };
  }
  const output = await git.run(["ls-tree", "-r", "-z", commit]);
  return { state: parseLsTreeOutput(output), commit };
};

const readSnapshotTree = async (
  git: Git,
  ref: string,
): Promise<Map<string, string>> =>
  (await readSnapshotWithCommit(git, ref)).state;

const LOCKED_PATTERN =
  /cannot lock ref .*Unable to create '([^']+\.lock)'.*File exists/s;

// Persists a path -> blob sha map as a commit on the ref. The commit tree
// anchors the snapshot blobs so `git gc` never collects them, and the parent
// chain keeps a browsable history of review sessions. The ref only moves if
// it still points at `expectedOld`, the commit the caller read its state from,
// so a concurrent writer in another window or worktree is never overwritten.
const writeSnapshotTree = async (
  git: Git,
  ref: string,
  state: Map<string, string>,
  expectedOld: string | undefined,
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
    const parentArgs = expectedOld === undefined ? [] : ["-p", expectedOld];
    const commit = (
      await git.run([
        "commit-tree",
        tree,
        ...parentArgs,
        "-m",
        "delta-review state",
      ])
    ).trim();
    // An empty old value makes git require that the ref does not exist yet
    try {
      await git.run(["update-ref", ref, commit, expectedOld ?? ""]);
    } catch (error) {
      // A lock held by another git process (or left stale by a crashed one)
      // is checked first: the ref may still equal expectedOld behind it
      const locked = LOCKED_PATTERN.exec(
        error instanceof Error ? error.message : String(error),
      );
      if (locked) {
        throw new ReviewStateConflictError(ref, "locked", locked[1]);
      }
      if ((await readRefCommit(git, ref)) !== expectedOld) {
        throw new ReviewStateConflictError(ref, "moved");
      }
      throw error;
    }
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

// A lone write has no earlier read to protect, so it compares against the
// ref's current commit
export const writeReviewState = async (
  git: Git,
  branch: string,
  state: Map<string, string>,
): Promise<void> => {
  const ref = reviewRefForBranch(branch);
  await writeSnapshotTree(git, ref, state, await readRefCommit(git, ref));
};

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
export const markReviewed = (
  git: Git,
  branch: string,
  paths: string[],
  options?: ConflictRetryOptions,
): Promise<void> =>
  withConflictRetry(async () => {
    const reviewRef = reviewRefForBranch(branch);
    const preDeletionRef = preDeletionRefForBranch(branch);
    const { state, commit: reviewCommit } = await readSnapshotWithCommit(
      git,
      reviewRef,
    );
    const { state: preDeletion, commit: preDeletionCommit } =
      await readSnapshotWithCommit(git, preDeletionRef);
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
    // extra entry, never a sentinel with the inherited snapshot lost behind
    // it. A conflict on the review write after this one landed is safe to
    // retry: the retry re-reads pre-deletion and finds its entry in place.
    if (preDeletionChanged) {
      await writeSnapshotTree(
        git,
        preDeletionRef,
        preDeletion,
        preDeletionCommit,
      );
    }
    await writeSnapshotTree(git, reviewRef, state, reviewCommit);
  }, options);

export const unmarkReviewed = (
  git: Git,
  branch: string,
  paths: string[],
  options?: ConflictRetryOptions,
): Promise<void> =>
  withConflictRetry(async () => {
    const reviewRef = reviewRefForBranch(branch);
    const preDeletionRef = preDeletionRefForBranch(branch);
    const { state, commit: reviewCommit } = await readSnapshotWithCommit(
      git,
      reviewRef,
    );
    for (const path of paths) {
      state.delete(path);
    }
    await writeSnapshotTree(git, reviewRef, state, reviewCommit);

    const { state: preDeletion, commit: preDeletionCommit } =
      await readSnapshotWithCommit(git, preDeletionRef);
    let preDeletionChanged = false;
    for (const path of paths) {
      preDeletionChanged = preDeletion.delete(path) || preDeletionChanged;
    }
    if (preDeletionChanged) {
      await writeSnapshotTree(
        git,
        preDeletionRef,
        preDeletion,
        preDeletionCommit,
      );
    }
  }, options);

// Drops every snapshot on the branch, including snapshots for paths that are
// no longer in the review set — leaving those behind is what makes a diff open
// against a stale base. Committing an empty tree rather than deleting the ref
// keeps the history browsable and keeps the superseded blobs anchored against
// `git gc`; deleting the ref outright is the palette command's job.
export const clearAllReviewSnapshots = (
  git: Git,
  branch: string,
  options?: ConflictRetryOptions,
): Promise<void> =>
  withConflictRetry(async () => {
    const reviewRef = reviewRefForBranch(branch);
    const preDeletionRef = preDeletionRefForBranch(branch);
    const { state, commit: reviewCommit } = await readSnapshotWithCommit(
      git,
      reviewRef,
    );
    const { state: preDeletion, commit: preDeletionCommit } =
      await readSnapshotWithCommit(git, preDeletionRef);
    if (state.size > 0) {
      await writeSnapshotTree(git, reviewRef, new Map(), reviewCommit);
    }
    if (preDeletion.size > 0) {
      await writeSnapshotTree(
        git,
        preDeletionRef,
        new Map(),
        preDeletionCommit,
      );
    }
  }, options);
