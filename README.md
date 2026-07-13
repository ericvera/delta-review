# Delta Review

Incremental local code review for VS Code — mark files reviewed and, when they change again, see only the delta since your last review.

- Solves re-reviewing the same diff: after an edit, the diff shows only what changed since you marked the file reviewed.
- Content-based state: survives commits, amends, and rebases; only an actual content change resets a file.
- Zero footprint: state lives inside `.git` (`refs/review/<branch>`), never in your working tree, never pushed.

## Install

```bash
yarn install-ext
```

- Builds, packages, and installs the extension into VS Code.
- Reload open windows (**Developer: Reload Window**) to pick up a new version.

## Usage

The **Delta Review** panel lives in the Source Control sidebar:

- Files changed vs the base branch appear under **Needs Review** / **Reviewed**.
- Click a file to open its review diff — against the merge base, or against your last-reviewed version if you've reviewed it before.
- Hover a row: `+` marks reviewed, `−` unmarks. Group headers and folders (in tree mode) mark/unmark everything inside.
- The Source Control icon badge and the status bar (`Review 7/23`) show how many files are left.
- Command palette: `Delta Review: Clear Review State`.
- Setting: `deltaReview.baseBranch` — branch the review set is computed against (default `main`).
- Multi-repo / worktrees: follows the repository selected in Source Control; state is per-branch and travels across worktrees.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md).
