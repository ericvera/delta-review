# Delta Review

Incremental local code review for VS Code — mark files reviewed and, when they change again, see only the delta since your last review.

- Solves re-reviewing the same diff: after an edit, the diff shows only what changed since you marked the file reviewed.
- Content-based state: survives commits, amends, and rebases; only an actual content change resets a file.
- Auto-review: mechanical files (lockfiles, build output, `linguist-generated`) fold into a collapsed **Auto** subgroup — review or bulk-✓ them separately, or let them mark themselves.
- Clustered review: group the change into narrative clusters (written by Claude Code) and review it story by story instead of file by file.
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
- Multi-repo / worktrees: follows the repository selected in Source Control; state is per-branch and travels across worktrees.

### Auto-review

- Files matching `deltaReview.autoReview.globs` (or marked `linguist-generated` in `.gitattributes`) collect in a collapsed **Auto** subgroup with a `+`/`−` on the header to mark or unmark them all at once.
- Turn on `deltaReview.autoReview.markAutomatically` and they mark themselves as they change — edits are re-marked automatically while the setting is on, still inspectable under Reviewed → Auto. Turn it off and the next edit resurfaces as a delta like any file (marks use the same snapshot mechanism).

### Cluster with Claude Code

Install the companion skill in Claude Code:

```
/plugin marketplace add ericvera/delta-review
/plugin install cluster-review@delta-review
```

To update to the latest version later:

```
/plugin marketplace update delta-review
/plugin update cluster-review@delta-review
```

(then restart Claude Code to apply)

- Ask Claude to cluster the change; it writes a per-branch contract file under `.git` describing narrative clusters (label, summary, members) — nothing touches your working tree.
- A group-by-cluster button appears in the panel: review cluster by cluster, with `reviewed/total` counts per cluster, files no cluster claims called out under **Unclustered**, and Auto files last.
- Grouping is pure presentation — toggling it never changes what's marked reviewed.

## Settings

- `deltaReview.baseBranch` — branch the review set is computed against (default `main`).
- `deltaReview.autoReview.globs` — glob patterns for mechanical files to auto-review (e.g. `**/*.lock`, `dist/**`); default `[]`.
- `deltaReview.autoReview.markAutomatically` — auto files mark themselves as reviewed when they change; default `false`.

## Development

See `DEVELOPMENT.md` at the repo root.
