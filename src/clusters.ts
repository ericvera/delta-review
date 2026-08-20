import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import picomatch from "picomatch";
import type { Git } from "./git";
import {
  FileReviewStatus,
  hasAnyReviewSnapshot,
  type ReviewFile,
} from "./model";

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

// A file the writer moved into its current location, declared because git
// cannot see the move: it came from another repository, or was rewritten
// heavily enough that rename detection misses it.
export interface MoveDeclaration {
  path: string;
  from: string;
  origin: "repo" | "external";
  // Donor project name and the origin's blob id — external origins only
  donor?: string;
  baseBlob?: string;
  note?: string;
}

export interface ClustersContract {
  version: 1 | 2;
  clusters: ClusterDefinition[];
  // Always present; a version 1 contract normalizes to an empty list
  moves: MoveDeclaration[];
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

// Order-preserving filter of a file list down to one review status. Returns
// a new array; the ReviewFile objects are kept by reference, so callers keep
// the model's path-sorted order and object identity.
export const filterByStatus = (
  files: readonly ReviewFile[],
  status: FileReviewStatus,
): ReviewFile[] => files.filter((file) => file.status === status);

// What a real cluster's body should render in grouped mode: its needs-review
// rows, the dim "All files reviewed." message, or the empty-cluster message.
export type ClusterBodyState = "no-files" | "all-reviewed" | "has-needs-review";

export const clusterBodyState = (
  files: readonly ReviewFile[],
): ClusterBodyState => {
  if (files.length === 0) {
    return "no-files";
  }
  return files.some((file) => file.status === FileReviewStatus.NeedsReview)
    ? "has-needs-review"
    : "all-reviewed";
};

// Context value for a cluster-kind tree row, driving which bulk actions its
// row offers: ✓ while anything still needs review, − when the bucket holds a
// snapshot (all reviewed, or a member whose content diverged from its
// snapshot), nothing when the bucket is empty. Scope is the cluster's full
// membership, the same scope its counts and its bulk actions already use.
export type ClusterContextValue =
  | "clusterNeedsReview"
  | "clusterNeedsReviewSnapshot"
  | "clusterReviewed"
  | "clusterEmpty";

export const clusterContextValue = (
  files: readonly ReviewFile[],
): ClusterContextValue => {
  if (files.length === 0) {
    return "clusterEmpty";
  }
  if (files.some((file) => file.status === FileReviewStatus.NeedsReview)) {
    return hasAnyReviewSnapshot(files)
      ? "clusterNeedsReviewSnapshot"
      : "clusterNeedsReview";
  }
  return "clusterReviewed";
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

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isContractVersion = (
  value: unknown,
): value is ClustersContract["version"] => value === 1 || value === 2;

const isMoveOrigin = (value: unknown): value is MoveDeclaration["origin"] =>
  value === "repo" || value === "external";

// Anchored: the value reaches `git cat-file blob <value>`, so a leading "-"
// must never be accepted as it would be read as a command-line option.
const BASE_BLOB_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

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

// Validates one raw move entry; returns the normalized declaration, a
// user-facing error string, or `{ move: undefined }` for an entry that
// declares nothing and is dropped without failing the contract.
const parseMove = (
  value: unknown,
  index: number,
): { move: MoveDeclaration | undefined } | { error: string } => {
  const where = `move ${index + 1}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: `${where} must be an object` };
  }
  const entry = value as Record<string, unknown>;
  const isRepoOrigin = entry.origin === "repo";
  // donor/baseBlob are meaningless for a repo origin: drop them whatever
  // their type, so a harmless extra field never costs the reviewer their
  // clustering.
  const rawDonor = isRepoOrigin ? undefined : entry.donor;
  const rawBaseBlob = isRepoOrigin ? undefined : entry.baseBlob;
  // A repo move onto its own path declares nothing. Skip it before
  // validation and before dedup, so it can neither reject the contract nor
  // shadow a real declaration for the same path. Both keys must be non-empty
  // strings — two absent keys are a mangled entry and still get diagnosed.
  if (
    isRepoOrigin &&
    isNonEmptyString(entry.path) &&
    entry.from === entry.path
  ) {
    return { move: undefined };
  }
  if (!isNonEmptyString(entry.path)) {
    return { error: `${where}: "path" must be a non-empty string` };
  }
  const where2 = `${where} ("${entry.path}")`;
  if (!isNonEmptyString(entry.from)) {
    return { error: `${where2}: "from" must be a non-empty string` };
  }
  if (!isMoveOrigin(entry.origin)) {
    return { error: `${where2}: "origin" must be "repo" or "external"` };
  }
  let donor: string | undefined;
  if (rawDonor !== undefined) {
    if (!isNonEmptyString(rawDonor)) {
      return { error: `${where2}: "donor" must be a non-empty string` };
    }
    donor = rawDonor;
  }
  let baseBlob: string | undefined;
  if (rawBaseBlob !== undefined) {
    if (
      typeof rawBaseBlob !== "string" ||
      !BASE_BLOB_PATTERN.test(rawBaseBlob)
    ) {
      return {
        error: `${where2}: "baseBlob" must be a 40- or 64-character hex object id`,
      };
    }
    baseBlob = rawBaseBlob;
  }
  let note: string | undefined;
  if (entry.note !== undefined) {
    if (typeof entry.note !== "string") {
      return { error: `${where2}: "note" must be a string` };
    }
    note = entry.note;
  }
  return {
    move: {
      path: entry.path,
      from: entry.from,
      origin: entry.origin,
      donor,
      baseBlob,
      note,
    },
  };
};

// Parses and validates contract text. Errors are one-line and user-facing.
// Unknown extra keys are ignored (forward-friendly within a version).
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
  const version = record.version;
  if (version === undefined) {
    return {
      ok: false,
      error: 'missing "version" (extension supports 1 and 2)',
    };
  }
  if (!isContractVersion(version)) {
    return {
      ok: false,
      error: `unsupported version ${JSON.stringify(version)} (extension supports 1 and 2)`,
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
  // `moves` arrived in version 2; inside a version 1 contract it is just an
  // unknown extra key and stays ignored.
  const moves: MoveDeclaration[] = [];
  if (version === 2 && record.moves !== undefined) {
    if (!Array.isArray(record.moves)) {
      return { ok: false, error: '"moves" must be an array' };
    }
    const declared = new Set<string>();
    for (let index = 0; index < record.moves.length; index++) {
      const result = parseMove(record.moves[index], index);
      if ("error" in result) {
        return { ok: false, error: result.error };
      }
      // Later duplicates of a path lose to the first declaration, as
      // explicit cluster membership resolves.
      if (result.move === undefined || declared.has(result.move.path)) {
        continue;
      }
      declared.add(result.move.path);
      moves.push(result.move);
    }
  }
  return { ok: true, contract: { version, clusters, moves } };
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
