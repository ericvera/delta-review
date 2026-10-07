import { describe, expect, it } from "vitest";
import type { Git } from "./git";
import {
  anchorSlices,
  anchorSlicesIntoCache,
  deleteSliceRef,
  sliceRefForBranch,
} from "./sliceAnchor";

const BRANCH = "feat/extract-helpers";
const SLICE_REF = `refs/review-slices/${BRANCH}`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TREE_SHA = "1".repeat(40);
const OTHER_TREE_SHA = "4".repeat(40);
const PARENT_SHA = "2".repeat(40);
const COMMIT_SHA = "3".repeat(40);
// `update-index -z` terminates each entry with a NUL rather than a newline
const NUL = "\u0000";

interface Call {
  args: string[];
  stdin: string | undefined;
  indexFile: string | undefined;
}

// A Git stub recording every call. `head` is what the slice ref holds:
// undefined means the ref does not exist, which both `rev-parse` forms and
// `update-ref -d` report by failing; otherwise it is the tree its commit
// points at, so a test can make the rebuilt tree match or differ.
const setUp = (
  head: { tree: string } | undefined,
): { git: Git; calls: Call[] } => {
  const calls: Call[] = [];
  const git: Git = {
    repoRoot: "/repo",
    run: async (args, options) => {
      calls.push({
        args: [...args],
        stdin: options?.stdin,
        indexFile: options?.env?.GIT_INDEX_FILE,
      });
      if (args[0] === "read-tree" || args[0] === "update-index") {
        return "";
      }
      if (args[0] === "write-tree") {
        return `${TREE_SHA}\n`;
      }
      if (args[0] === "rev-parse") {
        if (head === undefined) {
          throw new Error("fatal: needed a single revision");
        }
        return args.includes(`${SLICE_REF}^{tree}`)
          ? `${head.tree}\n`
          : `${PARENT_SHA}\n`;
      }
      if (args[0] === "commit-tree") {
        return `${COMMIT_SHA}\n`;
      }
      if (args[0] === "update-ref") {
        if (args[1] === "-d" && head === undefined) {
          throw new Error("fatal: no such ref");
        }
        return "";
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  };
  return { git, calls };
};

const argsOf = (calls: Call[]): string[][] => calls.map((call) => call.args);

describe("sliceRefForBranch", () => {
  it("puts the branch name in the ref verbatim", () => {
    expect(sliceRefForBranch(BRANCH)).toBe(SLICE_REF);
  });
});

describe("anchorSlices", () => {
  it("deletes an existing ref when the slice set is empty", async () => {
    const { git, calls } = setUp({ tree: OTHER_TREE_SHA });
    await anchorSlices(git, BRANCH, []);
    expect(argsOf(calls)).toEqual([
      ["rev-parse", "--verify", "--quiet", SLICE_REF],
      ["update-ref", "-d", SLICE_REF],
    ]);
  });

  it("writes nothing at all when the slice set is empty and the ref is gone", async () => {
    const { git, calls } = setUp(undefined);
    await expect(anchorSlices(git, BRANCH, [])).resolves.toBeUndefined();
    expect(argsOf(calls)).toEqual([
      ["rev-parse", "--verify", "--quiet", SLICE_REF],
    ]);
  });

  it("writes one sorted, deduped entry per sha with the sha as its path", async () => {
    const { git, calls } = setUp(undefined);
    await anchorSlices(git, BRANCH, [SHA_B, SHA_A, SHA_B]);
    const updateIndex = calls.find((call) => call.args[0] === "update-index");
    expect(updateIndex?.args).toEqual(["update-index", "-z", "--index-info"]);
    expect(updateIndex?.stdin).toBe(
      `100644 ${SHA_A} 0\t${SHA_A}${NUL}100644 ${SHA_B} 0\t${SHA_B}${NUL}`,
    );
  });

  it("builds the tree in a temporary index, away from the user's", async () => {
    const { git, calls } = setUp(undefined);
    await anchorSlices(git, BRANCH, [SHA_A]);
    const indexFiles = new Set(
      calls
        .filter((call) =>
          ["read-tree", "update-index", "write-tree"].includes(call.args[0]),
        )
        .map((call) => call.indexFile),
    );
    expect(indexFiles.size).toBe(1);
    expect([...indexFiles][0]).toMatch(/delta-review-[0-9a-f]{16}$/);
    expect(
      calls.find((call) => call.args[0] === "commit-tree")?.indexFile,
    ).toBeUndefined();
  });

  it("commits a parentless anchor when the ref does not exist yet", async () => {
    const { git, calls } = setUp(undefined);
    await anchorSlices(git, BRANCH, [SHA_A]);
    expect(argsOf(calls)).toEqual([
      ["read-tree", "--empty"],
      ["update-index", "-z", "--index-info"],
      ["write-tree"],
      ["rev-parse", "--verify", "--quiet", SLICE_REF],
      ["commit-tree", TREE_SHA, "-m", "delta-review slices"],
      ["update-ref", SLICE_REF, COMMIT_SHA],
    ]);
  });

  it("commits onto the previous anchor when the tree changed", async () => {
    const { git, calls } = setUp({ tree: OTHER_TREE_SHA });
    await anchorSlices(git, BRANCH, [SHA_A]);
    expect(argsOf(calls)).toEqual([
      ["read-tree", "--empty"],
      ["update-index", "-z", "--index-info"],
      ["write-tree"],
      ["rev-parse", "--verify", "--quiet", SLICE_REF],
      ["rev-parse", `${SLICE_REF}^{tree}`],
      ["commit-tree", TREE_SHA, "-p", PARENT_SHA, "-m", "delta-review slices"],
      ["update-ref", SLICE_REF, COMMIT_SHA],
    ]);
  });

  it("commits nothing when the ref already anchors the same tree", async () => {
    const { git, calls } = setUp({ tree: TREE_SHA });
    await anchorSlices(git, BRANCH, [SHA_A]);
    expect(argsOf(calls)).toEqual([
      ["read-tree", "--empty"],
      ["update-index", "-z", "--index-info"],
      ["write-tree"],
      ["rev-parse", "--verify", "--quiet", SLICE_REF],
      ["rev-parse", `${SLICE_REF}^{tree}`],
    ]);
  });
});

describe("deleteSliceRef", () => {
  it("deletes the ref", async () => {
    const { git, calls } = setUp({ tree: TREE_SHA });
    await deleteSliceRef(git, BRANCH);
    expect(argsOf(calls)).toEqual([["update-ref", "-d", SLICE_REF]]);
  });

  it("swallows a missing ref", async () => {
    const { git, calls } = setUp(undefined);
    await expect(deleteSliceRef(git, BRANCH)).resolves.toBeUndefined();
    expect(argsOf(calls)).toEqual([["update-ref", "-d", SLICE_REF]]);
  });
});

describe("anchorSlicesIntoCache", () => {
  const KEY_A = "origin1:1-2";
  const KEY_B = "origin2:3-4";
  const KEY_GONE = "origin3:5-6";
  const SHA_GONE = "c".repeat(40);

  it("leaves the cache and the ref alone for a refresh already superseded", async () => {
    const anchored: (readonly string[])[] = [];
    const cache = new Map([[KEY_A, SHA_A]]);
    const ran = await anchorSlicesIntoCache({
      anchor: async (shas) => {
        anchored.push(shas);
      },
      isCurrent: () => false,
      shas: [SHA_A, SHA_B],
      candidates: new Map([
        [KEY_A, SHA_A],
        [KEY_B, SHA_B],
      ]),
      cache,
    });
    expect(ran).toBe(false);
    expect(anchored).toEqual([]);
    expect([...cache]).toEqual([[KEY_A, SHA_A]]);
  });

  it("publishes exactly the anchored candidates once anchored", async () => {
    const anchored: (readonly string[])[] = [];
    const cache = new Map([[KEY_GONE, SHA_GONE]]);
    const ran = await anchorSlicesIntoCache({
      anchor: async (shas) => {
        anchored.push(shas);
      },
      isCurrent: () => true,
      shas: [SHA_A],
      candidates: new Map([
        [KEY_A, SHA_A],
        [KEY_B, SHA_B],
        [KEY_GONE, SHA_GONE],
      ]),
      cache,
    });
    expect(ran).toBe(true);
    expect(anchored).toEqual([[SHA_A]]);
    expect([...cache]).toEqual([[KEY_A, SHA_A]]);
  });

  it("empties the cache when superseded while anchoring", async () => {
    let current = true;
    const cache = new Map([[KEY_A, SHA_A]]);
    const ran = await anchorSlicesIntoCache({
      anchor: async () => {
        current = false;
      },
      isCurrent: () => current,
      shas: [SHA_A, SHA_B],
      candidates: new Map([
        [KEY_A, SHA_A],
        [KEY_B, SHA_B],
      ]),
      cache,
    });
    expect(ran).toBe(true);
    expect(cache.size).toBe(0);
  });

  it("empties the cache and rethrows when the anchor fails", async () => {
    const failure = new Error("update-ref failed");
    const cache = new Map([[KEY_A, SHA_A]]);
    await expect(
      anchorSlicesIntoCache({
        anchor: async () => {
          throw failure;
        },
        isCurrent: () => true,
        shas: [SHA_A],
        candidates: new Map([[KEY_A, SHA_A]]),
        cache,
      }),
    ).rejects.toBe(failure);
    expect(cache.size).toBe(0);
  });
});
