import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClusterModel,
  ClustersContract,
  clusterBucketForKey,
  clusterContextValue,
  clusterCountDescription,
  clusterFilesForKey,
  loadClustersContract,
  parseClustersContract,
  resolveClusterModel,
  sanitizeBranchForFilename,
} from "./clusters";
import type { Git } from "./git";
import { FileReviewStatus, ReviewFile } from "./model";
import type { Triage } from "./triage";

const file = (path: string, triage: Triage = "normal"): ReviewFile => ({
  path,
  status: FileReviewStatus.NeedsReview,
  deleted: false,
  existsInMergeBase: true,
  diffBaseIsReviewedSnapshot: false,
  diffBaseSha: undefined,
  triage,
});

const reviewedFile = (path: string, triage: Triage = "normal"): ReviewFile => ({
  ...file(path, triage),
  status: FileReviewStatus.Reviewed,
});

const contract = (
  clusters: ClustersContract["clusters"],
): ClustersContract => ({ version: 1, clusters });

describe("sanitizeBranchForFilename", () => {
  it("replaces slashes", () => {
    expect(sanitizeBranchForFilename("feature/foo")).toBe("feature-foo");
  });

  it("keeps letters, digits, dot, underscore, and hyphen", () => {
    expect(sanitizeBranchForFilename("release-1.2_rc")).toBe("release-1.2_rc");
  });

  it("replaces spaces and unicode characters", () => {
    expect(sanitizeBranchForFilename("wip héllo world")).toBe(
      "wip-h-llo-world",
    );
  });

  it("replaces every disallowed char independently", () => {
    expect(sanitizeBranchForFilename("a/b\\c:d*e")).toBe("a-b-c-d-e");
  });
});

describe("parseClustersContract", () => {
  const validText = JSON.stringify({
    version: 1,
    clusters: [{ label: "API", summary: "API changes", files: ["src/api.ts"] }],
  });

  it("accepts a valid version-1 contract", () => {
    const result = parseClustersContract(validText);
    expect(result).toEqual({
      ok: true,
      contract: contract([
        {
          label: "API",
          summary: "API changes",
          files: ["src/api.ts"],
          patterns: [],
        },
      ]),
    });
  });

  it("normalizes absent files/patterns to empty arrays", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [
          { label: "Tests", summary: "s", patterns: ["**/*.test.ts"] },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      contract: contract([
        { label: "Tests", summary: "s", files: [], patterns: ["**/*.test.ts"] },
      ]),
    });
  });

  it("ignores unknown extra keys", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        generatedBy: "skill",
        clusters: [
          { label: "A", summary: "s", files: ["a.ts"], priority: "high" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const result = parseClustersContract("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not valid JSON");
    }
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["string", '"hi"'],
  ])("rejects a non-object top level (%s)", (_name, text) => {
    expect(parseClustersContract(text)).toEqual({
      ok: false,
      error: "top level must be an object",
    });
  });

  it("rejects a missing version", () => {
    const result = parseClustersContract(JSON.stringify({ clusters: [] }));
    expect(result).toEqual({
      ok: false,
      error: 'missing "version" (extension supports 1)',
    });
  });

  it.each([
    [0, "unsupported version 0 (extension supports 1)"],
    [2, "unsupported version 2 (extension supports 1)"],
    ["1", 'unsupported version "1" (extension supports 1)'],
  ])("rejects version %j", (version, error) => {
    const result = parseClustersContract(
      JSON.stringify({ version, clusters: [] }),
    );
    expect(result).toEqual({ ok: false, error });
  });

  it("rejects non-array clusters", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 1, clusters: {} }),
    );
    expect(result).toEqual({ ok: false, error: '"clusters" must be an array' });
  });

  it("rejects a non-object cluster entry", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 1, clusters: ["nope"] }),
    );
    expect(result).toEqual({ ok: false, error: "cluster 1 must be an object" });
  });

  it("rejects a cluster with a missing label", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [{ summary: "s", files: ["a"] }],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'cluster 1: "label" must be a string',
    });
  });

  it("rejects a cluster with a missing summary", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 1, clusters: [{ label: "A", files: ["a"] }] }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'cluster 1 ("A"): "summary" must be a string',
    });
  });

  it("rejects a cluster with empty files and patterns", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [
          { label: "A", summary: "s", files: ["a"] },
          { label: "B", summary: "s", files: [], patterns: [] },
        ],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error:
        'cluster 2 ("B"): needs at least one of "files" or "patterns" (non-empty)',
    });
  });

  it("rejects a cluster with neither files nor patterns", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 1, clusters: [{ label: "A", summary: "s" }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects non-array files", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [{ label: "A", summary: "s", files: "a.ts" }],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'cluster 1 ("A"): "files" must be an array of strings',
    });
  });

  it("rejects files containing non-strings", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [{ label: "A", summary: "s", files: ["a.ts", 3] }],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects non-array patterns", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [{ label: "A", summary: "s", patterns: { glob: "**" } }],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'cluster 1 ("A"): "patterns" must be an array of strings',
    });
  });

  it("accepts an empty clusters array", () => {
    expect(
      parseClustersContract(JSON.stringify({ version: 1, clusters: [] })),
    ).toEqual({ ok: true, contract: contract([]) });
  });
});

describe("resolveClusterModel", () => {
  it("assigns files by explicit listing and patterns, in contract order", () => {
    const api = file("src/api.ts");
    const apiTest = file("src/api.test.ts");
    const readme = file("README.md");
    const model = resolveClusterModel(
      contract([
        { label: "API", summary: "s", files: ["src/api.ts"], patterns: [] },
        { label: "Tests", summary: "s", files: [], patterns: ["**/*.test.ts"] },
      ]),
      [readme, api, apiTest],
    );
    expect(model.clusters[0].files).toEqual([api]);
    expect(model.clusters[1].files).toEqual([apiTest]);
    expect(model.unclustered).toEqual([readme]);
    expect(model.auto).toEqual([]);
  });

  it("lets an explicit listing beat an earlier cluster's pattern match", () => {
    const api = file("src/api.ts");
    const model = resolveClusterModel(
      contract([
        { label: "Src", summary: "s", files: [], patterns: ["src/**"] },
        { label: "API", summary: "s", files: ["src/api.ts"], patterns: [] },
      ]),
      [api],
    );
    expect(model.clusters[0].files).toEqual([]);
    expect(model.clusters[1].files).toEqual([api]);
  });

  it("gives a file explicitly listed by several clusters to the first", () => {
    const api = file("src/api.ts");
    const model = resolveClusterModel(
      contract([
        { label: "A", summary: "s", files: ["src/api.ts"], patterns: [] },
        { label: "B", summary: "s", files: ["src/api.ts"], patterns: [] },
      ]),
      [api],
    );
    expect(model.clusters[0].files).toEqual([api]);
    expect(model.clusters[1].files).toEqual([]);
  });

  it("gives a pattern-matched file to the first matching cluster", () => {
    const util = file("src/util.ts");
    const model = resolveClusterModel(
      contract([
        { label: "A", summary: "s", files: [], patterns: ["src/**"] },
        { label: "B", summary: "s", files: [], patterns: ["**/*.ts"] },
      ]),
      [util],
    );
    expect(model.clusters[0].files).toEqual([util]);
    expect(model.clusters[1].files).toEqual([]);
  });

  it("sends auto-triaged files to the auto bucket even when explicitly listed", () => {
    const lock = file("yarn.lock", "auto");
    const gen = file("gen/out.js", "auto");
    const model = resolveClusterModel(
      contract([
        {
          label: "Deps",
          summary: "s",
          files: ["yarn.lock"],
          patterns: ["gen/**"],
        },
      ]),
      [gen, lock],
    );
    expect(model.auto).toEqual([gen, lock]);
    expect(model.clusters[0].files).toEqual([]);
    expect(model.unclustered).toEqual([]);
  });

  it("sends unmatched auto files to the auto bucket, not unclustered", () => {
    const lock = file("yarn.lock", "auto");
    const model = resolveClusterModel(contract([]), [lock]);
    expect(model.auto).toEqual([lock]);
    expect(model.unclustered).toEqual([]);
  });

  it("puts everything in unclustered/auto for an empty clusters array", () => {
    const a = file("a.ts");
    const b = file("b.lock", "auto");
    const model = resolveClusterModel(contract([]), [a, b]);
    expect(model.clusters).toEqual([]);
    expect(model.unclustered).toEqual([a]);
    expect(model.auto).toEqual([b]);
  });

  it("ignores contract files absent from the review set, leaving the cluster empty", () => {
    const other = file("other.ts");
    const model = resolveClusterModel(
      contract([
        { label: "Ghost", summary: "s", files: ["gone.ts"], patterns: [] },
      ]),
      [other],
    );
    expect(model.clusters[0]).toEqual({
      label: "Ghost",
      summary: "s",
      files: [],
    });
    expect(model.unclustered).toEqual([other]);
  });

  it("preserves the review set's order within each bucket", () => {
    const files = [file("a.ts"), file("m.ts"), file("z.ts"), file("zz.md")];
    const model = resolveClusterModel(
      contract([
        { label: "TS", summary: "s", files: [], patterns: ["**/*.ts"] },
      ]),
      files,
    );
    expect(model.clusters[0].files.map((f) => f.path)).toEqual([
      "a.ts",
      "m.ts",
      "z.ts",
    ]);
    expect(model.unclustered.map((f) => f.path)).toEqual(["zz.md"]);
  });

  it("keeps ReviewFile objects by reference", () => {
    const a = file("a.ts");
    const model = resolveClusterModel(
      contract([{ label: "A", summary: "s", files: ["a.ts"], patterns: [] }]),
      [a],
    );
    expect(model.clusters[0].files[0]).toBe(a);
  });

  it("matches dotfiles and skips uncompilable patterns", () => {
    const dotfile = file(".config/settings.json");
    const model = resolveClusterModel(
      contract([
        {
          label: "Config",
          summary: "s",
          files: [],
          patterns: ["", "a".repeat(70000), ".config/**"],
        },
      ]),
      [dotfile],
    );
    expect(model.clusters[0].files).toEqual([dotfile]);
  });
});

describe("clusterFilesForKey / clusterBucketForKey", () => {
  const model: ClusterModel = {
    clusters: [
      { label: "First", summary: "one", files: [file("a.ts")] },
      { label: "Second", summary: "two", files: [file("b.ts"), file("c.ts")] },
    ],
    unclustered: [file("u.ts")],
    auto: [file("yarn.lock", "auto")],
  };

  it("resolves index-based keys to their bucket's files", () => {
    expect(clusterFilesForKey(model, "c0").map((f) => f.path)).toEqual([
      "a.ts",
    ]);
    expect(clusterFilesForKey(model, "c1").map((f) => f.path)).toEqual([
      "b.ts",
      "c.ts",
    ]);
  });

  it("resolves the synthetic unclustered and auto keys", () => {
    expect(clusterFilesForKey(model, "unclustered").map((f) => f.path)).toEqual(
      ["u.ts"],
    );
    expect(clusterFilesForKey(model, "auto").map((f) => f.path)).toEqual([
      "yarn.lock",
    ]);
  });

  it("returns empty for out-of-range and malformed keys", () => {
    expect(clusterFilesForKey(model, "c9")).toEqual([]);
    expect(clusterFilesForKey(model, "c-1")).toEqual([]);
    expect(clusterFilesForKey(model, "cx")).toEqual([]);
    expect(clusterFilesForKey(model, "")).toEqual([]);
  });

  it("returns the bucket only for real-cluster keys", () => {
    expect(clusterBucketForKey(model, "c1")?.label).toBe("Second");
    expect(clusterBucketForKey(model, "unclustered")).toBeUndefined();
    expect(clusterBucketForKey(model, "auto")).toBeUndefined();
    expect(clusterBucketForKey(model, "c9")).toBeUndefined();
  });
});

describe("clusterContextValue", () => {
  it("is clusterEmpty for no files", () => {
    expect(clusterContextValue([])).toBe("clusterEmpty");
  });

  it("is clusterNeedsReview when any file still needs review", () => {
    expect(clusterContextValue([reviewedFile("a.ts"), file("b.ts")])).toBe(
      "clusterNeedsReview",
    );
    expect(clusterContextValue([file("b.ts")])).toBe("clusterNeedsReview");
  });

  it("is clusterReviewed when every file is reviewed", () => {
    expect(
      clusterContextValue([reviewedFile("a.ts"), reviewedFile("b.ts")]),
    ).toBe("clusterReviewed");
  });
});

describe("clusterCountDescription", () => {
  it("always shows reviewed/total for clusters and Unclustered", () => {
    expect(clusterCountDescription([file("a.ts"), file("b.ts")], false)).toBe(
      "0/2",
    );
    expect(
      clusterCountDescription([reviewedFile("a.ts"), file("b.ts")], false),
    ).toBe("1/2");
    expect(clusterCountDescription([], false)).toBe("0/0");
  });

  it("shows a plain total for Auto until the first file is reviewed", () => {
    expect(
      clusterCountDescription(
        [file("a.lock", "auto"), file("b.lock", "auto")],
        true,
      ),
    ).toBe("2");
  });

  it("switches Auto to reviewed/total from the first reviewed file on", () => {
    expect(
      clusterCountDescription(
        [reviewedFile("a.lock", "auto"), file("b.lock", "auto")],
        true,
      ),
    ).toBe("1/2");
    expect(
      clusterCountDescription(
        [reviewedFile("a.lock", "auto"), reviewedFile("b.lock", "auto")],
        true,
      ),
    ).toBe("2/2");
  });
});

describe("loadClustersContract", () => {
  let repoRoot: string;

  const gitWithCommonDir = (commonDir: string): Git => ({
    repoRoot,
    run: (args) => {
      expect(args).toEqual(["rev-parse", "--git-common-dir"]);
      return Promise.resolve(`${commonDir}\n`);
    },
  });

  const writeContract = async (name: string, text: string): Promise<void> => {
    const dir = join(repoRoot, ".git", "delta-review");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), text);
  };

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "delta-review-clusters-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("returns missing when no contract file exists", async () => {
    expect(
      await loadClustersContract(gitWithCommonDir(".git"), "main"),
    ).toEqual({ state: "missing" });
  });

  it("loads a valid contract, resolving a relative common dir against repoRoot", async () => {
    await writeContract(
      "clusters-feature-x.json",
      JSON.stringify({
        version: 1,
        clusters: [{ label: "A", summary: "s", files: ["a.ts"] }],
      }),
    );
    const result = await loadClustersContract(
      gitWithCommonDir(".git"),
      "feature/x",
    );
    expect(result).toEqual({
      state: "ok",
      contract: contract([
        { label: "A", summary: "s", files: ["a.ts"], patterns: [] },
      ]),
    });
  });

  it("uses an absolute common dir as-is (linked worktree)", async () => {
    await writeContract(
      "clusters-main.json",
      JSON.stringify({ version: 1, clusters: [] }),
    );
    const result = await loadClustersContract(
      gitWithCommonDir(join(repoRoot, ".git")),
      "main",
    );
    expect(result).toEqual({ state: "ok", contract: contract([]) });
  });

  it("returns invalid with the parse error for a bad contract", async () => {
    await writeContract(
      "clusters-main.json",
      JSON.stringify({ version: 2, clusters: [] }),
    );
    const result = await loadClustersContract(gitWithCommonDir(".git"), "main");
    expect(result).toEqual({
      state: "invalid",
      error: "unsupported version 2 (extension supports 1)",
    });
  });

  it("returns invalid for a non-ENOENT read error", async () => {
    // Make the contract path a directory so readFile fails with EISDIR
    await mkdir(join(repoRoot, ".git", "delta-review", "clusters-main.json"), {
      recursive: true,
    });
    const result = await loadClustersContract(gitWithCommonDir(".git"), "main");
    expect(result.state).toBe("invalid");
  });
});
