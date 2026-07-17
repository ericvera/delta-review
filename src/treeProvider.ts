import { dirname } from "node:path";
import * as vscode from "vscode";
import {
  ClusterModel,
  clusterBucketForKey,
  clusterContextValue,
  clusterCountDescription,
  clusterFilesForKey,
} from "./clusters";
import {
  createReviewFolderUri,
  createReviewItemUri,
  createUnclusteredHeaderUri,
} from "./decorations";
import { FileReviewStatus, ReviewFile, ReviewModel } from "./model";
import { Triage } from "./triage";

export type ViewMode = "list" | "tree";

interface GroupElement {
  kind: "group";
  status: FileReviewStatus;
}

interface AutoGroupElement {
  kind: "autoGroup";
  status: FileReviewStatus;
}

interface ClusterElement {
  kind: "cluster";
  // "c<index>" for real clusters, or the synthetic "unclustered" | "auto".
  // Files are re-resolved from getClusterModel() at render time — elements
  // never capture file arrays, so refreshes see the current model.
  clusterKey: string;
}

// A single informational row (e.g. inside an empty cluster); not collapsible,
// not actionable
interface MessageElement {
  kind: "message";
  text: string;
}

interface FolderElement {
  kind: "folder";
  // Exactly one scope is set: the status group whose non-auto files this
  // folder subdivides (ungrouped), or the cluster whose files it subdivides
  // (grouped)
  status?: FileReviewStatus;
  clusterKey?: string;
  // Repo-relative directory path, '/'-separated (git style)
  path: string;
}

interface FileElement {
  kind: "file";
  file: ReviewFile;
  // Set on children of flat-only containers (the Auto subgroup, the grouped
  // Auto and Unclustered buckets): they render flat in both layouts, so the
  // row shows the directory even in tree mode
  alwaysFlat?: true;
  // Set on rows rendered under cluster grouping, where reviewed files stay
  // visible in place: reviewed rows append ✓ to the description
  grouped?: true;
}

export type ReviewTreeElement =
  | GroupElement
  | AutoGroupElement
  | ClusterElement
  | MessageElement
  | FolderElement
  | FileElement;

type CollapsibleElement =
  GroupElement | AutoGroupElement | ClusterElement | FolderElement;

// Stable key for persisting collapse state. Groups keep the bare status value
// and unscoped folders keep `folder:<status>:<path>` for compatibility with
// previously stored state; cluster-scoped folders use the cluster key instead
// (the key sets never collide: statuses are "needs-review"/"reviewed",
// cluster keys are "c<n>"/"unclustered"/"auto").
export const collapseKeyFor = (element: CollapsibleElement): string => {
  switch (element.kind) {
    case "group":
      return element.status;
    case "autoGroup":
      return `autoGroup:${element.status}`;
    case "cluster":
      return `cluster:${element.clusterKey}`;
    case "folder":
      return `folder:${element.clusterKey ?? element.status}:${element.path}`;
  }
};

// Default-collapsed elements persist their collapse state inverted (an
// `expanded:<key>` entry while expanded); everything else stores its bare key
// while collapsed. Auto is default-collapsed in both placements — mechanical
// files are noise until the reviewer asks for them.
export const isDefaultCollapsed = (element: CollapsibleElement): boolean =>
  element.kind === "autoGroup" ||
  (element.kind === "cluster" && element.clusterKey === "auto");

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
        // Real clusters in contract order — empty ones included, they render
        // a message row — then Unclustered and Auto only when non-empty
        const root: ReviewTreeElement[] = clusterModel.clusters.map(
          (_, index): ClusterElement => ({
            kind: "cluster",
            clusterKey: `c${index}`,
          }),
        );
        if (clusterModel.unclustered.length > 0) {
          root.push({ kind: "cluster", clusterKey: "unclustered" });
        }
        if (clusterModel.auto.length > 0) {
          root.push({ kind: "cluster", clusterKey: "auto" });
        }
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
    if (element.kind === "folder") {
      return this.treeChildren(this.folderScopeFiles(element), element.path, {
        status: element.status,
        clusterKey: element.clusterKey,
      });
    }
    return [];
  }

  private clusterChildren(clusterKey: string): ReviewTreeElement[] {
    const clusterModel = this.getClusterModel();
    if (clusterModel === undefined) {
      return [];
    }
    const files = clusterFilesForKey(clusterModel, clusterKey);
    // Unclustered and Auto contents are always a flat list, in both layouts
    // (their files are scattered — a tree would be all folders)
    if (clusterKey === "unclustered" || clusterKey === "auto") {
      return files.map((file): FileElement => ({
        kind: "file",
        file,
        alwaysFlat: true,
        grouped: true,
      }));
    }
    if (files.length === 0) {
      return [
        {
          kind: "message",
          text: "No files from this cluster are in the current change.",
        },
      ];
    }
    if (this.getViewMode() === "list") {
      return files.map((file): FileElement => ({
        kind: "file",
        file,
        grouped: true,
      }));
    }
    return this.treeChildren(files, "", { clusterKey });
  }

  // The full file list a folder subdivides: its cluster's files (grouped) or
  // its status group's non-auto files (ungrouped)
  private folderScopeFiles(element: FolderElement): ReviewFile[] {
    if (element.clusterKey !== undefined) {
      const clusterModel = this.getClusterModel();
      return clusterModel === undefined
        ? []
        : clusterFilesForKey(clusterModel, element.clusterKey);
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
    scope: { status?: FileReviewStatus; clusterKey?: string },
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
        path: `${prefix}${name}`,
      })),
      ...directFiles.map((file): FileElement =>
        scope.clusterKey !== undefined
          ? { kind: "file", file, grouped: true }
          : { kind: "file", file },
      ),
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
      item.contextValue =
        element.status === FileReviewStatus.NeedsReview
          ? "needsReviewAutoGroup"
          : "reviewedAutoGroup";
      item.tooltip =
        "Files matching deltaReview.autoReview.globs or marked linguist-generated in .gitattributes";
      return item;
    }

    if (element.kind === "cluster") {
      return this.clusterTreeItem(element);
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
      item.id = `folder:${element.clusterKey ?? element.status}:${element.path}`;
      if (element.clusterKey !== undefined) {
        // Cluster folders mix statuses (reviewed files stay visible in
        // place): ✓ while anything underneath still needs review, − once
        // everything is reviewed
        const prefix = `${element.path}/`;
        const hasNeedsReview = this.folderScopeFiles(element).some(
          (file) =>
            file.path.startsWith(prefix) &&
            file.status === FileReviewStatus.NeedsReview,
        );
        item.contextValue = hasNeedsReview
          ? "needsReviewFolder"
          : "reviewedFolder";
      } else {
        item.contextValue =
          element.status === FileReviewStatus.NeedsReview
            ? "needsReviewFolder"
            : "reviewedFolder";
      }
      item.tooltip = element.path;
      return item;
    }

    const { file } = element;
    // Custom scheme: file icons still resolve from the name, but only our
    // decoration provider (M/A/D letters + colors) applies, not git's
    const item = new vscode.TreeItem(createReviewItemUri(file));
    item.id = `file:${file.path}`;
    // Context value encodes status (drives the +/− inline action) and a
    // Deleted suffix (hides Open File, which prefix matches ignore)
    const statusValue =
      file.status === FileReviewStatus.NeedsReview
        ? "needsReviewFile"
        : "reviewedFile";
    item.contextValue = file.deleted ? `${statusValue}Deleted` : statusValue;

    // In tree mode the hierarchy already conveys the directory; deletion is
    // conveyed by the D decoration. Flat-only rows (Auto subgroup, grouped
    // Auto/Unclustered) always need the location.
    const directory = dirname(file.path);
    const showDirectory =
      element.alwaysFlat === true || this.getViewMode() === "list";
    const directoryText =
      showDirectory && directory !== "." ? directory : undefined;
    // Moves show their origin like the built-in git view's staged renames:
    // "<dir> ← <old>" when the directory is shown, bare "← <old>" otherwise
    const movedText =
      file.movedFrom !== undefined ? `← ${file.movedFrom}` : undefined;
    const locationText =
      movedText !== undefined
        ? directoryText !== undefined
          ? `${directoryText} ${movedText}`
          : movedText
        : directoryText;
    // Under cluster grouping, reviewed files stay visible in place; the ✓
    // (plus the muted decoration color) is what marks them as done
    const reviewedMark =
      element.grouped === true && file.status === FileReviewStatus.Reviewed;
    item.description = reviewedMark
      ? locationText !== undefined
        ? `${locationText} ✓`
        : "✓"
      : locationText;
    // Hover always leads with the full repo-relative path (the row usually
    // truncates it), with any status notes on separate lines
    const tooltip = new vscode.MarkdownString();
    tooltip.appendCodeblock(file.path, "text");
    // Paragraph break so a following note (move + edit since last review)
    // renders on its own line
    if (file.movedFrom !== undefined) {
      tooltip.appendMarkdown(`Moved from ${file.movedFrom}\n\n`);
    }
    if (file.deleted) {
      tooltip.appendMarkdown("Deleted from the working tree");
    }
    if (file.diffBaseIsReviewedSnapshot) {
      tooltip.appendMarkdown("Changed since last reviewed");
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
