import * as vscode from "vscode";
import { ReviewFile } from "./model";

// Tree rows use this scheme so the decorations below apply only to the Delta
// Review view and never repaint the Explorer or other file lists
export const REVIEW_ITEM_SCHEME = "delta-review-item";

type ChangeKind = "modified" | "added" | "deleted" | "renamed";

const changeKindFor = (file: ReviewFile): ChangeKind =>
  file.deleted
    ? "deleted"
    : file.movedFrom !== undefined
      ? "renamed"
      : file.existsInMergeBase
        ? "modified"
        : "added";

// The change kind travels in the URI query so the decoration provider can
// answer from the URI alone
export const createReviewItemUri = (file: ReviewFile): vscode.Uri =>
  vscode.Uri.from({
    scheme: REVIEW_ITEM_SCHEME,
    path: `/${file.path}`,
    query: changeKindFor(file),
  });

// Folder rows carry no decoration (no query -> provider returns undefined),
// matching the badge-less folders of the CHANGES tree
export const createReviewFolderUri = (path: string): vscode.Uri =>
  vscode.Uri.from({ scheme: REVIEW_ITEM_SCHEME, path: `/${path}` });

// The Unclustered header sets both a label and this resourceUri: the label
// wins for display while the decoration's ThemeColor still tints it, giving
// the warning-colored header without touching its children
const UNCLUSTERED_HEADER_QUERY = "unclustered-header";

export const createUnclusteredHeaderUri = (): vscode.Uri =>
  vscode.Uri.from({
    scheme: REVIEW_ITEM_SCHEME,
    path: "/unclustered-header",
    query: UNCLUSTERED_HEADER_QUERY,
  });

// No badge: the warning color alone marks the header (the M/A/D letters are
// for file rows)
const UNCLUSTERED_HEADER_DECORATION = new vscode.FileDecoration(
  undefined,
  "Files not claimed by any cluster",
  new vscode.ThemeColor("list.warningForeground"),
);

// Same letters and theme colors as the built-in CHANGES view, but relative to
// the merge base rather than to HEAD
const DECORATIONS: Record<ChangeKind, vscode.FileDecoration> = {
  modified: new vscode.FileDecoration(
    "M",
    "Modified since merge base",
    new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
  ),
  added: new vscode.FileDecoration(
    "A",
    "Added since merge base",
    new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
  ),
  deleted: new vscode.FileDecoration(
    "D",
    "Deleted from the working tree",
    new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
  ),
  renamed: new vscode.FileDecoration(
    "R",
    "Moved since merge base",
    new vscode.ThemeColor("gitDecoration.renamedResourceForeground"),
  ),
};

export const createReviewDecorationProvider =
  (): vscode.FileDecorationProvider => ({
    provideFileDecoration: (uri) => {
      if (uri.scheme !== REVIEW_ITEM_SCHEME) {
        return undefined;
      }
      if (uri.query === UNCLUSTERED_HEADER_QUERY) {
        return UNCLUSTERED_HEADER_DECORATION;
      }
      return DECORATIONS[uri.query as ChangeKind];
    },
  });
