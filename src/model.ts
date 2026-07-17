import { existsSync } from "node:fs";
import { join } from "node:path";
import { Git, parseLsTreeOutput, splitNulTerminated } from "./git";
import { DELETED_SENTINEL_CONTENT, readReviewState } from "./reviewState";
import { computeTriage, Triage } from "./triage";

export enum FileReviewStatus {
  NeedsReview = "needs-review",
  Reviewed = "reviewed",
}

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
  // "auto" when the file is mechanical (matches an auto-review glob or is
  // linguist-generated); "normal" otherwise
  triage: Triage;
}

export interface ReviewModel {
  branch: string;
  mergeBase: string;
  files: ReviewFile[];
}

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
    // -z output is a flat NUL-separated sequence of <path, attr, value> triplets
    const entries = splitNulTerminated(output);
    const generated = new Set<string>();
    for (let index = 0; index + 2 < entries.length; index += 3) {
      const value = entries[index + 2];
      if (value === "set" || value === "true") {
        generated.add(entries[index]);
      }
    }
    return generated;
  } catch {
    return new Set();
  }
};

// Computes the review set: every file that differs between the merge base and
// the working tree (plus untracked files), with its review status derived by
// comparing working-tree content against the reviewed snapshot. Content that
// matches the snapshot is reviewed; anything else needs (re-)review.
export const computeReviewModel = async (
  git: Git,
  baseBranch: string,
  options?: { autoReviewGlobs?: string[] },
): Promise<ReviewModel> => {
  const branch = (await git.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

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
    "--name-only",
    "--no-renames",
    "-z",
    mergeBase,
  ]);
  const untrackedOutput = await git.run([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const paths = [
    ...new Set([
      ...splitNulTerminated(trackedOutput),
      ...splitNulTerminated(untrackedOutput),
    ]),
  ].sort();

  const generatedPaths = await fetchGeneratedPaths(git, paths);
  const triageByPath = computeTriage(
    paths,
    options?.autoReviewGlobs ?? [],
    generatedPaths,
  );

  const reviewState = await readReviewState(git, branch);
  const baseBlobs = parseLsTreeOutput(
    await git.run(["ls-tree", "-r", "-z", mergeBase]),
  );
  const sentinelSha = (
    await git.run(["hash-object", "--stdin"], {
      stdin: DELETED_SENTINEL_CONTENT,
    })
  ).trim();

  const existingPaths = paths.filter((path) =>
    existsSync(join(git.repoRoot, path)),
  );
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
    return {
      path,
      status: reviewed
        ? FileReviewStatus.Reviewed
        : FileReviewStatus.NeedsReview,
      deleted,
      existsInMergeBase: baseBlobs.has(path),
      diffBaseIsReviewedSnapshot: useSnapshotBase,
      diffBaseSha: useSnapshotBase ? reviewedSha : baseBlobs.get(path),
      triage: triageByPath.get(path) ?? "normal",
    };
  });

  return { branch, mergeBase, files };
};
