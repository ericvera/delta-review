import { dirname } from "node:path";
import * as vscode from "vscode";
import {
  ClusterModel,
  clusterBodyState,
  clusterBucketForKey,
  clusterContextValue,
  clusterCountDescription,
  clusterFilesForKey,
  filterByStatus,
} from "./clusters";
import {
  createReviewFolderUri,
  createReviewItemUri,
  createUnclusteredHeaderUri,
} from "./decorations";
import { escapeMarkdownText } from "./markdown";
import { FileReviewStatus, ReviewFile, ReviewModel } from "./model";
import { buildRowDescription, buildTooltipOriginLine } from "./moveDisplay";
import {
  autoGroupContextValue,
  fileContextValue,
  folderContextValue,
} from "./rowContext";
import { parentOf } from "./treeParents";
import { Triage } from "./triage";

export type ViewMode = "list" | "tree";

export interface GroupElement {
  kind: "group";
  status: FileReviewStatus;
}

export interface AutoGroupElement {
  kind: "autoGroup";
  status: FileReviewStatus;
}

export interface ClusterElement {
  kind: "cluster";
  // "c<index>" for real clusters, or the synthetic "unclustered" | "auto".
  // Files are re-resolved from getClusterModel() at render time — elements
  // never capture file arrays, so refreshes see the current model.
  clusterKey: string;
}

// A single informational row (e.g. inside an empty cluster); not collapsible,
// not actionable
export interface MessageElement {
  kind: "message";
  text: string;
}

// The grouped view's bottom bucket collecting every reviewed file (all
// triages, all origins)
export interface ReviewedBucketElement {
  kind: "reviewedBucket";
}

export interface FolderElement {
  kind: "folder";
  // Exactly one scope is set: the status group whose non-auto files this
  // folder subdivides (ungrouped), the cluster whose needs-review files it
  // subdivides (grouped), or the grouped Reviewed bucket
  status?: FileReviewStatus;
  clusterKey?: string;
  inReviewedBucket?: true;
  // Repo-relative directory path, '/'-separated (git style)
  path: string;
}

export interface FileElement {
  kind: "file";
  file: ReviewFile;
  // Set on children of flat-only containers (the Auto subgroup, the grouped
  // Auto and Unclustered buckets): they render flat in both layouts, so the
  // row shows the directory even in tree mode
  alwaysFlat?: true;
}

export type ReviewTreeElement =
  | GroupElement
  | AutoGroupElement
  | ClusterElement
  | MessageElement
  | ReviewedBucketElement
  | FolderElement
  | FileElement;

type CollapsibleElement =
  | GroupElement
  | AutoGroupElement
  | ClusterElement
  | ReviewedBucketElement
  | FolderElement;

// Stable key for persisting collapse state. Groups keep the bare status value
// and unscoped folders keep `folder:<status>:<path>` for compatibility with
// previously stored state; cluster-scoped folders use the cluster key and
// reviewed-bucket folders use "reviewedBucket" instead. The namespaces never
// collide: statuses are "needs-review"/"reviewed", cluster keys are
// "c<n>"/"unclustered"/"auto", and the grouped bucket is "reviewedBucket" —
// which also keeps its collapse state separate from the ungrouped Reviewed
// group's bare "reviewed" key.
export const collapseKeyFor = (element: CollapsibleElement): string => {
  switch (element.kind) {
    case "group":
      return element.status;
    case "autoGroup":
      return `autoGroup:${element.status}`;
    case "cluster":
      return `cluster:${element.clusterKey}`;
    case "reviewedBucket":
      return "reviewedBucket";
    case "folder":
      return `folder:${
        element.clusterKey ??
        (element.inReviewedBucket ? "reviewedBucket" : element.status)
      }:${element.path}`;
  }
};

// Default-collapsed elements persist their collapse state inverted (an
// `expanded:<key>` entry while expanded); everything else stores its bare key
// while collapsed. Auto is default-collapsed in both placements — mechanical
// files are noise until the reviewer asks for them.
export const isDefaultCollapsed = (element: CollapsibleElement): boolean =>
  element.kind === "autoGroup" ||
  (element.kind === "cluster" && element.clusterKey === "auto");

// The header − reaches further than the count beside it: the count is the
// reviewed files, the press clears every snapshot on the branch. Shared by
// the ungrouped Reviewed group and the grouped Reviewed bucket, which are one
// row to the reviewer.
const REVIEWED_HEADER_TOOLTIP =
  "− clears all review state on this branch, including files that changed since you reviewed them.";

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeElement> {
  private model: ReviewModel | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<
    ReviewTreeElement | undefined
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly isCollapsed: (
      key: string,
      defaultCollapsed: boolean,
    ) => boolean,
    private readonly getViewMode: () => ViewMode,
    private readonly getClusterModel: () => ClusterModel | undefined,
    // Effective grouping (preference && a cluster model exists) — when false,
    // rendering is byte-identical to a build without clustering
    private readonly isGrouped: () => boolean,
  ) {}

  setModel(model: ReviewModel | undefined): void {
    this.model = model;
    this.changeEmitter.fire(undefined);
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getChildren(element?: ReviewTreeElement): ReviewTreeElement[] {
    if (this.model === undefined) {
      return [];
    }
    if (element === undefined) {
      const clusterModel = this.getClusterModel();
      if (this.isGrouped() && clusterModel !== undefined) {
        // Real clusters in contract order — empty and fully reviewed ones
        // included, they render a message row — then Unclustered and Auto
        // only while they hold a needs-review file (their reviewed members
        // live in the Reviewed bucket), then the Reviewed bucket always last
        const root: ReviewTreeElement[] = clusterModel.clusters.map(
          (_, index): ClusterElement => ({
            kind: "cluster",
            clusterKey: `c${index}`,
          }),
        );
        for (const clusterKey of ["unclustered", "auto"] as const) {
          const needsReview = filterByStatus(
            clusterFilesForKey(clusterModel, clusterKey),
            FileReviewStatus.NeedsReview,
          );
          if (needsReview.length > 0) {
            root.push({ kind: "cluster", clusterKey });
          }
        }
        root.push({ kind: "reviewedBucket" });
        return root;
      }
      return [
        { kind: "group", status: FileReviewStatus.NeedsReview },
        { kind: "group", status: FileReviewStatus.Reviewed },
      ];
    }
    if (element.kind === "group") {
      // Auto-triaged files render in their own subgroup, first; the regular
      // list/tree rendering below sees only the non-auto files. With no auto
      // files the output is identical to a build without the subgroup.
      const children: ReviewTreeElement[] =
        this.filesWithStatus(element.status, "auto").length > 0
          ? [{ kind: "autoGroup", status: element.status }]
          : [];
      if (this.getViewMode() === "list") {
        children.push(
          ...this.filesWithStatus(element.status, "normal").map(
            (file): FileElement => ({ kind: "file", file }),
          ),
        );
      } else {
        children.push(
          ...this.treeChildren(
            this.filesWithStatus(element.status, "normal"),
            "",
            { status: element.status },
          ),
        );
      }
      return children;
    }
    if (element.kind === "autoGroup") {
      // Auto contents are always a flat list, in both layouts
      return this.filesWithStatus(element.status, "auto").map(
        (file): FileElement => ({ kind: "file", file, alwaysFlat: true }),
      );
    }
    if (element.kind === "cluster") {
      return this.clusterChildren(element.clusterKey);
    }
    if (element.kind === "reviewedBucket") {
      // Every reviewed file, all triages and origins. List mode already shows
      // the directory description, so rows stay plain (no alwaysFlat).
      const reviewed = filterByStatus(
        this.model.files,
        FileReviewStatus.Reviewed,
      );
      if (this.getViewMode() === "list") {
        return reviewed.map((file): FileElement => ({ kind: "file", file }));
      }
      return this.treeChildren(reviewed, "", { inReviewedBucket: true });
    }
    if (element.kind === "folder") {
      return this.treeChildren(this.folderScopeFiles(element), element.path, {
        status: element.status,
        clusterKey: element.clusterKey,
        inReviewedBucket: element.inReviewedBucket,
      });
    }
    return [];
  }

  // Required by TreeView.reveal, which walks this chain to expand ancestors
  // and match rendered rows. Not memoized: reveal is rare, the model is not.
  getParent(element: ReviewTreeElement): ReviewTreeElement | undefined {
    if (this.model === undefined) {
      return undefined;
    }
    return parentOf(element, {
      clusterModel: this.getClusterModel(),
      viewMode: this.getViewMode(),
      grouped: this.isGrouped(),
    });
  }

  private clusterChildren(clusterKey: string): ReviewTreeElement[] {
    const clusterModel = this.getClusterModel();
    if (clusterModel === undefined) {
      return [];
    }
    // Bodies render only needs-review rows — reviewed members live in the
    // Reviewed bucket. Header counts/context values still use full membership
    // (computed in clusterTreeItem), so a fully reviewed cluster keeps n/n.
    const files = clusterFilesForKey(clusterModel, clusterKey);
    const needsReview = filterByStatus(files, FileReviewStatus.NeedsReview);
    // Unclustered and Auto contents are always a flat list, in both layouts
    // (their files are scattered — a tree would be all folders)
    if (clusterKey === "unclustered" || clusterKey === "auto") {
      return needsReview.map((file): FileElement => ({
        kind: "file",
        file,
        alwaysFlat: true,
      }));
    }
    switch (clusterBodyState(files)) {
      case "no-files":
        return [
          {
            kind: "message",
            text: "No files from this cluster are in the current change.",
          },
        ];
      case "all-reviewed":
        return [{ kind: "message", text: "All files reviewed." }];
      case "has-needs-review":
        if (this.getViewMode() === "list") {
          return needsReview.map((file): FileElement => ({
            kind: "file",
            file,
          }));
        }
        return this.treeChildren(needsReview, "", { clusterKey });
    }
  }

  // The file list a folder subdivides: its cluster's needs-review files
  // (grouped), the model's reviewed files (Reviewed bucket), or its status
  // group's non-auto files (ungrouped)
  private folderScopeFiles(element: FolderElement): ReviewFile[] {
    if (element.clusterKey !== undefined) {
      const clusterModel = this.getClusterModel();
      return clusterModel === undefined
        ? []
        : filterByStatus(
            clusterFilesForKey(clusterModel, element.clusterKey),
            FileReviewStatus.NeedsReview,
          );
    }
    if (element.inReviewedBucket === true) {
      return this.model === undefined
        ? []
        : filterByStatus(this.model.files, FileReviewStatus.Reviewed);
    }
    return element.status === undefined
      ? []
      : this.filesWithStatus(element.status, "normal");
  }

  // Immediate children of a directory in tree mode: subfolders first, then
  // files, each alphabetical (same ordering as the built-in CHANGES tree).
  // `files` is the scope's full file list; `scope` is stamped onto the
  // produced elements so nested levels resolve the same file source.
  private treeChildren(
    files: ReviewFile[],
    parentPath: string,
    scope: {
      status?: FileReviewStatus;
      clusterKey?: string;
      inReviewedBucket?: true;
    },
  ): ReviewTreeElement[] {
    const prefix = parentPath === "" ? "" : `${parentPath}/`;
    const folderNames = new Set<string>();
    const directFiles: ReviewFile[] = [];
    for (const file of files) {
      if (!file.path.startsWith(prefix)) {
        continue;
      }
      const rest = file.path.slice(prefix.length);
      const slashIndex = rest.indexOf("/");
      if (slashIndex === -1) {
        directFiles.push(file);
      } else {
        folderNames.add(rest.slice(0, slashIndex));
      }
    }
    return [
      ...[...folderNames].sort().map((name): FolderElement => ({
        kind: "folder",
        status: scope.status,
        clusterKey: scope.clusterKey,
        inReviewedBucket: scope.inReviewedBucket,
        path: `${prefix}${name}`,
      })),
      ...directFiles.map((file): FileElement => ({ kind: "file", file })),
    ];
  }

  getTreeItem(element: ReviewTreeElement): vscode.TreeItem {
    if (element.kind === "group") {
      const label =
        element.status === FileReviewStatus.NeedsReview
          ? "Needs Review"
          : "Reviewed";
      // VS Code applies the returned collapsible state on every refresh, so
      // the user's last toggle has to be replayed here to stick
      const item = new vscode.TreeItem(
        label,
        this.isCollapsed(collapseKeyFor(element), false)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      // Count as dim description text — the closest a tree view gets to the
      // CHANGES count pill
      item.description = String(this.filesWithStatus(element.status).length);
      item.id = `group:${element.status}`;
      item.contextValue =
        element.status === FileReviewStatus.NeedsReview
          ? "needsReviewGroup"
          : "reviewedGroup";
      if (element.status === FileReviewStatus.Reviewed) {
        item.tooltip = REVIEWED_HEADER_TOOLTIP;
      }
      return item;
    }

    if (element.kind === "autoGroup") {
      // Collapsed by default: mechanical files are noise until the reviewer
      // asks for them
      const item = new vscode.TreeItem(
        "Auto",
        this.isCollapsed(collapseKeyFor(element), true)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon("gear");
      item.description = String(
        this.filesWithStatus(element.status, "auto").length,
      );
      item.id = `autoGroup:${element.status}`;
      item.contextValue = autoGroupContextValue(
        this.filesWithStatus(element.status, "auto"),
        element.status,
      );
      item.tooltip =
        "Files matching deltaReview.autoReview.globs or marked linguist-generated in .gitattributes";
      return item;
    }

    if (element.kind === "cluster") {
      return this.clusterTreeItem(element);
    }

    if (element.kind === "reviewedBucket") {
      const item = new vscode.TreeItem(
        "Reviewed",
        this.isCollapsed(collapseKeyFor(element), false)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon("check");
      // Plain count over the whole model — auto files included
      item.description = String(
        this.model === undefined
          ? 0
          : filterByStatus(this.model.files, FileReviewStatus.Reviewed).length,
      );
      item.id = "reviewedBucket";
      // Reuses the ungrouped Reviewed group's context value so its bulk
      // unmark inline action applies unchanged
      item.contextValue = "reviewedGroup";
      item.tooltip = REVIEWED_HEADER_TOOLTIP;
      return item;
    }

    if (element.kind === "message") {
      // Plain label, no icon, no command — reads as the dim informational row
      // of the mock
      return new vscode.TreeItem(
        element.text,
        vscode.TreeItemCollapsibleState.None,
      );
    }

    if (element.kind === "folder") {
      // Private scheme keeps git's propagated "contains changes" dot off the
      // rows — folders carry no badge, like the CHANGES tree
      const item = new vscode.TreeItem(
        createReviewFolderUri(element.path),
        this.isCollapsed(collapseKeyFor(element), false)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      // Same scope discriminator as the collapse key, so grouped, bucket,
      // and ungrouped folders for one path stay distinct rows
      item.id = collapseKeyFor(element);
      // A cluster folder renders needs-review descendants only; the grouped
      // bucket and the ungrouped Reviewed group render reviewed ones
      const reviewedScope =
        element.clusterKey === undefined &&
        (element.inReviewedBucket === true ||
          element.status === FileReviewStatus.Reviewed);
      // Scoped to what this row actually renders, so a needs-review folder
      // never reports on the same paths shown under the Reviewed group
      item.contextValue = folderContextValue(
        this.folderScopeFiles(element).filter((file) =>
          file.path.startsWith(`${element.path}/`),
        ),
        reviewedScope,
      );
      item.tooltip = element.path;
      return item;
    }

    const { file } = element;
    // Custom scheme: file icons still resolve from the name, but only our
    // decoration provider (M/A/D letters + colors) applies, not git's
    const item = new vscode.TreeItem(createReviewItemUri(file));
    item.id = `file:${file.path}`;
    item.contextValue = fileContextValue(file);

    // In tree mode the hierarchy already conveys the directory; deletion is
    // conveyed by the D decoration. Flat-only rows (Auto subgroup, grouped
    // Auto/Unclustered) always need the location.
    const directory = dirname(file.path);
    const showDirectory =
      element.alwaysFlat === true || this.getViewMode() === "list";
    const directoryText =
      showDirectory && directory !== "." ? directory : undefined;
    // The origin segment ("← [donor] <origin> · adapted") is assembled by the
    // display module; every abbreviation rule lives there, none here
    item.description = buildRowDescription({
      path: file.path,
      directoryText,
      movedFrom: file.movedFrom,
      moveOrigin: file.moveOrigin,
      donor: file.donor,
      moveClassification: file.moveClassification,
    });
    // Hover always leads with the full repo-relative path (the row usually
    // truncates it), with any status notes on separate lines
    const tooltip = new vscode.MarkdownString();
    tooltip.appendCodeblock(file.path, "text");
    // Fixed order, joined by paragraph breaks so each lands on its own line
    // however many of them stack
    const notes: string[] = [];
    // Assembled and escaped by the display module, alongside the row's form
    const originLine = buildTooltipOriginLine({
      movedFrom: file.movedFrom,
      donor: file.donor,
    });
    if (originLine !== undefined) {
      notes.push(originLine);
    }
    if (file.moveNote !== undefined && file.moveNote !== "") {
      // Contract text: escaped so its markdown cannot restyle the tooltip
      notes.push(escapeMarkdownText(file.moveNote));
    }
    if (file.moveClassification === "verbatim") {
      notes.push("Identical to the origin");
    } else if (file.originContentUnavailable) {
      notes.push(
        "Origin content is no longer available — showing the whole file.",
      );
    }
    if (file.deleted) {
      notes.push("Deleted from the working tree");
    }
    if (file.diffBaseIsReviewedSnapshot) {
      notes.push("Changed since last reviewed");
    }
    if (notes.length > 0) {
      tooltip.appendMarkdown(notes.join("\n\n"));
    }
    item.tooltip = tooltip;
    item.command = {
      command: "deltaReview.openDiff",
      title: "Open Review Diff",
      arguments: [file],
    };
    return item;
  }

  private clusterTreeItem(element: ClusterElement): vscode.TreeItem {
    const clusterModel = this.getClusterModel();
    const files =
      clusterModel === undefined
        ? []
        : clusterFilesForKey(clusterModel, element.clusterKey);
    // Auto stays collapsed by default (same rationale as the ungrouped
    // subgroup); clusters and Unclustered start expanded
    const item = new vscode.TreeItem(
      "",
      this.isCollapsed(collapseKeyFor(element), isDefaultCollapsed(element))
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    if (element.clusterKey === "auto") {
      item.label = "Auto";
      item.iconPath = new vscode.ThemeIcon("gear");
      item.tooltip =
        "Files matching deltaReview.autoReview.globs or marked linguist-generated in .gitattributes";
    } else if (element.clusterKey === "unclustered") {
      item.label = "Unclustered";
      item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("list.warningForeground"),
      );
      // Label + resourceUri together: the label wins for display, the
      // decoration's warning color still tints it (scope-creep detector)
      item.resourceUri = createUnclusteredHeaderUri();
      item.tooltip = "Files not claimed by any cluster";
    } else {
      const bucket =
        clusterModel === undefined
          ? undefined
          : clusterBucketForKey(clusterModel, element.clusterKey);
      item.label = bucket?.label ?? "";
      item.iconPath = new vscode.ThemeIcon("layers");
      item.tooltip = bucket?.summary;
    }
    item.description = clusterCountDescription(
      files,
      element.clusterKey === "auto",
    );
    item.id = `cluster:${element.clusterKey}`;
    item.contextValue = clusterContextValue(files);
    return item;
  }

  // Files with the given status, optionally narrowed to one triage class.
  // model.files is pre-sorted by path, so results stay alphabetical.
  private filesWithStatus(
    status: FileReviewStatus,
    triage?: Triage,
  ): ReviewFile[] {
    if (this.model === undefined) {
      return [];
    }
    return this.model.files.filter(
      (file) =>
        file.status === status &&
        (triage === undefined || file.triage === triage),
    );
  }
}
