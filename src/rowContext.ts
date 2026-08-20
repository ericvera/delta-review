import { FileReviewStatus, hasAnyReviewSnapshot, ReviewFile } from "./model";

// Context values for the tree's file, folder and Auto rows — the strings the
// `when` clauses in package.json match to decide which inline actions a row
// offers. They live here rather than in ./treeProvider so they stay unit
// testable: that module imports `vscode`, this one must not.
//
// Tokens are appended in a fixed order — status, then `Deleted`, then
// `Snapshot` — because the clauses mix prefix matches with exact ones:
// `needsReviewFileDeletedSnapshot` keeps the `Deleted` matches that hide Open
// File lining up, `needsReviewFileSnapshotDeleted` would not.
//
// `Snapshot` marks a scope holding review state its row cannot otherwise
// reach, so `−` can be offered there. Only needs-review rows carry it: a
// reviewed row always has a snapshot, and a variant there would break every
// `^reviewedFile` / `reviewedFolder` match.

export const fileContextValue = (file: ReviewFile): string => {
  const status =
    file.status === FileReviewStatus.NeedsReview
      ? "needsReviewFile"
      : "reviewedFile";
  const deleted = file.deleted ? "Deleted" : "";
  const snapshot =
    file.status === FileReviewStatus.NeedsReview && file.hasReviewSnapshot
      ? "Snapshot"
      : "";
  return `${status}${deleted}${snapshot}`;
};

// `files` is the folder's rendered scope — the files shown under it, already
// narrowed to the status its container renders
export const folderContextValue = (
  files: readonly ReviewFile[],
  reviewedScope: boolean,
): string => {
  if (reviewedScope) {
    return "reviewedFolder";
  }
  return hasAnyReviewSnapshot(files)
    ? "needsReviewFolderSnapshot"
    : "needsReviewFolder";
};

export const autoGroupContextValue = (
  files: readonly ReviewFile[],
  status: FileReviewStatus,
): string => {
  if (status === FileReviewStatus.Reviewed) {
    return "reviewedAutoGroup";
  }
  return hasAnyReviewSnapshot(files)
    ? "needsReviewAutoGroupSnapshot"
    : "needsReviewAutoGroup";
};
