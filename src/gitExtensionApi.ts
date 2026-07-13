import * as vscode from 'vscode'

// Minimal typings for the built-in git extension API (vscode.git), covering
// only what Delta Review consumes: the repository list (which includes git
// worktrees added to the Source Control view), the UI selection that drives
// the CHANGES panel, and repository state changes (HEAD, index, refs).

export interface GitRepository {
  readonly rootUri: vscode.Uri
  readonly ui: {
    readonly selected: boolean
    readonly onDidChange: vscode.Event<void>
  }
  readonly state: {
    readonly onDidChange: vscode.Event<void>
  }
}

export interface GitApi {
  readonly repositories: GitRepository[]
  readonly onDidOpenRepository: vscode.Event<GitRepository>
  readonly onDidCloseRepository: vscode.Event<GitRepository>
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi
}

// Resolves to undefined when the built-in git extension is disabled
export const getGitApi = async (): Promise<GitApi | undefined> => {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git')
  if (extension === undefined) {
    return undefined
  }
  try {
    return (await extension.activate()).getAPI(1)
  } catch {
    return undefined
  }
}
