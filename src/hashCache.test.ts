import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileStat,
  HashCacheEntry,
  partitionByCache,
  statPaths,
  updateCache,
} from "./hashCache";

const stats = (entries: [path: string, size: number, mtimeMs: number][]) =>
  new Map<string, FileStat>(
    entries.map(([path, size, mtimeMs]) => [path, { size, mtimeMs }]),
  );

const cacheOf = (
  entries: [path: string, size: number, mtimeMs: number, sha: string][],
) =>
  new Map<string, HashCacheEntry>(
    entries.map(([path, size, mtimeMs, sha]) => [path, { size, mtimeMs, sha }]),
  );

describe("partitionByCache", () => {
  it("hashes everything against an empty cache", () => {
    const result = partitionByCache(
      stats([
        ["src/a.ts", 10, 100.5],
        ["src/b.ts", 20, 200.5],
      ]),
      new Map(),
    );
    expect(result.cached).toEqual(new Map());
    expect(result.toHash).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("serves a path whose size and mtime both match", () => {
    const result = partitionByCache(
      stats([["src/a.ts", 10, 100.5]]),
      cacheOf([["src/a.ts", 10, 100.5, "sha-a"]]),
    );
    expect(result.cached).toEqual(new Map([["src/a.ts", "sha-a"]]));
    expect(result.toHash).toEqual([]);
  });

  it("re-hashes on a size change, an mtime change, or a missing entry", () => {
    const cache = cacheOf([
      ["src/size.ts", 10, 100.5, "sha-size"],
      ["src/mtime.ts", 10, 100.5, "sha-mtime"],
      ["src/same.ts", 10, 100.5, "sha-same"],
    ]);
    const result = partitionByCache(
      stats([
        ["src/size.ts", 11, 100.5],
        ["src/mtime.ts", 10, 100.75],
        ["src/same.ts", 10, 100.5],
        ["src/new.ts", 10, 100.5],
      ]),
      cache,
    );
    expect(result.toHash).toEqual([
      "src/size.ts",
      "src/mtime.ts",
      "src/new.ts",
    ]);
    expect(result.cached).toEqual(new Map([["src/same.ts", "sha-same"]]));
  });

  it("ignores a cached path that has no stat", () => {
    const result = partitionByCache(
      stats([]),
      cacheOf([["src/gone.ts", 10, 100.5, "sha-gone"]]),
    );
    expect(result.cached).toEqual(new Map());
    expect(result.toHash).toEqual([]);
  });

  it("compares the fractional part of mtime exactly", () => {
    const result = partitionByCache(
      stats([["src/a.ts", 10, 100.0001]]),
      cacheOf([["src/a.ts", 10, 100, "sha-a"]]),
    );
    expect(result.toHash).toEqual(["src/a.ts"]);
  });
});

describe("updateCache", () => {
  it("records each sha against the stat it was hashed at", () => {
    const cache = cacheOf([["src/a.ts", 1, 1, "stale"]]);
    updateCache(
      cache,
      stats([
        ["src/a.ts", 10, 100.5],
        ["src/b.ts", 20, 200.5],
      ]),
      new Map([
        ["src/a.ts", "sha-a"],
        ["src/b.ts", "sha-b"],
      ]),
    );
    expect(cache).toEqual(
      cacheOf([
        ["src/a.ts", 10, 100.5, "sha-a"],
        ["src/b.ts", 20, 200.5, "sha-b"],
      ]),
    );
  });

  it("drops a sha with no stat rather than caching it against nothing", () => {
    const cache = new Map<string, HashCacheEntry>();
    updateCache(cache, stats([]), new Map([["src/gone.ts", "sha-gone"]]));
    expect(cache.size).toBe(0);
  });

  it("leaves entries the pass did not hash untouched", () => {
    const cache = cacheOf([["src/other.ts", 5, 50, "sha-other"]]);
    updateCache(
      cache,
      stats([["src/a.ts", 10, 100.5]]),
      new Map([["src/a.ts", "sha-a"]]),
    );
    expect(cache.get("src/other.ts")).toEqual({
      size: 5,
      mtimeMs: 50,
      sha: "sha-other",
    });
  });
});

describe("cache round trip", () => {
  // One refresh: partition, hash the misses, write them back
  const refresh = (
    cache: Map<string, HashCacheEntry>,
    current: Map<string, FileStat>,
    contentShas: Record<string, string>,
  ): { shas: Map<string, string>; hashed: string[] } => {
    const { cached, toHash } = partitionByCache(current, cache);
    const hashed = new Map(toHash.map((path) => [path, contentShas[path]]));
    updateCache(cache, current, hashed);
    return { shas: new Map([...cached, ...hashed]), hashed: toHash };
  };

  it("hashes everything once, then only what changed", () => {
    const cache = new Map<string, HashCacheEntry>();
    const contentShas = {
      "src/a.ts": "sha-a",
      "src/b.ts": "sha-b",
      "src/c.ts": "sha-c",
    };
    const first = stats([
      ["src/a.ts", 10, 100],
      ["src/b.ts", 20, 200],
      ["src/c.ts", 30, 300],
    ]);
    const cold = refresh(cache, first, contentShas);
    expect(cold.hashed).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);

    const warm = refresh(cache, first, contentShas);
    expect(warm.hashed).toEqual([]);
    expect(warm.shas).toEqual(cold.shas);

    const touched = stats([
      ["src/a.ts", 10, 100],
      ["src/b.ts", 21, 250],
      ["src/c.ts", 30, 300],
    ]);
    const after = refresh(cache, touched, {
      ...contentShas,
      "src/b.ts": "sha-b2",
    });
    expect(after.hashed).toEqual(["src/b.ts"]);
    expect(after.shas.get("src/b.ts")).toBe("sha-b2");
    expect(after.shas.get("src/a.ts")).toBe("sha-a");
  });
});

describe("statPaths", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "delta-review-hash-cache-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("returns size and mtime for each existing path", async () => {
    await writeFile(join(repoRoot, "a.txt"), "hello");
    const result = await statPaths(repoRoot, ["a.txt"]);
    expect(result.get("a.txt")?.size).toBe(5);
    expect(typeof result.get("a.txt")?.mtimeMs).toBe("number");
  });

  it("omits a path that does not exist instead of throwing", async () => {
    await writeFile(join(repoRoot, "a.txt"), "hello");
    const result = await statPaths(repoRoot, ["a.txt", "gone.txt"]);
    expect([...result.keys()]).toEqual(["a.txt"]);
  });

  it("returns an empty map for no paths", async () => {
    expect(await statPaths(repoRoot, [])).toEqual(new Map());
  });
});
