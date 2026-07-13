# Delta Review

Incremental local code review for VS Code. Mark files as reviewed while you work through a branch; when a reviewed file changes again, you see only the **delta since you last reviewed it** — not the whole diff from scratch.

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
git ls-tree -r refs/review/<branch>   # what's marked reviewed (path -> snapshot blob)
git log refs/review/<branch>          # review session history
git update-ref -d refs/review/<branch>  # nuke state for a branch (or use the command)
```

## Usage

The **Delta Review** panel lives in the Source Control sidebar:

- Files changed vs `merge-base(baseBranch, HEAD)` — plus untracked files — appear under **Needs Review** / **Reviewed**.
- Click a file to open its review diff.
- Hover a row and click `+` to mark it reviewed, `−` to unmark (same gesture as
  staging in the CHANGES view). Group headers have `+`/`−` for mark/unmark all;
  in tree mode folders have them too, applying to everything inside.
- The Source Control icon shows a badge with the number of files left to review.
- Files carry `M`/`A`/`D` letters and colors like the CHANGES view — relative to
  the merge base, not HEAD (so committed changes still show).
- Toolbar: view as tree/list, refresh. Command palette: `Delta Review: Clear Review State`.
- Status bar shows progress (`Review 7/23`); click it to focus the panel.

Set the base branch via `deltaReview.baseBranch` (default `main`).

### Multiple repositories and worktrees

Delta Review follows the repository selected in the Source Control view — the
same selection that drives the built-in CHANGES panel. Switching to another
repository or git worktree in the Repositories section retargets the review
set to that checkout (the panel header shows which one is active). Review
state is per-branch and lives in the shared `.git`, so it travels with a
branch across worktrees.

## Development

```bash
yarn install
yarn build     # or: yarn watch
```

Open this folder in VS Code and press **F5** ("Run Extension"). An Extension Development Host window opens with the extension loaded — open any git repo with a feature branch in it and start reviewing.

### Manual test script

1. In the dev host, open a repo with changes vs `main`. The panel lists them under Needs Review.
2. Click a file → diff is *merge base ↔ working tree*.
3. Click its `+` → it moves to Reviewed; status bar count updates.
4. Edit the file → it moves back to Needs Review, and its diff is now *last reviewed ↔ working tree* (only the new edit).
5. Revert the edit (undo + save) → content matches the snapshot again, file returns to Reviewed on its own.
6. Commit / rebase — review state is unaffected (content-based).

## Install for daily use

```bash
yarn install-ext
```

Builds, packages (`delta-review.vsix`), and installs into VS Code in one step —
run it again after any change to update. Reload open windows (**Developer:
Reload Window**) to pick up the new version. `yarn package` produces the
`.vsix` without installing, e.g. to share it.

## Known limitations (MVP)

- File-level marking only (no per-hunk review state).
- Renames show as delete + add (`--no-renames`).
- Binary files diff as raw text.
- One active repository at a time (the one selected in Source Control); if the
  built-in git extension is disabled, falls back to the first workspace folder's repo.
