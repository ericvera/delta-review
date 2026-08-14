import { stat } from "node:fs/promises";
import { join } from "node:path";

// The stat facts a cached hash is keyed on
export interface FileStat {
  size: number;
  mtimeMs: number;
}

export interface HashCacheEntry extends FileStat {
  sha: string;
}

// Stats every path concurrently, relative to the repo root. A path whose stat
// fails is simply absent from the result: it vanished between the caller's
// existence check and now, and hashing it would fail the whole batch.
export const statPaths = async (
  repoRoot: string,
  paths: readonly string[],
): Promise<Map<string, FileStat>> => {
  const stats = new Map<string, FileStat>();
  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(join(repoRoot, path));
        return { path, stat: { size: info.size, mtimeMs: info.mtimeMs } };
      } catch {
        return undefined;
      }
    }),
  );
  for (const result of results) {
    if (result !== undefined) {
      stats.set(result.path, result.stat);
    }
  }
  return stats;
};

// Splits stat'd paths into the ones whose content sha is already known and the
// ones that still have to be hashed. A cache entry counts only when both size
// and mtime match exactly — a same-size write inside one mtime tick can leave
// a stale sha, the same window git itself lives with; the next save's refresh
// heals it.
export const partitionByCache = (
  stats: ReadonlyMap<string, FileStat>,
  cache: ReadonlyMap<string, HashCacheEntry>,
): { cached: Map<string, string>; toHash: string[] } => {
  const cached = new Map<string, string>();
  const toHash: string[] = [];
  for (const [path, info] of stats) {
    const entry = cache.get(path);
    if (
      entry !== undefined &&
      entry.size === info.size &&
      entry.mtimeMs === info.mtimeMs
    ) {
      cached.set(path, entry.sha);
    } else {
      toHash.push(path);
    }
  }
  return { cached, toHash };
};

// Records freshly hashed content against the stats it was hashed at. A sha
// with no stat is dropped rather than cached against nothing.
export const updateCache = (
  cache: Map<string, HashCacheEntry>,
  stats: ReadonlyMap<string, FileStat>,
  hashed: ReadonlyMap<string, string>,
): void => {
  for (const [path, sha] of hashed) {
    const info = stats.get(path);
    if (info !== undefined) {
      cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha });
    }
  }
};
