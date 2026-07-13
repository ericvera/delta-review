import { dirname } from 'node:path'
import * as vscode from 'vscode'
import { createReviewFolderUri, createReviewItemUri } from './decorations'
import { FileReviewStatus, ReviewFile, ReviewModel } from './model'

export type ViewMode = 'list' | 'tree'

interface GroupElement {
  kind: 'group'
  status: FileReviewStatus
}

interface FolderElement {
  kind: 'folder'
  status: FileReviewStatus
  // Repo-relative directory path, '/'-separated (git style)
  path: string
}

interface FileElement {
  kind: 'file'
  file: ReviewFile
}

export type ReviewTreeElement = GroupElement | FolderElement | FileElement

// Stable key for persisting collapse state. Groups keep the bare status value
// for compatibility with previously stored state.
export const collapseKeyFor = (element: GroupElement | FolderElement): string =>
  element.kind === 'group' ? element.status : `folder:${element.status}:${element.path}`

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeElement> {
  private model: ReviewModel | undefined
  private readonly changeEmitter = new vscode.EventEmitter<ReviewTreeElement | undefined>()
  readonly onDidChangeTreeData = this.changeEmitter.event

  constructor(
    private readonly isCollapsed: (key: string) => boolean,
    private readonly getViewMode: () => ViewMode
  ) {}

  setModel(model: ReviewModel | undefined): void {
    this.model = model
    this.changeEmitter.fire(undefined)
  }

  refresh(): void {
    this.changeEmitter.fire(undefined)
  }

  getChildren(element?: ReviewTreeElement): ReviewTreeElement[] {
    if (this.model === undefined) {
      return []
    }
    if (element === undefined) {
      return [
        { kind: 'group', status: FileReviewStatus.NeedsReview },
        { kind: 'group', status: FileReviewStatus.Reviewed },
      ]
    }
    if (element.kind === 'group') {
      if (this.getViewMode() === 'list') {
        return this.filesWithStatus(element.status).map(
          (file): FileElement => ({ kind: 'file', file })
        )
      }
      return this.treeChildren(element.status, '')
    }
    if (element.kind === 'folder') {
      return this.treeChildren(element.status, element.path)
    }
    return []
  }

  // Immediate children of a directory in tree mode: subfolders first, then
  // files, each alphabetical (same ordering as the built-in CHANGES tree)
  private treeChildren(status: FileReviewStatus, parentPath: string): ReviewTreeElement[] {
    const prefix = parentPath === '' ? '' : `${parentPath}/`
    const folderNames = new Set<string>()
    const directFiles: ReviewFile[] = []
    for (const file of this.filesWithStatus(status)) {
      if (!file.path.startsWith(prefix)) {
        continue
      }
      const rest = file.path.slice(prefix.length)
      const slashIndex = rest.indexOf('/')
      if (slashIndex === -1) {
        directFiles.push(file)
      } else {
        folderNames.add(rest.slice(0, slashIndex))
      }
    }
    return [
      ...[...folderNames]
        .sort()
        .map((name): FolderElement => ({ kind: 'folder', status, path: `${prefix}${name}` })),
      ...directFiles.map((file): FileElement => ({ kind: 'file', file })),
    ]
  }

  getTreeItem(element: ReviewTreeElement): vscode.TreeItem {
    if (element.kind === 'group') {
      const label =
        element.status === FileReviewStatus.NeedsReview ? 'Needs Review' : 'Reviewed'
      // VS Code applies the returned collapsible state on every refresh, so
      // the user's last toggle has to be replayed here to stick
      const item = new vscode.TreeItem(
        label,
        this.isCollapsed(collapseKeyFor(element))
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
      )
      // Count as dim description text — the closest a tree view gets to the
      // CHANGES count pill
      item.description = String(this.filesWithStatus(element.status).length)
      item.id = `group:${element.status}`
      item.contextValue =
        element.status === FileReviewStatus.NeedsReview ? 'needsReviewGroup' : 'reviewedGroup'
      return item
    }

    if (element.kind === 'folder') {
      // Private scheme keeps git's propagated "contains changes" dot off the
      // rows — folders carry no badge, like the CHANGES tree
      const item = new vscode.TreeItem(
        createReviewFolderUri(element.path),
        this.isCollapsed(collapseKeyFor(element))
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
      )
      item.id = `folder:${element.status}:${element.path}`
      item.contextValue =
        element.status === FileReviewStatus.NeedsReview ? 'needsReviewFolder' : 'reviewedFolder'
      item.tooltip = element.path
      return item
    }

    const { file } = element
    // Custom scheme: file icons still resolve from the name, but only our
    // decoration provider (M/A/D letters + colors) applies, not git's
    const item = new vscode.TreeItem(createReviewItemUri(file))
    item.id = `file:${file.path}`
    // Context value encodes status (drives the +/− inline action) and a
    // Deleted suffix (hides Open File, which prefix matches ignore)
    const statusValue =
      file.status === FileReviewStatus.NeedsReview ? 'needsReviewFile' : 'reviewedFile'
    item.contextValue = file.deleted ? `${statusValue}Deleted` : statusValue

    // In tree mode the hierarchy already conveys the directory; deletion is
    // conveyed by the D decoration
    const directory = dirname(file.path)
    item.description =
      this.getViewMode() === 'list' && directory !== '.' ? directory : undefined
    // Hover always leads with the full repo-relative path (the row usually
    // truncates it), with any status notes on separate lines
    const tooltip = new vscode.MarkdownString()
    tooltip.appendCodeblock(file.path, 'text')
    if (file.deleted) {
      tooltip.appendMarkdown('Deleted from the working tree')
    }
    if (file.diffBaseIsReviewedSnapshot) {
      tooltip.appendMarkdown('Changed since last reviewed')
    }
    item.tooltip = tooltip
    item.command = {
      command: 'deltaReview.openDiff',
      title: 'Open Review Diff',
      arguments: [file],
    }
    return item
  }

  private filesWithStatus(status: FileReviewStatus): ReviewFile[] {
    if (this.model === undefined) {
      return []
    }
    return this.model.files.filter((file) => file.status === status)
  }
}
