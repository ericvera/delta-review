import * as vscode from "vscode";
import { ReviewFile } from "./model";

// Tree rows use this scheme so the decorations below apply only to the Delta
// Review view and never repaint the Explorer or other file lists
export const REVIEW_ITEM_SCHEME = "delta-review-item";

type ChangeKind = "modified" | "added" | "deleted";

const changeKindFor = (file: ReviewFile): ChangeKind =>
  file.deleted ? "deleted" : file.existsInMergeBase ? "modified" : "added";

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
};

export const createReviewDecorationProvider =
  (): vscode.FileDecorationProvider => ({
    provideFileDecoration: (uri) => {
      if (uri.scheme !== REVIEW_ITEM_SCHEME) {
        return undefined;
      }
      return DECORATIONS[uri.query as ChangeKind];
    },
  });
