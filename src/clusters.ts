import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import picomatch from "picomatch";
import type { Git } from "./git";
import { FileReviewStatus, type ReviewFile } from "./model";

// The clusters contract: written by an external tool (e.g. a Claude Code
// skill) to <git common dir>/delta-review/clusters-<sanitized branch>.json.
// The extension only reads it — it never writes contract files.

export interface ClusterDefinition {
  label: string;
  summary: string;
  // Explicit repo-relative paths; membership here beats any pattern match
  files: string[];
  // picomatch globs, evaluated in cluster order for files not listed explicitly
  patterns: string[];
}

export interface ClustersContract {
  version: 1;
  clusters: ClusterDefinition[];
}

export interface ClusterBucket {
  label: string;
  summary: string;
  files: ReviewFile[];
}

export interface ClusterModel {
  // In contract order; a cluster whose members are all outside the review set
  // (or auto-triaged) is present but empty
  clusters: ClusterBucket[];
  unclustered: ReviewFile[];
  auto: ReviewFile[];
}

export type ParseClustersResult =
  { ok: true; contract: ClustersContract } | { ok: false; error: string };

export type LoadClustersResult =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  | { state: "ok"; contract: ClustersContract };

// Grouped tree rows reference cluster buckets by a stable string key rather
// than by captured file arrays, so every render re-resolves against the
// current ClusterModel. Real clusters are index-based ("c0", "c1", …) — two
// clusters with identical labels stay distinct — plus the two synthetic
// buckets "unclustered" and "auto".

// The bucket definition (label/summary/files) behind a real-cluster key, or
// undefined for synthetic/unknown keys and out-of-range indices.
export const clusterBucketForKey = (
  model: ClusterModel,
  clusterKey: string,
): ClusterBucket | undefined =>
  /^c\d+$/.test(clusterKey)
    ? model.clusters[Number(clusterKey.slice(1))]
    : undefined;

// The files behind any cluster key; unknown keys resolve to an empty list so
// stale elements degrade to no-ops rather than throwing.
export const clusterFilesForKey = (
  model: ClusterModel,
  clusterKey: string,
): ReviewFile[] => {
  if (clusterKey === "unclustered") {
    return model.unclustered;
  }
  if (clusterKey === "auto") {
    return model.auto;
  }
  return clusterBucketForKey(model, clusterKey)?.files ?? [];
};

// Context value for a cluster-kind tree row, driving which bulk action its
// row offers: ✓ while anything still needs review, − when all reviewed,
// nothing when the bucket is empty.
export type ClusterContextValue =
  "clusterNeedsReview" | "clusterReviewed" | "clusterEmpty";

export const clusterContextValue = (
  files: readonly ReviewFile[],
): ClusterContextValue => {
  if (files.length === 0) {
    return "clusterEmpty";
  }
  return files.some((file) => file.status === FileReviewStatus.NeedsReview)
    ? "clusterNeedsReview"
    : "clusterReviewed";
};

// Header count text. Clusters and Unclustered always show reviewed/total;
// the Auto bucket (plainUntilFirstReviewed) shows a plain total until the
// first file is reviewed, then reviewed/total from there on (including n/n).
export const clusterCountDescription = (
  files: readonly ReviewFile[],
  plainUntilFirstReviewed: boolean,
): string => {
  const reviewed = files.filter(
    (file) => file.status === FileReviewStatus.Reviewed,
  ).length;
  if (plainUntilFirstReviewed && reviewed === 0) {
    return String(files.length);
  }
  return `${reviewed}/${files.length}`;
};

// Branch names can contain characters that are unsafe in filenames (notably
// "/" in feature/x). Every char outside [A-Za-z0-9._-] becomes "-". The
// contract-writing skill must apply the identical rule.
export const sanitizeBranchForFilename = (branch: string): string =>
  branch.replace(/[^A-Za-z0-9._-]/g, "-");

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

// Validates one raw cluster entry; returns the normalized definition or a
// user-facing error string.
const parseCluster = (
  value: unknown,
  index: number,
): { cluster: ClusterDefinition } | { error: string } => {
  const where = `cluster ${index + 1}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: `${where} must be an object` };
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.label !== "string") {
    return { error: `${where}: "label" must be a string` };
  }
  const where2 = `${where} ("${entry.label}")`;
  if (typeof entry.summary !== "string") {
    return { error: `${where2}: "summary" must be a string` };
  }
  if (entry.files !== undefined && !isStringArray(entry.files)) {
    return { error: `${where2}: "files" must be an array of strings` };
  }
  if (entry.patterns !== undefined && !isStringArray(entry.patterns)) {
    return { error: `${where2}: "patterns" must be an array of strings` };
  }
  const files = entry.files ?? [];
  const patterns = entry.patterns ?? [];
  if (files.length === 0 && patterns.length === 0) {
    return {
      error: `${where2}: needs at least one of "files" or "patterns" (non-empty)`,
    };
  }
  return {
    cluster: { label: entry.label, summary: entry.summary, files, patterns },
  };
};

// Parses and validates contract text. Errors are one-line and user-facing.
// Unknown extra keys are ignored (forward-friendly within version 1).
export const parseClustersContract = (text: string): ParseClustersResult => {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "top level must be an object" };
  }
  const record = data as Record<string, unknown>;
  if (record.version === undefined) {
    return { ok: false, error: 'missing "version" (extension supports 1)' };
  }
  if (record.version !== 1) {
    return {
      ok: false,
      error: `unsupported version ${JSON.stringify(record.version)} (extension supports 1)`,
    };
  }
  if (!Array.isArray(record.clusters)) {
    return { ok: false, error: '"clusters" must be an array' };
  }
  const clusters: ClusterDefinition[] = [];
  for (let index = 0; index < record.clusters.length; index++) {
    const result = parseCluster(record.clusters[index], index);
    if ("error" in result) {
      return { ok: false, error: result.error };
    }
    clusters.push(result.cluster);
  }
  return { ok: true, contract: { version: 1, clusters } };
};

// Resolves review-set membership into cluster buckets. Rules, in order:
// auto-triaged files always go to the auto bucket (auto wins over
// everything); explicit `files` listings beat pattern matches, first listing
// cluster wins; otherwise the first cluster (contract order) whose patterns
// match wins; anything left is unclustered. Files named by the contract but
// absent from the review set are simply not shown. Input order (path-sorted
// from the model) is preserved within each bucket, and ReviewFile objects are
// kept by reference.
export const resolveClusterModel = (
  contract: ClustersContract,
  files: ReviewFile[],
): ClusterModel => {
  const explicit = new Map<string, number>();
  contract.clusters.forEach((cluster, index) => {
    for (const path of cluster.files) {
      if (!explicit.has(path)) {
        explicit.set(path, index);
      }
    }
  });
  // One matcher per cluster. The contract is externally written, so guard
  // pattern compilation the same way triage.ts guards user-typed globs.
  const matchers = contract.clusters.map((cluster) => {
    const compiled: ((path: string) => boolean)[] = [];
    for (const pattern of cluster.patterns) {
      if (pattern === "") {
        continue;
      }
      try {
        compiled.push(picomatch(pattern, { dot: true }));
      } catch {
        // Uncompilable pattern — ignore it rather than break resolution
      }
    }
    return (path: string) => compiled.some((matches) => matches(path));
  });

  const buckets: ClusterBucket[] = contract.clusters.map((cluster) => ({
    label: cluster.label,
    summary: cluster.summary,
    files: [],
  }));
  const unclustered: ReviewFile[] = [];
  const auto: ReviewFile[] = [];
  for (const file of files) {
    if (file.triage === "auto") {
      auto.push(file);
      continue;
    }
    const explicitIndex = explicit.get(file.path);
    if (explicitIndex !== undefined) {
      buckets[explicitIndex].files.push(file);
      continue;
    }
    const patternIndex = matchers.findIndex((matches) => matches(file.path));
    if (patternIndex !== -1) {
      buckets[patternIndex].files.push(file);
      continue;
    }
    unclustered.push(file);
  }
  return { clusters: buckets, unclustered, auto };
};

// Locates and reads the contract for the given branch. Uses the git common
// dir (not --git-dir) so the contract travels with the branch across linked
// worktrees, matching where review refs live. `--git-common-dir` returns a
// relative path (".git") from the main worktree, so resolve against repoRoot.
export const loadClustersContract = async (
  git: Git,
  branch: string,
): Promise<LoadClustersResult> => {
  const commonDirOutput = (
    await git.run(["rev-parse", "--git-common-dir"])
  ).trim();
  const commonDir = isAbsolute(commonDirOutput)
    ? commonDirOutput
    : join(git.repoRoot, commonDirOutput);
  const contractPath = join(
    commonDir,
    "delta-review",
    `clusters-${sanitizeBranchForFilename(branch)}.json`,
  );
  let text: string;
  try {
    text = await readFile(contractPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing" };
    }
    return {
      state: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const parsed = parseClustersContract(text);
  return parsed.ok
    ? { state: "ok", contract: parsed.contract }
    : { state: "invalid", error: parsed.error };
};
