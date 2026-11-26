import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  baseFileName,
  clearBranchBase,
  containsArgs,
  createDetectionCache,
  DetectionCache,
  detectBase,
  isEligibleCandidate,
  isRefValid,
  listLocalBranches,
  parseAheadBehindLines,
  parseBaseFile,
  parseBranchReflog,
  pickDetectedBase,
  readBranchBase,
  resetDetectionCache,
  resolveDiffBase,
  writeBranchBase,
} from "./diffBase";
import { deltaReviewDirFor } from "./documents";
import { createGit, Git } from "./git";

const sha = (char: string): string => char.repeat(40);

describe("baseFileName", () => {
  it("sanitizes and strips a heads/ prefix", () => {
    expect(baseFileName("feat/x")).toBe("base-feat-x.json");
    expect(baseFileName("heads/feat/x")).toBe("base-feat-x.json");
  });
});

describe("parseBaseFile", () => {
  it("accepts the valid shape", () => {
    expect(
      parseBaseFile(
        JSON.stringify({ version: 1, branch: "feat/x", base: "main" }),
      ),
    ).toEqual({ ok: true, branch: "feat/x", base: "main" });
  });

  it.each([
    ["bad JSON", "{"],
    ["version 2", JSON.stringify({ version: 2, branch: "b", base: "main" })],
    ["empty base", JSON.stringify({ version: 1, branch: "b", base: "" })],
    ["non-string base", JSON.stringify({ version: 1, branch: "b", base: 3 })],
    ["missing branch", JSON.stringify({ version: 1, base: "main" })],
    ["empty branch", JSON.stringify({ version: 1, branch: "", base: "main" })],
  ])("rejects %s", (_label, text) => {
    const parsed = parseBaseFile(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.length).toBeGreaterThan(0);
    }
  });
});

describe("pickDetectedBase", () => {
  it("picks the smallest distance", () => {
    expect(
      pickDetectedBase(
        [
          { name: "a", distance: 3 },
          { name: "b", distance: 1 },
          { name: "main", distance: 2 },
        ],
        "main",
      ),
    ).toBe("b");
  });

  it("gives a tie to the fallback", () => {
    expect(
      pickDetectedBase(
        [
          { name: "a", distance: 1 },
          { name: "main", distance: 1 },
        ],
        "main",
        "a",
      ),
    ).toBe("main");
  });

  it("gives a tie between non-fallbacks to creationRef", () => {
    expect(
      pickDetectedBase(
        [
          { name: "a", distance: 1 },
          { name: "b", distance: 1 },
        ],
        "main",
        "b",
      ),
    ).toBe("b");
  });

  it("otherwise keeps the earlier one", () => {
    expect(
      pickDetectedBase(
        [
          { name: "a", distance: 1 },
          { name: "b", distance: 1 },
        ],
        "main",
      ),
    ).toBe("a");
    expect(pickDetectedBase([], "main")).toBeUndefined();
  });
});

describe("parseBranchReflog", () => {
  const head = sha("h");

  it("reads creationRef from the oldest line", () => {
    expect(
      parseBranchReflog(
        `${sha("c")} commit: x\n${sha("a")} branch: Created from feat/a\n`,
        head,
      ).creationRef,
    ).toBe("feat/a");
    expect(
      parseBranchReflog(
        `${sha("a")} branch: Created from refs/heads/feat/a\n`,
        head,
      ).creationRef,
    ).toBe("feat/a");
    expect(
      parseBranchReflog(`${sha("a")} branch: Created from HEAD\n`, head)
        .creationRef,
    ).toBeUndefined();
    expect(
      parseBranchReflog(
        `${sha("a")} Branch: renamed refs/heads/a to refs/heads/b\n`,
        head,
      ).creationRef,
    ).toBeUndefined();
  });

  it("flags unmoved only for a lone creation entry at HEAD", () => {
    expect(
      parseBranchReflog(`${head} branch: Created from HEAD\n`, head).unmoved,
    ).toBe(true);
    expect(
      parseBranchReflog(`${sha("a")} branch: Created from HEAD\n`, head)
        .unmoved,
    ).toBe(false);
    expect(
      parseBranchReflog(
        `${head} commit: x\n${sha("a")} branch: Created from main\n`,
        head,
      ).unmoved,
    ).toBe(false);
  });

  it("collects own commits newest first", () => {
    const output = [
      `${sha("1")} commit: one`,
      `${sha("2")} commit (amend): two`,
      `${sha("3")} cherry-pick: three`,
      `${sha("4")} rebase (finish): refs/heads/feat/b onto ${sha("9")}`,
      `${sha("5")} merge feat/x: Merge made by the 'ort' strategy.`,
      `${sha("6")} merge feat/x: Fast-forward`,
      `${sha("7")} reset: moving to HEAD~1`,
      `${sha("8")} branch: Created from main`,
    ].join("\n");
    expect([...parseBranchReflog(output, head).ownCommits]).toEqual([
      sha("1"),
      sha("2"),
      sha("3"),
      sha("4"),
      sha("5"),
    ]);
  });

  it("excludes a rebase finish that only fast-forwarded", () => {
    const s = sha("5");
    const t = sha("6");
    const output = [
      `${t} rebase (finish): refs/heads/feat/b onto ${s}`,
      `${s} rebase (finish): refs/heads/feat/b onto ${s}`,
      `${s} pull --rebase (finish): refs/heads/feat/b onto ${s}`,
      `${sha("8")} branch: Created from main`,
    ].join("\n");
    expect([...parseBranchReflog(output, head).ownCommits]).toEqual([t]);
  });

  it("gives nothing for empty output", () => {
    expect(parseBranchReflog("", head)).toEqual({
      creationRef: undefined,
      unmoved: false,
      ownCommits: new Set(),
    });
  });
});

describe("isEligibleCandidate", () => {
  const moved = { unmoved: false, ownCommits: new Set<string>() };
  const unmoved = { unmoved: true, ownCommits: new Set<string>() };
  const none = new Set<string>();

  it("skips a candidate with no common history", () => {
    expect(
      isEligibleCandidate(
        { name: "a", ahead: 2, behind: 5 },
        5,
        moved,
        none,
        "main",
      ),
    ).toBe(false);
  });

  it("skips the same tip on a moved branch", () => {
    expect(
      isEligibleCandidate(
        { name: "a", ahead: 0, behind: 0 },
        5,
        moved,
        none,
        "main",
      ),
    ).toBe(false);
  });

  it("keeps the same tip and a descendant on an unmoved branch", () => {
    expect(
      isEligibleCandidate(
        { name: "a", ahead: 0, behind: 0 },
        5,
        unmoved,
        none,
        "main",
      ),
    ).toBe(true);
    expect(
      isEligibleCandidate(
        { name: "a", ahead: 2, behind: 0 },
        5,
        unmoved,
        none,
        "main",
      ),
    ).toBe(true);
  });

  it("skips a containing branch unless it is the fallback", () => {
    const containing = new Set(["a", "main"]);
    expect(
      isEligibleCandidate(
        { name: "a", ahead: 0, behind: 1 },
        5,
        moved,
        containing,
        "main",
      ),
    ).toBe(false);
    expect(
      isEligibleCandidate(
        { name: "main", ahead: 1, behind: 1 },
        5,
        moved,
        containing,
        "main",
      ),
    ).toBe(true);
  });
});

describe("containsArgs", () => {
  it("caps at 32 in order", () => {
    const shas = Array.from({ length: 40 }, (_, index) =>
      index.toString(16).padStart(40, "0"),
    );
    expect(containsArgs(new Set(shas))).toEqual(
      shas.slice(0, 32).map((entry) => `--contains=${entry}`),
    );
    expect(containsArgs(new Set())).toEqual([]);
  });
});

describe("parseAheadBehindLines", () => {
  it("parses slashed names, drops the current branch and keeps order", () => {
    const output = [
      `zeta ${sha("1")} 0 3`,
      `feat/b ${sha("2")} 0 0`,
      `feat/a/x ${sha("3")} 2 1`,
      "",
    ].join("\n");
    expect(parseAheadBehindLines(output, "heads/feat/b")).toEqual([
      { name: "zeta", sha: sha("1"), ahead: 0, behind: 3 },
      { name: "feat/a/x", sha: sha("3"), ahead: 2, behind: 1 },
    ]);
  });
});

// Real temp repos: detection reads refs, reflogs and the graph, which a fake
// Git would not exercise.

let roots: string[] = [];
let repoRoot: string;
let git: Git;
let cache: DetectionCache;

const newRepo = async (): Promise<Git> => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "delta-review-base-")),
  );
  roots.push(root);
  const repo = createGit(root);
  await repo.run(["init", "-q", "-b", "main"]);
  await repo.run(["config", "user.email", "test@example.com"]);
  await repo.run(["config", "user.name", "Test"]);
  await repo.run(["config", "commit.gpgsign", "false"]);
  await repo.run(["config", "tag.gpgsign", "false"]);
  await repo.run(["commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
};

const commit = (repo: Git, message: string): Promise<string> =>
  repo.run(["commit", "-q", "--allow-empty", "-m", message]);

const run = (repo: Git, ...args: string[]): Promise<string> => repo.run(args);

const counting = (inner: Git): { git: Git; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    git: {
      repoRoot: inner.repoRoot,
      run: (args, options) => {
        calls.push(args);
        return inner.run(args, options);
      },
    },
  };
};

const legacyGit = (inner: Git): Git => ({
  repoRoot: inner.repoRoot,
  run: (args, options) =>
    args[0] === "for-each-ref" &&
    args.some((arg) => arg.includes("ahead-behind"))
      ? Promise.reject(new Error("fatal: unknown field name: ahead-behind"))
      : inner.run(args, options),
});

const detect = async (repo: Git, branch: string): Promise<string> => {
  const resolution = await resolveDiffBase(
    repo,
    branch,
    "main",
    createDetectionCache(),
  );
  return resolution.base;
};

// main → feat/a (a1) → feat/b (b1), checked out on feat/b
const stackOnA = async (repo: Git): Promise<void> => {
  await run(repo, "switch", "-q", "-c", "feat/a");
  await commit(repo, "a1");
  await run(repo, "switch", "-q", "-c", "feat/b");
  await commit(repo, "b1");
};

beforeEach(async () => {
  roots = [];
  git = await newRepo();
  repoRoot = git.repoRoot;
  cache = createDetectionCache();
});

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("contract file", () => {
  it("round-trips write, read and clear, shared with a linked worktree", async () => {
    await writeBranchBase(git, "feat/x", "main");
    expect(await readBranchBase(git, "feat/x")).toEqual({
      state: "ok",
      base: "main",
    });
    const text = await readFile(
      join(await deltaReviewDirFor(git), "base-feat-x.json"),
      "utf8",
    );
    expect(text).toBe(
      JSON.stringify({ version: 1, branch: "feat/x", base: "main" }, null, 2) +
        "\n",
    );

    const worktree = join(repoRoot, "..", `${repoRoot.split("/").pop()}-wt`);
    roots.push(worktree);
    await run(git, "worktree", "add", "-q", "-b", "feat/x", worktree);
    const linked = createGit(worktree);
    expect(await readBranchBase(linked, "feat/x")).toEqual({
      state: "ok",
      base: "main",
    });

    await clearBranchBase(linked, "feat/x");
    expect(await readBranchBase(git, "feat/x")).toEqual({ state: "missing" });
    await clearBranchBase(git, "feat/x");
  });

  it("reports an invalid file and clears it", async () => {
    await writeBranchBase(git, "feat/x", "main");
    const path = join(await deltaReviewDirFor(git), "base-feat-x.json");
    await writeFile(path, "{ nope");
    const read = await readBranchBase(git, "feat/x");
    expect(read.state).toBe("invalid");
    await run(git, "switch", "-q", "-c", "feat/x");
    const resolution = await resolveDiffBase(git, "feat/x", "main", cache);
    expect(resolution.fileError).toBeDefined();
    expect(resolution.source).not.toBe("explicit");
    await clearBranchBase(git, "feat/x");
    expect(await readBranchBase(git, "feat/x")).toEqual({ state: "missing" });
  });

  it("treats a colliding file of another branch as absent", async () => {
    await writeBranchBase(git, "feat/x", "main");
    await run(git, "switch", "-q", "-c", "feat-x");
    await commit(git, "x1");
    expect(await readBranchBase(git, "feat-x")).toEqual({ state: "missing" });
    const resolution = await resolveDiffBase(git, "feat-x", "main", cache);
    expect(resolution.fileError).toBeUndefined();
    expect(resolution.source).not.toBe("explicit");
    await clearBranchBase(git, "feat-x");
    expect(await readBranchBase(git, "feat/x")).toEqual({
      state: "ok",
      base: "main",
    });
  });

  it("validates refs", async () => {
    expect(await isRefValid(git, "main")).toBe(true);
    expect(await isRefValid(git, "nope")).toBe(false);
    expect(await isRefValid(git, "")).toBe(false);
  });
});

describe("heads/ prefix", () => {
  it("strips heads/ on the fallback branch", async () => {
    const resolution = await resolveDiffBase(git, "heads/main", "main", cache);
    expect(resolution.source).toBe("fallback");
    expect(resolution.branch).toBe("main");
  });

  it("detects, reads the reflog and writes under the stripped name", async () => {
    await stackOnA(git);
    await run(git, "tag", "feat/b");
    const plain = await resolveDiffBase(
      git,
      "feat/b",
      "main",
      createDetectionCache(),
    );
    const prefixed = await resolveDiffBase(
      git,
      "heads/feat/b",
      "main",
      createDetectionCache(),
    );
    expect(plain.base).toBe("feat/a");
    expect(prefixed).toEqual(plain);
    expect(prefixed.branch).toBe("feat/b");

    const calls = counting(git);
    await detectBase(calls.git, "heads/feat/b", "main", createDetectionCache());
    expect(calls.calls).toContainEqual([
      "reflog",
      "show",
      "--format=%H %gs",
      "refs/heads/feat/b",
      "--",
    ]);

    await writeBranchBase(git, "heads/feat/b", "feat/a");
    const text = await readFile(
      join(await deltaReviewDirFor(git), "base-feat-b.json"),
      "utf8",
    );
    expect(JSON.parse(text).branch).toBe("feat/b");
  });

  it("detects a tag-shadowed candidate by its bare name", async () => {
    await run(git, "tag", "main");
    await run(git, "branch", "feat/a", "refs/heads/main");
    await run(git, "switch", "-q", "-c", "feat/b", "refs/heads/main");
    await commit(git, "b1");
    expect(await detect(git, "feat/b")).toBe("main");
  });

  it("lists tag-shadowed branches by their bare names", async () => {
    await run(git, "branch", "feat/a");
    await run(git, "tag", "feat/a");
    expect((await listLocalBranches(git)).sort()).toEqual(["feat/a", "main"]);
  });

  it("excludes a tag-shadowed current branch", async () => {
    await run(git, "switch", "-q", "-c", "feat/a");
    await commit(git, "a1");
    await run(git, "switch", "-q", "-c", "a/c");
    await run(git, "tag", "a/c");
    expect(await detect(git, "a/c")).toBe("feat/a");
  });
});

describe("detection", () => {
  it("detects the parent of a stacked branch", async () => {
    await stackOnA(git);
    const resolution = await resolveDiffBase(git, "feat/b", "main", cache);
    expect(resolution).toMatchObject({
      base: "feat/a",
      source: "detected",
      detectedVia: "forkPoint",
      stale: false,
      missing: false,
    });
    expect(resolution.suggestions).toEqual({
      forkPoint: "feat/a",
      upstream: undefined,
      fallback: "main",
    });
  });

  it("yields main once the parent is merged into it", async () => {
    await stackOnA(git);
    await run(git, "switch", "-q", "main");
    await run(git, "merge", "-q", "--no-ff", "-m", "merge a", "feat/a");
    await run(git, "switch", "-q", "feat/b");
    expect(await detect(git, "feat/b")).toBe("main");

    await writeBranchBase(git, "feat/b", "feat/a");
    const resolution = await resolveDiffBase(git, "feat/b", "main", cache);
    expect(resolution).toMatchObject({
      base: "feat/a",
      source: "explicit",
      stale: true,
    });
  });

  it("never flags an explicit tag base as stale", async () => {
    await run(git, "tag", "v1");
    await run(git, "switch", "-q", "-c", "feat/b");
    await commit(git, "b1");
    await run(git, "switch", "-q", "main");
    await commit(git, "m1");
    await run(git, "switch", "-q", "feat/b");
    await writeBranchBase(git, "feat/b", "v1");
    expect(await resolveDiffBase(git, "feat/b", "main", cache)).toMatchObject({
      source: "explicit",
      stale: false,
      missing: false,
    });
  });

  it("flags an explicit nonexistent ref as missing", async () => {
    await run(git, "switch", "-q", "-c", "feat/b");
    await writeBranchBase(git, "feat/b", "nope");
    expect(await resolveDiffBase(git, "feat/b", "main", cache)).toMatchObject({
      source: "explicit",
      missing: true,
      stale: false,
    });
  });

  describe("upstream", () => {
    let remote: string;

    beforeEach(async () => {
      remote = await realpath(
        await mkdtemp(join(tmpdir(), "delta-review-remote-")),
      );
      roots.push(remote);
      await run(createGit(remote), "init", "-q", "--bare");
      await run(git, "remote", "add", "origin", remote);
      await run(git, "push", "-q", "origin", "main");
      await run(git, "fetch", "-q", "origin");
    });

    it("uses the upstream when no local candidate remains", async () => {
      await run(git, "switch", "-q", "-c", "feat/x");
      await commit(git, "x1");
      await run(git, "branch", "-q", "-u", "origin/main");
      await run(git, "branch", "-D", "main");
      const resolution = await resolveDiffBase(git, "feat/x", "main", cache);
      expect(resolution).toMatchObject({
        base: "origin/main",
        source: "detected",
        detectedVia: "upstream",
        stale: false,
      });
    });

    it("never flags an upstream base that is an ancestor of main", async () => {
      await run(git, "switch", "-q", "-c", "feat/x");
      await commit(git, "x1");
      await run(git, "branch", "-q", "-u", "origin/main");
      await run(git, "branch", "-f", "main", "feat/x");
      const resolution = await resolveDiffBase(git, "feat/x", "main", cache);
      expect(resolution).toMatchObject({
        base: "origin/main",
        detectedVia: "upstream",
        stale: false,
      });
    });

    it("does not use an upstream of the same branch name", async () => {
      await run(git, "switch", "-q", "-c", "feat/x");
      await commit(git, "x1");
      await run(git, "push", "-q", "-u", "origin", "feat/x");
      await run(git, "branch", "-D", "main");
      const detection = await detectBase(git, "feat/x", "main", cache);
      expect(detection).toEqual({
        forkPoint: undefined,
        upstream: "origin/feat/x",
        upstreamEligible: false,
      });
      const resolution = await resolveDiffBase(git, "feat/x", "main", cache);
      expect(resolution.source).toBe("fallback");
      expect(resolution.suggestions.upstream).toBe("origin/feat/x");
    });
  });

  it("falls back with no candidate and no upstream", async () => {
    await run(git, "switch", "-q", "-c", "feat/x");
    await commit(git, "x1");
    await run(git, "branch", "-D", "main");
    expect(await resolveDiffBase(git, "feat/x", "main", cache)).toMatchObject({
      source: "fallback",
      base: "main",
    });
  });

  it("returns fallback for a detached HEAD", async () => {
    expect(await resolveDiffBase(git, "HEAD", "main", cache)).toMatchObject({
      source: "fallback",
      base: "main",
      branch: "HEAD",
    });
  });

  it("brand-new branches detect the parent they sit on", async () => {
    await run(git, "switch", "-q", "-c", "feat/a");
    await commit(git, "a1");
    await run(git, "checkout", "-q", "-b", "feat/c");
    expect(await detect(git, "feat/c")).toBe("feat/a");

    await run(git, "branch", "z", "feat/a");
    await run(git, "branch", "feat/d", "feat/a");
    await run(git, "checkout", "-q", "feat/d");
    expect(await detect(git, "feat/d")).toBe("feat/a");
  });

  it("flags an explicit parent only once it is merged off the first-parent chain", async () => {
    await run(git, "branch", "feat/e", "main");
    await commit(git, "m1");
    await run(git, "switch", "-q", "-c", "feat/f");
    await commit(git, "f1");
    await writeBranchBase(git, "feat/f", "feat/e");
    expect((await resolveDiffBase(git, "feat/f", "main", cache)).stale).toBe(
      false,
    );

    await run(git, "switch", "-q", "feat/e");
    await commit(git, "e1");
    await run(git, "switch", "-q", "main");
    await run(git, "merge", "-q", "--no-ff", "-m", "merge e", "feat/e");
    await run(git, "switch", "-q", "feat/f");
    expect((await resolveDiffBase(git, "feat/f", "main", cache)).stale).toBe(
      true,
    );
  });

  it("returns fallback on the fallback branch, explicit bases never stale", async () => {
    await run(git, "switch", "-q", "-c", "feat/a");
    await commit(git, "a1");
    await run(git, "switch", "-q", "-c", "feat/b", "main");
    await commit(git, "b1");
    await run(git, "switch", "-q", "main");
    await run(git, "merge", "-q", "--no-ff", "-m", "merge b", "feat/b");
    const calls = counting(git);
    expect(
      await resolveDiffBase(calls.git, "main", "main", cache),
    ).toMatchObject({ source: "fallback", base: "main", stale: false });
    expect(calls.calls.some((args) => args[0] === "for-each-ref")).toBe(false);

    await writeBranchBase(git, "main", "feat/b");
    expect(await resolveDiffBase(git, "main", "main", cache)).toMatchObject({
      source: "explicit",
      base: "feat/b",
      stale: false,
    });
  });
});

const scenarios: [string, (repo: Git) => Promise<[string, string]>][] = [
  [
    "fork point",
    async (repo) => {
      await stackOnA(repo);
      return ["feat/b", "feat/a"];
    },
  ],
  [
    "merged parent",
    async (repo) => {
      await stackOnA(repo);
      await run(repo, "switch", "-q", "main");
      await run(repo, "merge", "-q", "--no-ff", "-m", "merge a", "feat/a");
      await run(repo, "switch", "-q", "feat/b");
      return ["feat/b", "main"];
    },
  ],
  [
    "descendant",
    async (repo) => {
      await stackOnA(repo);
      await run(repo, "switch", "-q", "feat/a");
      return ["feat/a", "main"];
    },
  ],
  [
    "same tip (branch)",
    async (repo) => {
      await stackOnA(repo);
      await run(repo, "branch", "x");
      return ["feat/b", "feat/a"];
    },
  ],
  [
    "same tip (worktree)",
    async (repo) => {
      await stackOnA(repo);
      const dir = `${repo.repoRoot}-wt-y`;
      roots.push(dir);
      await run(repo, "worktree", "add", "-q", "-b", "y", dir);
      return ["feat/b", "feat/a"];
    },
  ],
  [
    "child",
    async (repo) => {
      await stackOnA(repo);
      await run(repo, "branch", "x");
      await commit(repo, "b2");
      return ["feat/b", "feat/a"];
    },
  ],
  [
    "stacked child (on parent)",
    async (repo) => {
      await run(repo, "switch", "-q", "-c", "feat/x");
      await commit(repo, "x1");
      await commit(repo, "x2");
      await run(repo, "switch", "-q", "-c", "feat/y");
      await commit(repo, "y1");
      await run(repo, "switch", "-q", "feat/x");
      await commit(repo, "x3");
      return ["feat/x", "main"];
    },
  ],
  [
    "stacked child (on child)",
    async (repo) => {
      await run(repo, "switch", "-q", "-c", "feat/x");
      await commit(repo, "x1");
      await commit(repo, "x2");
      await run(repo, "switch", "-q", "-c", "feat/y");
      await commit(repo, "y1");
      await run(repo, "switch", "-q", "feat/x");
      await commit(repo, "x3");
      await run(repo, "switch", "-q", "feat/y");
      return ["feat/y", "feat/x"];
    },
  ],
];

describe("detection scenarios", () => {
  it.each(scenarios)("%s on modern and older git", async (_label, setup) => {
    const [branch, expected] = await setup(git);
    expect(await detect(git, branch)).toBe(expected);
    expect(await detect(legacyGit(git), branch)).toBe(expected);
  });

  it("fast-forward rebase onto the parent detects the parent", async () => {
    await run(git, "switch", "-q", "-c", "feat/a");
    await commit(git, "a1");
    await run(git, "branch", "feat/b", "main");
    await run(git, "switch", "-q", "feat/b");
    await run(git, "rebase", "-q", "feat/a");
    await commit(git, "b1");
    expect(await detect(git, "feat/b")).toBe("feat/a");
  });

  it("keeps the fallback eligible after this branch merged into it", async () => {
    await run(git, "switch", "-q", "-c", "feat/a");
    await commit(git, "a1");
    await run(git, "switch", "-q", "-c", "feat/b", "main");
    await commit(git, "b1");
    await run(git, "switch", "-q", "main");
    await run(git, "merge", "-q", "--no-ff", "-m", "merge b", "feat/b");
    await run(git, "switch", "-q", "feat/b");
    await commit(git, "b2");
    expect(await detect(git, "feat/b")).toBe("main");
  });
});

describe("caching", () => {
  const detectionSpawn = (args: string[]): boolean =>
    args[0] === "for-each-ref" ||
    args[0] === "rev-list" ||
    args[0] === "reflog" ||
    args[0] === "merge-base" ||
    args.includes("@{upstream}");

  it("reuses the cache on an unchanged repo", async () => {
    await stackOnA(git);
    const calls = counting(git);
    await resolveDiffBase(calls.git, "feat/b", "main", cache);
    const first = calls.calls.length;
    await resolveDiffBase(calls.git, "feat/b", "main", cache);
    const second = calls.calls.length - first;
    expect(second).toBeLessThan(first);
    expect(calls.calls.slice(first).filter(detectionSpawn)).toEqual([
      [
        "for-each-ref",
        "--format=%(refname:lstrip=2) %(objectname) %(ahead-behind:HEAD)",
        "refs/heads",
      ],
      ["rev-parse", "--abbrev-ref", "@{upstream}"],
    ]);
  });

  const spawnsAfterCommit = async (
    repo: Git,
    extraBranches: number,
  ): Promise<string[][]> => {
    for (let index = 0; index < extraBranches; index++) {
      await run(repo, "branch", `b${index}`, "main");
    }
    await run(repo, "switch", "-q", "-c", "feat/a");
    await commit(repo, "a1");
    const local = createDetectionCache();
    await resolveDiffBase(repo, "feat/a", "main", local);
    await commit(repo, "a2");
    const calls = counting(repo);
    expect(
      await resolveDiffBase(calls.git, "feat/a", "main", local),
    ).toMatchObject({ base: "main" });
    return calls.calls;
  };

  it("adds no per-branch spawns as branches grow", async () => {
    const many = await spawnsAfterCommit(git, 5);
    const few = await spawnsAfterCommit(await newRepo(), 1);
    expect(many.length).toBe(few.length);
    expect(
      many.filter((args) => args.some((arg) => arg.startsWith("--contains="))),
    ).toHaveLength(1);
  });

  it("prunes and resets", async () => {
    await stackOnA(git);
    const legacy = legacyGit(git);
    await resolveDiffBase(legacy, "feat/b", "main", cache);
    expect(cache.perCandidate.size).toBe(2);
    await run(git, "branch", "-D", "main");
    await resolveDiffBase(legacy, "feat/b", "main", cache);
    expect(cache.perCandidate.size).toBe(1);
    resetDetectionCache(cache);
    expect(cache).toEqual(createDetectionCache());
  });

  it("older git caches per candidate and head", async () => {
    await stackOnA(git);
    const calls = counting(legacyGit(git));
    await detectBase(calls.git, "feat/b", "main", cache);
    const first = calls.calls.length;
    await detectBase(calls.git, "feat/b", "main", cache);
    expect(
      calls.calls.slice(first).some((args) => args[0] === "merge-base"),
    ).toBe(false);
  });
});
