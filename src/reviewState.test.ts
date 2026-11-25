import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, type Git } from "./git";
import {
  clearAllReviewSnapshots,
  markReviewed,
  readReviewState,
  ReviewStateConflictError,
  unmarkReviewed,
} from "./reviewState";

const BRANCH = "fix/unmark-all";
const REVIEW_REF = `refs/review/${BRANCH}`;
const PRE_DELETION_REF = `refs/review-predeletion/${BRANCH}`;
const SNAPSHOT_SHA = "1".repeat(40);
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const REVIEW_COMMIT = "2".repeat(40);
const PRE_DELETION_COMMIT = "8".repeat(40);
const COMMIT_SHA = "3".repeat(40);
const SENTINEL_SHA = "5".repeat(40);
const WORKING_SHA = "6".repeat(40);
const OTHER_SHA = "7".repeat(40);

type Snapshots = Record<string, string> | undefined;

// A Git stub recording every call and its stdin. `entries` is what the review
// ref holds and `preDeletion` what the pre-deletion ref holds; undefined means
// the ref does not exist, which `rev-parse --verify --quiet` reports by failing.
const setUp = (
  entries: Snapshots,
  preDeletion?: Snapshots,
  repoRoot = "/repo",
): { git: Git; calls: string[][]; stdins: (string | undefined)[] } => {
  const calls: string[][] = [];
  const stdins: (string | undefined)[] = [];
  const lsTree = (snapshots: Snapshots): string =>
    Object.entries(snapshots ?? {})
      .map(([path, sha]) => `100644 blob ${sha}\t${path}\0`)
      .join("");
  const git: Git = {
    repoRoot,
    run: async (args, options) => {
      calls.push([...args]);
      stdins.push(options?.stdin);
      if (args[0] === "rev-parse") {
        const snapshots = args[3] === REVIEW_REF ? entries : preDeletion;
        if (snapshots === undefined) {
          throw new Error("Command failed: git rev-parse");
        }
        return `${args[3] === REVIEW_REF ? REVIEW_COMMIT : PRE_DELETION_COMMIT}\n`;
      }
      if (args[0] === "ls-tree" && args[3] === REVIEW_COMMIT) {
        return lsTree(entries);
      }
      if (args[0] === "ls-tree" && args[3] === PRE_DELETION_COMMIT) {
        return lsTree(preDeletion);
      }
      if (args[0] === "read-tree" || args[0] === "update-index") {
        return "";
      }
      if (args[0] === "write-tree") {
        return `${EMPTY_TREE_SHA}\n`;
      }
      if (args[0] === "commit-tree") {
        return `${COMMIT_SHA}\n`;
      }
      if (args[0] === "update-ref") {
        return "";
      }
      if (args[0] === "hash-object" && args[2] === "--stdin") {
        return `${SENTINEL_SHA}\n`;
      }
      if (args[0] === "hash-object" && args[2] === "--stdin-paths") {
        const paths = (options?.stdin ?? "").trim().split("\n");
        return paths.map(() => WORKING_SHA).join("\n") + "\n";
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  };
  return { git, calls, stdins };
};

const wrote = (calls: string[][]): boolean =>
  calls.some((args) =>
    ["write-tree", "commit-tree", "update-ref"].includes(args[0]),
  );

// The refs each `update-ref` targeted, in call order
const updatedRefs = (calls: string[][]): string[] =>
  calls.filter((args) => args[0] === "update-ref").map((args) => args[1]);

// The tree each ref was last written with, as `path sha` lines; a write that
// staged nothing is the empty tree
const writtenTree = (
  calls: string[][],
  stdins: (string | undefined)[],
  ref: string,
): string[] | undefined => {
  const lastIndex = (match: (args: string[], index: number) => boolean) =>
    calls.reduce(
      (found, args, index) => (match(args, index) ? index : found),
      -1,
    );
  const end = lastIndex((args) => args[0] === "update-ref" && args[1] === ref);
  if (end === -1) {
    return undefined;
  }
  const start = lastIndex(
    (args, index) => index < end && args[0] === "read-tree",
  );
  const staged = calls.findIndex(
    (args, index) => index > start && index < end && args[0] === "update-index",
  );
  if (staged === -1) {
    return [];
  }
  return (stdins[staged] ?? "")
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [meta, path] = entry.split("\t");
      return `${path} ${meta.split(" ")[1]}`;
    });
};

describe("clearAllReviewSnapshots", () => {
  it("writes nothing when the branch has no review ref", async () => {
    const { git, calls } = setUp(undefined);
    await clearAllReviewSnapshots(git, BRANCH);
    expect(calls).toEqual([
      ["rev-parse", "--verify", "--quiet", REVIEW_REF],
      ["rev-parse", "--verify", "--quiet", PRE_DELETION_REF],
    ]);
    expect(wrote(calls)).toBe(false);
  });

  it("writes nothing when the ref exists but holds no snapshots", async () => {
    const { git, calls } = setUp({});
    await clearAllReviewSnapshots(git, BRANCH);
    expect(wrote(calls)).toBe(false);
  });

  it("commits an empty tree onto the ref when snapshots exist", async () => {
    const { git, calls } = setUp({
      "src/a.ts": SNAPSHOT_SHA,
      "src/b.ts": SNAPSHOT_SHA,
    });
    await clearAllReviewSnapshots(git, BRANCH);
    // Nothing is staged, so the tree written is the empty one
    expect(calls.some((args) => args[0] === "update-index")).toBe(false);
    expect(calls).toContainEqual(["write-tree"]);
    expect(calls).toContainEqual([
      "commit-tree",
      EMPTY_TREE_SHA,
      "-p",
      REVIEW_COMMIT,
      "-m",
      "delta-review state",
    ]);
    expect(calls).toContainEqual([
      "update-ref",
      REVIEW_REF,
      COMMIT_SHA,
      REVIEW_COMMIT,
    ]);
  });

  it("drops a snapshot for a path that is no longer in the review set", async () => {
    const { git, calls } = setUp({ "src/gone.ts": SNAPSHOT_SHA });
    await clearAllReviewSnapshots(git, BRANCH);
    // The clear takes no path list at all, so a stale entry cannot survive it
    expect(calls.some((args) => args.includes("src/gone.ts"))).toBe(false);
    expect(calls).toContainEqual([
      "update-ref",
      REVIEW_REF,
      COMMIT_SHA,
      REVIEW_COMMIT,
    ]);
  });
});

describe("clearAllReviewSnapshots with pre-deletion snapshots", () => {
  it("empties the pre-deletion ref even when the review state is empty", async () => {
    const { git, calls, stdins } = setUp({}, { "src/old.ts": SNAPSHOT_SHA });
    await clearAllReviewSnapshots(git, BRANCH);
    expect(updatedRefs(calls)).toEqual([PRE_DELETION_REF]);
    expect(writtenTree(calls, stdins, PRE_DELETION_REF)).toEqual([]);
  });

  it("empties both refs", async () => {
    const { git, calls, stdins } = setUp(
      { "src/old.ts": SENTINEL_SHA },
      { "src/old.ts": SNAPSHOT_SHA },
    );
    await clearAllReviewSnapshots(git, BRANCH);
    expect(updatedRefs(calls)).toEqual([REVIEW_REF, PRE_DELETION_REF]);
    expect(writtenTree(calls, stdins, REVIEW_REF)).toEqual([]);
    expect(writtenTree(calls, stdins, PRE_DELETION_REF)).toEqual([]);
  });
});

describe("markReviewed", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "delta-review-state-"));
    await writeFile(join(repoRoot, "live.ts"), "live");
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("saves a deleted path's prior snapshot before the review ref takes the sentinel", async () => {
    const { git, calls, stdins } = setUp(
      { "old.ts": SNAPSHOT_SHA },
      undefined,
      repoRoot,
    );
    await markReviewed(git, BRANCH, ["old.ts"]);
    expect(updatedRefs(calls)).toEqual([PRE_DELETION_REF, REVIEW_REF]);
    expect(writtenTree(calls, stdins, PRE_DELETION_REF)).toEqual([
      `old.ts ${SNAPSHOT_SHA}`,
    ]);
    expect(writtenTree(calls, stdins, REVIEW_REF)).toEqual([
      `old.ts ${SENTINEL_SHA}`,
    ]);
  });

  it("writes no pre-deletion commit when re-marking a deleted path", async () => {
    const { git, calls } = setUp(
      { "old.ts": SENTINEL_SHA },
      { "old.ts": SNAPSHOT_SHA },
      repoRoot,
    );
    await markReviewed(git, BRANCH, ["old.ts"]);
    expect(updatedRefs(calls)).toEqual([REVIEW_REF]);
  });

  it("drops a stale pre-deletion entry for a deleted path with no prior snapshot", async () => {
    const { git, calls, stdins } = setUp(
      { "other.ts": OTHER_SHA },
      { "old.ts": SNAPSHOT_SHA, "gone.ts": OTHER_SHA },
      repoRoot,
    );
    await markReviewed(git, BRANCH, ["old.ts"]);
    expect(updatedRefs(calls)).toEqual([PRE_DELETION_REF, REVIEW_REF]);
    expect(writtenTree(calls, stdins, PRE_DELETION_REF)).toEqual([
      `gone.ts ${OTHER_SHA}`,
    ]);
  });

  it("drops an existing path's pre-deletion entry", async () => {
    const { git, calls, stdins } = setUp(
      { "live.ts": SENTINEL_SHA },
      { "live.ts": SNAPSHOT_SHA },
      repoRoot,
    );
    await markReviewed(git, BRANCH, ["live.ts"]);
    expect(updatedRefs(calls)).toEqual([PRE_DELETION_REF, REVIEW_REF]);
    expect(writtenTree(calls, stdins, PRE_DELETION_REF)).toEqual([]);
    expect(writtenTree(calls, stdins, REVIEW_REF)).toEqual([
      `live.ts ${WORKING_SHA}`,
    ]);
  });

  it("writes no pre-deletion commit when marking an existing path without an entry", async () => {
    const { git, calls } = setUp({}, undefined, repoRoot);
    await markReviewed(git, BRANCH, ["live.ts"]);
    expect(updatedRefs(calls)).toEqual([REVIEW_REF]);
  });
});

describe("unmarkReviewed", () => {
  it("drops the pre-deletion entry after writing the review ref", async () => {
    const { git, calls, stdins } = setUp(
      { "old.ts": SENTINEL_SHA, "other.ts": OTHER_SHA },
      { "old.ts": SNAPSHOT_SHA },
    );
    await unmarkReviewed(git, BRANCH, ["old.ts"]);
    expect(updatedRefs(calls)).toEqual([REVIEW_REF, PRE_DELETION_REF]);
    expect(writtenTree(calls, stdins, REVIEW_REF)).toEqual([
      `other.ts ${OTHER_SHA}`,
    ]);
    expect(writtenTree(calls, stdins, PRE_DELETION_REF)).toEqual([]);
  });

  it("writes no pre-deletion commit when the path has no entry", async () => {
    const { git, calls } = setUp({ "old.ts": SNAPSHOT_SHA }, undefined);
    await unmarkReviewed(git, BRANCH, ["old.ts"]);
    expect(updatedRefs(calls)).toEqual([REVIEW_REF]);
  });
});

describe("concurrent review-state writers", () => {
  const branch = "main";
  const reviewRef = `refs/review/${branch}`;
  let repoRoot: string;
  let git: Git;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "delta-review-cas-"));
    git = createGit(repoRoot);
    await git.run(["init", "-b", "main"]);
    await git.run(["config", "user.email", "test@example.com"]);
    await git.run(["config", "user.name", "Test"]);
    await git.run(["config", "commit.gpgsign", "false"]);
    await writeFile(join(repoRoot, "a.txt"), "a\n");
    await writeFile(join(repoRoot, "b.txt"), "b\n");
    await git.run(["add", "."]);
    await git.run(["commit", "-m", "init"]);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const reviewedPaths = async (): Promise<string[]> =>
    [...(await readReviewState(git, branch)).keys()].sort();

  const refHistory = async (ref: string): Promise<string[]> =>
    (await git.run(["log", "--format=%H", ref])).trim().split("\n");

  // Runs `inject` once, just before the first git call matching `trigger`
  const injectBefore = (
    trigger: string,
    inject: () => Promise<unknown>,
  ): Git => {
    let injected = false;
    return {
      repoRoot,
      run: async (args, options) => {
        if (!injected && args[0] === trigger) {
          injected = true;
          await inject();
        }
        return git.run(args, options);
      },
    };
  };

  it("keeps a mark another writer lands mid-markReviewed", async () => {
    const racing = injectBefore("hash-object", () =>
      markReviewed(git, branch, ["b.txt"]),
    );
    await markReviewed(racing, branch, ["a.txt"], { sleep: async () => {} });
    expect(await reviewedPaths()).toEqual(["a.txt", "b.txt"]);
    // The concurrent mark's commit, then the retried mark on top of it
    expect(await refHistory(reviewRef)).toHaveLength(2);
  });

  it("keeps a mark another writer lands mid-unmarkReviewed", async () => {
    await markReviewed(git, branch, ["a.txt"]);
    const racing = injectBefore("write-tree", () =>
      markReviewed(git, branch, ["b.txt"]),
    );
    await unmarkReviewed(racing, branch, ["a.txt"], { sleep: async () => {} });
    expect(await reviewedPaths()).toEqual(["b.txt"]);
  });

  it("rejects with a moved conflict after every attempt loses the race", async () => {
    let moves = 0;
    const racing: Git = {
      repoRoot,
      run: async (args, options) => {
        if (args[0] === "update-ref") {
          moves += 1;
          const tree = (await git.run(["write-tree"])).trim();
          const commit = (
            await git.run(["commit-tree", tree, "-m", `move ${moves}`])
          ).trim();
          await git.run(["update-ref", reviewRef, commit]);
        }
        return git.run(args, options);
      },
    };
    const result = markReviewed(racing, branch, ["a.txt"], {
      sleep: async () => {},
    });
    await expect(result).rejects.toBeInstanceOf(ReviewStateConflictError);
    await expect(result).rejects.toMatchObject({
      kind: "moved",
      ref: reviewRef,
    });
    expect(moves).toBe(3);
  });

  it("rejects with a locked conflict while a stale lock file stays", async () => {
    await markReviewed(git, branch, ["a.txt"]);
    const before = await git.run(["rev-parse", reviewRef]);
    await writeFile(join(repoRoot, ".git", "refs", "review", "main.lock"), "");
    let updateRefs = 0;
    const counting: Git = {
      repoRoot,
      run: (args, options) => {
        if (args[0] === "update-ref") {
          updateRefs += 1;
        }
        return git.run(args, options);
      },
    };
    const result = markReviewed(counting, branch, ["b.txt"], {
      sleep: async () => {},
    });
    await expect(result).rejects.toBeInstanceOf(ReviewStateConflictError);
    const error = (await result.catch((e: unknown) => e)) as {
      kind: string;
      lockPath: string;
      message: string;
    };
    expect(error.kind).toBe("locked");
    expect(error.lockPath).toMatch(/main\.lock$/);
    expect(error.message).toBe(`${reviewRef} is locked (${error.lockPath})`);
    expect(updateRefs).toBe(3);
    expect(await git.run(["rev-parse", reviewRef])).toBe(before);
  });
});

describe("compare-and-set review-state writes", () => {
  // Rejects the first `update-ref` with `failure`, passing later calls through
  const failFirstUpdateRef = (git: Git, failure: Error): Git => {
    let failed = false;
    return {
      ...git,
      run: async (args, options) => {
        const result = await git.run(args, options);
        if (args[0] === "update-ref" && !failed) {
          failed = true;
          throw failure;
        }
        return result;
      },
    };
  };

  it("creates a missing ref only if it still does not exist", async () => {
    const { git, calls } = setUp(undefined);
    await unmarkReviewed(git, BRANCH, ["old.ts"]);
    expect(calls).toContainEqual(["update-ref", REVIEW_REF, COMMIT_SHA, ""]);
    expect(calls).toContainEqual([
      "commit-tree",
      EMPTY_TREE_SHA,
      "-m",
      "delta-review state",
    ]);
  });

  it("retries after another git process briefly held the ref lock", async () => {
    const { git, calls } = setUp({ "old.ts": SNAPSHOT_SHA, "b.ts": OTHER_SHA });
    const flaky = failFirstUpdateRef(
      git,
      new Error(
        "Command failed: git update-ref\nfatal: update_ref failed for ref 'refs/review/x': cannot lock ref 'refs/review/x': Unable to create '/r/.git/refs/review/x.lock': File exists.\n",
      ),
    );
    await unmarkReviewed(flaky, BRANCH, ["old.ts"], { sleep: async () => {} });
    expect(updatedRefs(calls)).toEqual([REVIEW_REF, REVIEW_REF]);
  });

  it("rethrows a non-conflict update-ref failure unchanged", async () => {
    const { git, calls } = setUp({ "old.ts": SNAPSHOT_SHA });
    const failure = new Error(
      "Command failed: git update-ref\nfatal: disk full",
    );
    const broken = failFirstUpdateRef(git, failure);
    await expect(
      unmarkReviewed(broken, BRANCH, ["old.ts"], { sleep: async () => {} }),
    ).rejects.toBe(failure);
    expect(updatedRefs(calls)).toEqual([REVIEW_REF]);
  });
});
