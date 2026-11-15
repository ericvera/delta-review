import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Git } from "./git";
import {
  clearAllReviewSnapshots,
  markReviewed,
  unmarkReviewed,
} from "./reviewState";

const BRANCH = "fix/unmark-all";
const REVIEW_REF = `refs/review/${BRANCH}`;
const PRE_DELETION_REF = `refs/review-predeletion/${BRANCH}`;
const SNAPSHOT_SHA = "1".repeat(40);
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PARENT_SHA = "2".repeat(40);
const COMMIT_SHA = "3".repeat(40);
const SENTINEL_SHA = "5".repeat(40);
const WORKING_SHA = "6".repeat(40);
const OTHER_SHA = "7".repeat(40);

type Snapshots = Record<string, string> | undefined;

// A Git stub recording every call and its stdin. `entries` is what the review
// ref holds and `preDeletion` what the pre-deletion ref holds; undefined means
// the ref does not exist, which `ls-tree` reports by failing.
const setUp = (
  entries: Snapshots,
  preDeletion?: Snapshots,
  repoRoot = "/repo",
): { git: Git; calls: string[][]; stdins: (string | undefined)[] } => {
  const calls: string[][] = [];
  const stdins: (string | undefined)[] = [];
  const lsTree = (snapshots: Snapshots): string => {
    if (snapshots === undefined) {
      throw new Error("fatal: not a valid object name");
    }
    return Object.entries(snapshots)
      .map(([path, sha]) => `100644 blob ${sha}\t${path}\0`)
      .join("");
  };
  const git: Git = {
    repoRoot,
    run: async (args, options) => {
      calls.push([...args]);
      stdins.push(options?.stdin);
      if (args[0] === "ls-tree" && args[3] === REVIEW_REF) {
        return lsTree(entries);
      }
      if (args[0] === "ls-tree" && args[3] === PRE_DELETION_REF) {
        return lsTree(preDeletion);
      }
      if (args[0] === "read-tree" || args[0] === "update-index") {
        return "";
      }
      if (args[0] === "write-tree") {
        return `${EMPTY_TREE_SHA}\n`;
      }
      if (args[0] === "rev-parse") {
        return `${PARENT_SHA}\n`;
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
      ["ls-tree", "-r", "-z", REVIEW_REF],
      ["ls-tree", "-r", "-z", PRE_DELETION_REF],
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
      PARENT_SHA,
      "-m",
      "delta-review state",
    ]);
    expect(calls).toContainEqual(["update-ref", REVIEW_REF, COMMIT_SHA]);
  });

  it("drops a snapshot for a path that is no longer in the review set", async () => {
    const { git, calls } = setUp({ "src/gone.ts": SNAPSHOT_SHA });
    await clearAllReviewSnapshots(git, BRANCH);
    // The clear takes no path list at all, so a stale entry cannot survive it
    expect(calls.some((args) => args.includes("src/gone.ts"))).toBe(false);
    expect(calls).toContainEqual(["update-ref", REVIEW_REF, COMMIT_SHA]);
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
