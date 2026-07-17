import { dirname } from "node:path";
import * as vscode from "vscode";
import { createReviewFolderUri, createReviewItemUri } from "./decorations";
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

interface FolderElement {
  kind: "folder";
  status: FileReviewStatus;
  // Repo-relative directory path, '/'-separated (git style)
  path: string;
}

interface FileElement {
  kind: "file";
  file: ReviewFile;
  // Set on children of an Auto subgroup: they render flat in both layouts,
  // so the row shows the directory even in tree mode
  inAutoGroup?: true;
}

export type ReviewTreeElement =
  GroupElement | AutoGroupElement | FolderElement | FileElement;

// Stable key for persisting collapse state. Groups keep the bare status value
// for compatibility with previously stored state.
export const collapseKeyFor = (
  element: GroupElement | AutoGroupElement | FolderElement,
): string => {
  switch (element.kind) {
    case "group":
      return element.status;
    case "autoGroup":
      return `autoGroup:${element.status}`;
    case "folder":
      return `folder:${element.status}:${element.path}`;
  }
};

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
        children.push(...this.treeChildren(element.status, ""));
      }
      return children;
    }
    if (element.kind === "autoGroup") {
      // Auto contents are always a flat list, in both layouts
      return this.filesWithStatus(element.status, "auto").map(
        (file): FileElement => ({ kind: "file", file, inAutoGroup: true }),
      );
    }
    if (element.kind === "folder") {
      return this.treeChildren(element.status, element.path);
    }
    return [];
  }

  // Immediate children of a directory in tree mode: subfolders first, then
  // files, each alphabetical (same ordering as the built-in CHANGES tree).
  // Auto files never appear in the folder tree — they live in the flat Auto
  // subgroup instead.
  private treeChildren(
    status: FileReviewStatus,
    parentPath: string,
  ): ReviewTreeElement[] {
    const prefix = parentPath === "" ? "" : `${parentPath}/`;
    const folderNames = new Set<string>();
    const directFiles: ReviewFile[] = [];
    for (const file of this.filesWithStatus(status, "normal")) {
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
        status,
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

    if (element.kind === "folder") {
      // Private scheme keeps git's propagated "contains changes" dot off the
      // rows — folders carry no badge, like the CHANGES tree
      const item = new vscode.TreeItem(
        createReviewFolderUri(element.path),
        this.isCollapsed(collapseKeyFor(element), false)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `folder:${element.status}:${element.path}`;
      item.contextValue =
        element.status === FileReviewStatus.NeedsReview
          ? "needsReviewFolder"
          : "reviewedFolder";
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
    // conveyed by the D decoration. Auto-subgroup rows are flat in both
    // layouts, so they always need the location.
    const directory = dirname(file.path);
    const showDirectory =
      element.inAutoGroup === true || this.getViewMode() === "list";
    item.description =
      showDirectory && directory !== "." ? directory : undefined;
    // Hover always leads with the full repo-relative path (the row usually
    // truncates it), with any status notes on separate lines
    const tooltip = new vscode.MarkdownString();
    tooltip.appendCodeblock(file.path, "text");
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
