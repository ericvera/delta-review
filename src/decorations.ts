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

export const WAIT_TOOLTIP = "Waiting on the agent: still expected to change.";

export const SOME_WAITING_TOOLTIP =
  "Some files are waiting on the agent: still expected to change.";

const DIM_QUERY = "dim";
const WAIT_SUFFIX = ",wait";
const DIM_SUFFIX = `,${DIM_QUERY}`;
export const DIM_COLOR = new vscode.ThemeColor(
  "gitDecoration.ignoredResourceForeground",
);

export type ReviewItemTone = "normal" | "waiting" | "dimmed";

// The change kind travels in the URI query so the decoration provider can
// answer from the URI alone
export const createReviewItemUri = (
  file: ReviewFile,
  tone: ReviewItemTone = "normal",
): vscode.Uri =>
  vscode.Uri.from({
    scheme: REVIEW_ITEM_SCHEME,
    path: `/${file.path}`,
    query:
      changeKindFor(file) +
      (tone === "waiting" ? WAIT_SUFFIX : tone === "dimmed" ? DIM_SUFFIX : ""),
  });

// Folder rows carry no decoration (no query -> provider returns undefined),
// matching the badge-less folders of the CHANGES tree, unless dimmed
export const createReviewFolderUri = (
  path: string,
  dimmed = false,
): vscode.Uri =>
  vscode.Uri.from({
    scheme: REVIEW_ITEM_SCHEME,
    path: `/${path}`,
    query: dimmed ? DIM_QUERY : "",
  });

// The /header/ prefix keeps a header's decoration off any file named like it
export const createDimmedHeaderUri = (id: string): vscode.Uri =>
  vscode.Uri.from({
    scheme: REVIEW_ITEM_SCHEME,
    path: `/header/${id}`,
    query: DIM_QUERY,
  });

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

const WAITING_DECORATIONS = Object.fromEntries(
  Object.entries(DECORATIONS).map(([kind, decoration]) => [
    kind,
    new vscode.FileDecoration(decoration.badge, WAIT_TOOLTIP, DIM_COLOR),
  ]),
) as Record<ChangeKind, vscode.FileDecoration>;

const DIMMED_DECORATIONS = Object.fromEntries(
  Object.entries(DECORATIONS).map(([kind, decoration]) => [
    kind,
    new vscode.FileDecoration(decoration.badge, decoration.tooltip, DIM_COLOR),
  ]),
) as Record<ChangeKind, vscode.FileDecoration>;

const DIMMED_ROW_DECORATION = new vscode.FileDecoration(
  undefined,
  undefined,
  DIM_COLOR,
);

export const createReviewDecorationProvider =
  (): vscode.FileDecorationProvider => ({
    provideFileDecoration: (uri) => {
      if (uri.scheme !== REVIEW_ITEM_SCHEME) {
        return undefined;
      }
      if (uri.query === UNCLUSTERED_HEADER_QUERY) {
        return UNCLUSTERED_HEADER_DECORATION;
      }
      if (uri.query === DIM_QUERY) {
        return DIMMED_ROW_DECORATION;
      }
      if (uri.query.endsWith(WAIT_SUFFIX)) {
        return WAITING_DECORATIONS[
          uri.query.slice(0, -WAIT_SUFFIX.length) as ChangeKind
        ];
      }
      if (uri.query.endsWith(DIM_SUFFIX)) {
        return DIMMED_DECORATIONS[
          uri.query.slice(0, -DIM_SUFFIX.length) as ChangeKind
        ];
      }
      return DECORATIONS[uri.query as ChangeKind];
    },
  });
