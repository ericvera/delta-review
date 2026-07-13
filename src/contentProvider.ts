import * as vscode from 'vscode'
import { Git } from './git'

export const REVIEW_BASE_SCHEME = 'delta-review-base'

// The blob sha travels in the query so each snapshot renders as a distinct,
// immutable document; the path is kept for language detection in the editor
export const createReviewBaseUri = (path: string, sha: string | undefined): vscode.Uri =>
  vscode.Uri.from({ scheme: REVIEW_BASE_SCHEME, path: `/${path}`, query: sha ?? 'empty' })

export const createReviewBaseContentProvider = (
  getGit: () => Git | undefined
): vscode.TextDocumentContentProvider => ({
  provideTextDocumentContent: async (uri) => {
    const git = getGit()
    if (git === undefined || uri.query === 'empty') {
      return ''
    }
    try {
      return await git.run(['cat-file', 'blob', uri.query])
    } catch {
      return ''
    }
  },
})
