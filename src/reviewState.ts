import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Git, parseLsTreeOutput } from './git'

// Snapshot content recorded when a file was deleted from the working tree at
// the moment it was marked reviewed. A deletion has no blob of its own, so a
// deterministic sentinel blob stands in for it in the review tree.
export const DELETED_SENTINEL_CONTENT = 'delta-review: file deleted\n'

export const reviewRefForBranch = (branch: string): string => `refs/review/${branch}`

// Reads the reviewed-content map (path -> blob sha) from the review ref.
// A missing ref means nothing has been reviewed yet on this branch.
export const readReviewState = async (git: Git, branch: string): Promise<Map<string, string>> => {
  try {
    const output = await git.run(['ls-tree', '-r', '-z', reviewRefForBranch(branch)])
    return parseLsTreeOutput(output)
  } catch {
    return new Map()
  }
}

// Persists the reviewed-content map as a commit on the review ref. The commit
// tree anchors the snapshot blobs so `git gc` never collects them, and the
// parent chain keeps a browsable history of review sessions.
export const writeReviewState = async (
  git: Git,
  branch: string,
  state: Map<string, string>
): Promise<void> => {
  // A temporary index keeps this fully isolated from the user's real index
  const indexFile = join(tmpdir(), `delta-review-${randomBytes(8).toString('hex')}`)
  const env = { GIT_INDEX_FILE: indexFile }
  try {
    await git.run(['read-tree', '--empty'], { env })
    if (state.size > 0) {
      const indexInfo = [...state.entries()]
        .map(([path, sha]) => `100644 ${sha} 0\t${path}\0`)
        .join('')
      await git.run(['update-index', '-z', '--index-info'], { env, stdin: indexInfo })
    }
    const tree = (await git.run(['write-tree'], { env })).trim()

    const ref = reviewRefForBranch(branch)
    let parentArgs: string[] = []
    try {
      const parent = (await git.run(['rev-parse', '--verify', '--quiet', ref])).trim()
      if (parent !== '') {
        parentArgs = ['-p', parent]
      }
    } catch {
      // No previous review state for this branch
    }
    const commit = (await git.run(['commit-tree', tree, ...parentArgs, '-m', 'delta-review state'])).trim()
    await git.run(['update-ref', ref, commit])
  } finally {
    await unlink(indexFile).catch(() => undefined)
  }
}

// Snapshots the current working-tree content of the given paths as reviewed
export const markReviewed = async (git: Git, branch: string, paths: string[]): Promise<void> => {
  const state = await readReviewState(git, branch)
  const existingPaths = paths.filter((path) => existsSync(join(git.repoRoot, path)))
  const deletedPaths = paths.filter((path) => !existsSync(join(git.repoRoot, path)))

  if (existingPaths.length > 0) {
    const output = await git.run(['hash-object', '-w', '--stdin-paths'], {
      stdin: existingPaths.join('\n') + '\n',
    })
    const shas = output.trim().split('\n')
    existingPaths.forEach((path, index) => state.set(path, shas[index]))
  }
  if (deletedPaths.length > 0) {
    const sentinelSha = (
      await git.run(['hash-object', '-w', '--stdin'], { stdin: DELETED_SENTINEL_CONTENT })
    ).trim()
    deletedPaths.forEach((path) => state.set(path, sentinelSha))
  }

  await writeReviewState(git, branch, state)
}

export const unmarkReviewed = async (git: Git, branch: string, paths: string[]): Promise<void> => {
  const state = await readReviewState(git, branch)
  for (const path of paths) {
    state.delete(path)
  }
  await writeReviewState(git, branch, state)
}
