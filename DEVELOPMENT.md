# Development

## Build & run

```bash
yarn install
yarn build     # or: yarn watch
```

Open this folder in VS Code and press **F5** ("Run Extension"). An Extension Development Host window opens with the extension loaded — open any git repo with a feature branch in it and start reviewing.

## Packaging

```bash
yarn package       # produces delta-review.vsix (e.g. to share it)
yarn install-ext   # package + install into VS Code in one step
```

Run `yarn install-ext` again after any change to update; reload open windows (**Developer: Reload Window**) to pick up the new version.

## How it works

Review state is **content, not a flag**. Marking a file reviewed snapshots its current working-tree content as a git blob, anchored under a shadow ref (`refs/review/<branch>`). A file's status is always derived by comparison:

- working tree content == reviewed snapshot → **Reviewed**
- snapshot exists but differs → **Needs Review**, and the diff opens against the snapshot (the delta since last review)
- no snapshot → **Needs Review**, diff opens against the merge base with the base branch

Because the state is content-based, it survives rebases, amends, and commits — nothing "resets" unless the file content actually changes.

### Where the state lives

Inside the repo's `.git` object database, under `refs/review/<branch>`:

- Never appears in the working tree, `git status`, branches, or PRs.
- Never pushed unless you explicitly `git push origin 'refs/review/*'`.
- Each save is a commit on the ref, so you get a browsable history of review sessions.

Inspect it:

```bash
git ls-tree -r refs/review/<branch>     # what's marked reviewed (path -> snapshot blob)
git log refs/review/<branch>            # review session history
git update-ref -d refs/review/<branch>  # nuke state for a branch (or use the command)
```

### Repository selection

Delta Review follows the repository selected in the Source Control view — the same selection that drives the built-in CHANGES panel. Switching to another repository or git worktree retargets the review set to that checkout (the panel header shows which one is active). If the built-in git extension is disabled, it falls back to the first workspace folder's repo. Review state is per-branch and lives in the shared `.git`, so it travels with a branch across worktrees.

### File status letters

Files carry `M`/`A`/`D` letters and colors like the CHANGES view — computed relative to `merge-base(baseBranch, HEAD)`, not HEAD, so committed changes still show. Untracked files are included. Renames are not detected (`--no-renames`).

## Manual test script

1. In the dev host, open a repo with changes vs `main`. The panel lists them under Needs Review.
2. Click a file → diff is *merge base ↔ working tree*.
3. Click its `+` → it moves to Reviewed; status bar count updates.
4. Edit the file → it moves back to Needs Review, and its diff is now *last reviewed ↔ working tree* (only the new edit).
5. Revert the edit (undo + save) → content matches the snapshot again, file returns to Reviewed on its own.
6. Commit / rebase — review state is unaffected (content-based).
