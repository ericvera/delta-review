import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MoveDeclaration } from "./clusters";
import {
  Git,
  parseLsTreeOutput,
  parseNameStatusOutput,
  splitNulTerminated,
} from "./git";
import { DELETED_SENTINEL_CONTENT, readReviewState } from "./reviewState";
import { computeTriage, Triage } from "./triage";

export enum FileReviewStatus {
  NeedsReview = "needs-review",
  Reviewed = "reviewed",
}

// Where a moved file came from: elsewhere in this repository (git-detected
// rename or a declaration) or another project entirely (declaration only)
export type MoveOrigin = "repo" | "external";

// How a move's working-tree content compares to its origin base
export type MoveClassification = "verbatim" | "adapted" | "unknown";

export interface ReviewFile {
  path: string;
  status: FileReviewStatus;
  // True when the file no longer exists in the working tree
  deleted: boolean;
  // False when the file did not exist at the merge base (added since)
  existsInMergeBase: boolean;
  // True when the diff base is the last-reviewed snapshot rather than the
  // merge base — i.e. the diff shows only the delta since the last review
  diffBaseIsReviewedSnapshot: boolean;
  // Blob sha for the left side of the diff; undefined renders as empty (new file)
  diffBaseSha: string | undefined;
  // Repo-relative path identifying the document the base side actually shows.
  // The origin path only when the base really is a repo origin's blob; the
  // file's own path otherwise — an external origin path never appears here
  diffBasePath: string;
  // Old path this file was moved from — detected by git or declared;
  // undefined when the file is not a move. Repo-relative for a repo origin;
  // for an external origin it is a donor-project path and may escape the repo
  movedFrom: string | undefined;
  // Origin kind of the move; undefined when the file is not a move
  moveOrigin?: MoveOrigin;
  // Donor project display name from an external declaration
  donor?: string;
  // The declaration's free-text note about the move
  moveNote?: string;
  // Content comparison against the origin base — never read from the
  // contract; undefined when the file is not a move
  moveClassification?: MoveClassification;
  // True when the diff falls back to an empty left side because the move's
  // origin base could not be resolved
  originContentUnavailable: boolean;
  // "auto" when the file is mechanical (matches an auto-review glob or is
  // linguist-generated); "normal" otherwise
  triage: Triage;
}

export interface ReviewModel {
  branch: string;
  mergeBase: string;
  files: ReviewFile[];
}

// Parses `git check-attr -z` output — a flat NUL-separated sequence of
// <path, attr, value> triplets — into the set of paths whose value is "set"
// or "true". The value field can be empty (a `attr=` assignment in
// .gitattributes emits `path NUL attr NUL NUL`), so empty fields must be
// kept when splitting or every subsequent triplet shifts by one.
export const parseCheckAttrOutput = (output: string): Set<string> => {
  const fields = output.split("\0");
  // Drop only the trailing empty field from the final NUL terminator
  if (fields[fields.length - 1] === "") {
    fields.pop();
  }
  const paths = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const value = fields[index + 2];
    if (value === "set" || value === "true") {
      paths.add(fields[index]);
    }
  }
  return paths;
};

// A move as resolved for one file: a declaration or a git-detected rename,
// after declaration precedence has been applied.
export interface ResolvedMove {
  from: string;
  origin: MoveOrigin;
  donor: string | undefined;
  // Declared object id of the origin's content — external origins only, and
  // not yet checked against the object database
  baseBlob: string | undefined;
  note: string | undefined;
}

export interface AdjustedReviewSet {
  // Path-sorted review set after the move adjustments
  paths: string[];
  // Every move that applies to a path in `paths`
  movesByPath: Map<string, ResolvedMove>;
}

// Applies move declarations to the raw review set git produced. Declarations
// take precedence over git's own rename detection for the same path, and a
// declaration for a path outside the review set is ignored silently.
//
// Adjustments run additions first, then removals, so a path that both
// re-enters the set and is named as another declaration's origin ends up
// suppressed rather than counted twice.
export const adjustReviewSetForMoves = (input: {
  // The review set as git computed it (tracked changes plus untracked files)
  paths: readonly string[];
  // Destination -> source for the renames git detected
  movedFromByPath: ReadonlyMap<string, string>;
  moves: readonly MoveDeclaration[];
  // Paths that have a blob at the merge base
  mergeBasePaths: ReadonlySet<string>;
  isDeletedFromWorkingTree: (path: string) => boolean;
}): AdjustedReviewSet => {
  // The set git computed decides which declarations apply at all, so it stays
  // fixed while `paths` below is adjusted
  const gitPaths = new Set(input.paths);
  const movesByPath = new Map<string, ResolvedMove>();
  for (const [path, from] of input.movedFromByPath) {
    // A detected rename is a repo-origin move, indistinguishable from a
    // declared one
    movesByPath.set(path, {
      from,
      origin: "repo",
      donor: undefined,
      baseBlob: undefined,
      note: undefined,
    });
  }

  const declared: MoveDeclaration[] = [];
  const paths = new Set(input.paths);
  for (const move of input.moves) {
    if (!gitPaths.has(move.path)) {
      continue;
    }
    declared.push(move);
    const detectedFrom = input.movedFromByPath.get(move.path);
    // The declaration displaces git's detection and names somewhere else, so
    // the detected source is a real deletion nobody has reviewed
    if (detectedFrom !== undefined && detectedFrom !== move.from) {
      paths.add(detectedFrom);
    }
    movesByPath.set(move.path, {
      from: move.from,
      origin: move.origin,
      donor: move.donor,
      baseBlob: move.baseBlob,
      note: move.note,
    });
  }

  for (const move of declared) {
    // An external origin never existed in this repository, so it can suppress
    // nothing; and when the destination existed at the merge base the origin's
    // content is shown nowhere, so its deletion must stay reviewable
    if (move.origin !== "repo" || input.mergeBasePaths.has(move.path)) {
      continue;
    }
    if (paths.has(move.from) && input.isDeletedFromWorkingTree(move.from)) {
      paths.delete(move.from);
    }
  }

  for (const path of movesByPath.keys()) {
    if (!paths.has(path)) {
      movesByPath.delete(path);
    }
  }
  return { paths: [...paths].sort(), movesByPath };
};

export interface FileBaseResolution {
  diffBaseSha: string | undefined;
  diffBasePath: string;
  moveClassification: MoveClassification | undefined;
  originContentUnavailable: boolean;
}

// Selects one file's diff base, the path identifying it, and — for a move —
// how its content compares to where it came from.
//
// Diff-base precedence: the reviewed snapshot, then the merge-base blob at
// the file's own path (an overwrite is still an edit to a file the reviewer
// already had), then the origin base. The classification is always computed
// against the origin base, even when the diff is shown against something else.
export const resolveFileBase = (input: {
  path: string;
  move: ResolvedMove | undefined;
  deleted: boolean;
  // Working-tree blob sha; undefined when the file is deleted
  workingSha: string | undefined;
  reviewedSha: string | undefined;
  useSnapshotBase: boolean;
  // Merge-base path -> blob sha
  mergeBaseBlobs: ReadonlyMap<string, string>;
  // File path -> the external origin blob, already checked to be readable
  externalBaseShaByPath: ReadonlyMap<string, string>;
}): FileBaseResolution => {
  const { move, path } = input;
  const originBaseSha =
    move === undefined
      ? undefined
      : move.origin === "repo"
        ? input.mergeBaseBlobs.get(move.from)
        : input.externalBaseShaByPath.get(path);
  const existsInMergeBase = input.mergeBaseBlobs.has(path);

  let diffBaseSha: string | undefined;
  let diffBasePath = path;
  if (input.useSnapshotBase) {
    diffBaseSha = input.reviewedSha;
  } else if (existsInMergeBase) {
    diffBaseSha = input.mergeBaseBlobs.get(path);
  } else {
    diffBaseSha = originBaseSha;
    // Only a repo origin's blob is a document of its own; an external origin
    // path is never a base-document identity
    if (move?.origin === "repo" && originBaseSha !== undefined) {
      diffBasePath = move.from;
    }
  }

  const moveClassification =
    move === undefined
      ? undefined
      : input.deleted || originBaseSha === undefined
        ? "unknown"
        : input.workingSha === originBaseSha
          ? "verbatim"
          : "adapted";

  return {
    diffBaseSha,
    diffBasePath,
    moveClassification,
    originContentUnavailable:
      move !== undefined &&
      originBaseSha === undefined &&
      !input.useSnapshotBase &&
      !existsInMergeBase,
  };
};

// Returns the set of paths marked `linguist-generated` in .gitattributes.
// Attribute lookup is best-effort: any failure yields an empty set rather
// than breaking the model.
const fetchGeneratedPaths = async (
  git: Git,
  paths: string[],
): Promise<Set<string>> => {
  if (paths.length === 0) {
    return new Set();
  }
  try {
    const output = await git.run(
      ["check-attr", "--stdin", "-z", "linguist-generated"],
      { stdin: paths.join("\0") },
    );
    return parseCheckAttrOutput(output);
  } catch {
    return new Set();
  }
};

// Checks each external origin's declared `baseBlob` against the object
// database and returns file path -> blob sha for the usable ones. An object
// that is missing, unreadable, or not a blob is simply left out: the file
// degrades to no origin base rather than failing the refresh.
const resolveExternalBaseBlobs = async (
  git: Git,
  movesByPath: ReadonlyMap<string, ResolvedMove>,
): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  for (const [path, move] of movesByPath) {
    if (move.origin !== "external" || move.baseBlob === undefined) {
      continue;
    }
    try {
      const type = (await git.run(["cat-file", "-t", move.baseBlob])).trim();
      if (type === "blob") {
        resolved.set(path, move.baseBlob);
      }
    } catch {
      // Unreadable or garbage-collected object — no origin base
    }
  }
  return resolved;
};

// The branch a review is scoped to: HEAD's short name. Exported so a caller
// that needs the branch before the model exists (to load the branch's
// contract, say) can resolve it once and hand it back in.
export const resolveBranch = async (git: Git): Promise<string> =>
  (await git.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

// Computes the review set: every file that differs between the merge base and
// the working tree (plus untracked files), with its review status derived by
// comparing working-tree content against the reviewed snapshot. Content that
// matches the snapshot is reviewed; anything else needs (re-)review.
export const computeReviewModel = async (
  git: Git,
  baseBranch: string,
  options?: {
    autoReviewGlobs?: string[];
    // Skips the HEAD lookup when the caller already resolved the branch
    branch?: string;
    moves?: MoveDeclaration[];
  },
): Promise<ReviewModel> => {
  const branch = options?.branch ?? (await resolveBranch(git));

  let mergeBase: string;
  try {
    mergeBase = (await git.run(["merge-base", baseBranch, "HEAD"])).trim();
  } catch {
    throw new Error(
      `Cannot compute merge-base with "${baseBranch}". Check the deltaReview.baseBranch setting.`,
    );
  }

  const trackedOutput = await git.run([
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    mergeBase,
  ]);
  const { paths: trackedPaths, movedFrom: movedFromByPath } =
    parseNameStatusOutput(trackedOutput);
  const untrackedOutput = await git.run([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const rawPaths = [
    ...new Set([...trackedPaths, ...splitNulTerminated(untrackedOutput)]),
  ].sort();

  // The merge-base blobs and working-tree existence both feed the move
  // adjustment, and the adjusted set is what every downstream surface —
  // starting with triage and the linguist-generated lookup — must see.
  const baseBlobs = parseLsTreeOutput(
    await git.run(["ls-tree", "-r", "-z", mergeBase]),
  );
  const isDeletedFromWorkingTree = (path: string): boolean =>
    !existsSync(join(git.repoRoot, path));
  const { paths, movesByPath } = adjustReviewSetForMoves({
    paths: rawPaths,
    movedFromByPath,
    moves: options?.moves ?? [],
    mergeBasePaths: new Set(baseBlobs.keys()),
    isDeletedFromWorkingTree,
  });

  const generatedPaths = await fetchGeneratedPaths(git, paths);
  const triageByPath = computeTriage(
    paths,
    options?.autoReviewGlobs ?? [],
    generatedPaths,
  );

  const reviewState = await readReviewState(git, branch);
  const externalBaseShaByPath = await resolveExternalBaseBlobs(
    git,
    movesByPath,
  );
  const sentinelSha = (
    await git.run(["hash-object", "--stdin"], {
      stdin: DELETED_SENTINEL_CONTENT,
    })
  ).trim();

  const existingPaths = paths.filter((path) => !isDeletedFromWorkingTree(path));
  const currentShaByPath = new Map<string, string>();
  if (existingPaths.length > 0) {
    const output = await git.run(["hash-object", "--stdin-paths"], {
      stdin: existingPaths.join("\n") + "\n",
    });
    const shas = output.trim().split("\n");
    existingPaths.forEach((path, index) =>
      currentShaByPath.set(path, shas[index]),
    );
  }

  const files = paths.map((path): ReviewFile => {
    const deleted = !currentShaByPath.has(path);
    const currentSha = currentShaByPath.get(path) ?? sentinelSha;
    const reviewedSha = reviewState.get(path);
    const reviewed = reviewedSha !== undefined && reviewedSha === currentSha;
    // A sentinel snapshot (file was deleted when reviewed) is not usable as a
    // diff base if the file has since been recreated — fall back to the merge base
    const snapshotUsable =
      reviewedSha !== undefined && reviewedSha !== sentinelSha;
    const useSnapshotBase = !reviewed && snapshotUsable;
    const move = movesByPath.get(path);
    const base = resolveFileBase({
      path,
      move,
      deleted,
      workingSha: currentShaByPath.get(path),
      reviewedSha,
      useSnapshotBase,
      mergeBaseBlobs: baseBlobs,
      externalBaseShaByPath,
    });
    return {
      path,
      status: reviewed
        ? FileReviewStatus.Reviewed
        : FileReviewStatus.NeedsReview,
      deleted,
      existsInMergeBase: baseBlobs.has(path),
      diffBaseIsReviewedSnapshot: useSnapshotBase,
      diffBaseSha: base.diffBaseSha,
      diffBasePath: base.diffBasePath,
      movedFrom: move?.from,
      moveOrigin: move?.origin,
      donor: move?.donor,
      moveNote: move?.note,
      moveClassification: base.moveClassification,
      originContentUnavailable: base.originContentUnavailable,
      triage: triageByPath.get(path) ?? "normal",
    };
  });

  return { branch, mergeBase, files };
};
