import { describe, expect, it } from "vitest";
import type { Git } from "./git";
import { clearAllReviewSnapshots } from "./reviewState";

const BRANCH = "fix/unmark-all";
const REVIEW_REF = `refs/review/${BRANCH}`;
const SNAPSHOT_SHA = "1".repeat(40);
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PARENT_SHA = "2".repeat(40);
const COMMIT_SHA = "3".repeat(40);

// A Git stub recording every call. `entries` is what the review ref holds;
// undefined means the ref does not exist, which `ls-tree` reports by failing.
const setUp = (
  entries: Record<string, string> | undefined,
): { git: Git; calls: string[][] } => {
  const calls: string[][] = [];
  const git: Git = {
    repoRoot: "/repo",
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "ls-tree") {
        if (entries === undefined) {
          throw new Error("fatal: not a valid object name");
        }
        return Object.entries(entries)
          .map(([path, sha]) => `100644 blob ${sha}\t${path}\0`)
          .join("");
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
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  };
  return { git, calls };
};

const wrote = (calls: string[][]): boolean =>
  calls.some((args) =>
    ["write-tree", "commit-tree", "update-ref"].includes(args[0]),
  );

describe("clearAllReviewSnapshots", () => {
  it("writes nothing when the branch has no review ref", async () => {
    const { git, calls } = setUp(undefined);
    await clearAllReviewSnapshots(git, BRANCH);
    expect(calls).toEqual([["ls-tree", "-r", "-z", REVIEW_REF]]);
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
