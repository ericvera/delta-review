---
name: cluster-review
description: >-
  Group the current branch's changed files into logical clusters for the
  Delta Review VS Code extension by writing its clusters contract file. Use
  when the user asks to cluster, group, or organize the branch's changes for
  review, to generate or update Delta Review clusters, or at the end of a
  coding task when the user wants the change broken down for review. Requires
  a git repository with a feature branch.
---

# Cluster Review

Produce the clusters contract that the Delta Review VS Code extension renders in its grouped view: a JSON file grouping the branch's changed files into named logical changes. You are the writer; the extension is the only reader.

You may be invoked in two situations, and the output is the same either way:

- **End of a task you performed**: you already know what the change means — use that knowledge directly to name and group the clusters.
- **Cold, on an existing branch**: infer the logical changes by reading the diff content (`git diff <merge-base>` and the untracked files), not just the file names.

## Contract schema (version 1)

```json
{
  "version": 1,
  "clusters": [
    {
      "label": "Rename fetchUser → getUser",
      "summary": "Mechanical rename across call sites",
      "files": ["src/api.ts", "src/users.ts"],
      "patterns": ["**/*.test.ts"]
    }
  ]
}
```

Rules the extension validates (a violating file is rejected and shown as a warning):

- `version` must be exactly the integer `1`.
- `clusters` must be an array; each cluster must have string `label` and string `summary`.
- Each cluster must have **at least one non-empty array among `files` and `patterns`** (either key may be omitted or empty as long as the other has entries).
- `files` entries are repo-relative, `/`-separated paths (as printed by `git diff --name-only`). Never absolute paths, never `\` separators.
- `patterns` entries are picomatch globs. Use them **only** for genuinely glob-shaped catch-alls — tests, docs, generated output (e.g. `**/*.test.ts`, `docs/**`). List everything else explicitly in `files`.
- No commit or blob SHAs anywhere in the file. Derive everything from the current diff on every run — the contract carries no bookkeeping.

If you ever need to change this schema, you must bump `version` and update the extension's parser (`src/clusters.ts` in the delta-review repo) in the same commit; the extension rejects any version other than 1.

How the extension resolves membership (so you can predict what renders): explicit `files` listings beat `patterns` matches; the first cluster (in contract order) that claims a file wins; files matched by nothing render prominently under "Unclustered"; auto-triaged files (lockfiles, generated code per the user's extension settings) render in a separate Auto bucket regardless of what the contract says.

## Steps

### 1. Resolve the repo root and base branch

Work from the repository root: `git rev-parse --show-toplevel`, and `cd` there (later steps use repo-relative paths, and `git rev-parse --git-common-dir` can return a relative path).

Read the base branch from `.vscode/settings.json` at the repo root: key `deltaReview.baseBranch`. If the file or key is absent, use `main`.

Known divergence: the extension reads the _merged_ VS Code configuration, so a `deltaReview.baseBranch` set in the user's personal (user-scope) settings is invisible to this skill. If clusters seem computed against the wrong base, ask the user to set the base branch in the workspace's `.vscode/settings.json`.

### 2. Compute the review set

Exactly as the extension does:

```bash
MERGE_BASE=$(git merge-base <base> HEAD)
git diff --name-only --no-renames -z "$MERGE_BASE"   # changed vs merge base (includes committed changes and deletions)
git ls-files --others --exclude-standard -z          # untracked files
```

The review set is the union of both lists, deduplicated. Do not filter it further — deleted files belong to clusters too. Do not read `deltaReview.autoReview.globs` or try to replicate the extension's auto-triage; that is extension-side and orthogonal to clustering.

### 3. Locate the contract file

```bash
COMMON_DIR=$(git rev-parse --git-common-dir)   # may be relative (".git") — resolve against the repo root
BRANCH=$(git rev-parse --abbrev-ref HEAD)
```

Sanitize the branch name for the filename: replace every character outside `[A-Za-z0-9._-]` with `-` (i.e. apply the regex `[^A-Za-z0-9._-]` → `-`; `feature/x` becomes `feature-x`). This rule must match the extension's `sanitizeBranchForFilename` exactly.

The contract path is `<COMMON_DIR>/delta-review/clusters-<sanitized-branch>.json`. Create the `delta-review` directory if it does not exist (`mkdir -p`).

### 4. Incremental re-run: read the existing contract first

If the contract file already exists, read it before clustering and treat it as the baseline:

- **Keep existing cluster labels and identity stable** — reviewers have collapse state and mental context attached to them. Do not rename or reorder clusters gratuitously.
- Place new or previously-unclustered files into the existing cluster they logically belong to, or into a new cluster if they are a new logical change.
- Drop files that are no longer in the review set (simply omit them; the extension ignores contract entries outside the review set anyway).
- Refresh a cluster's `label`/`summary` only where the meaning of the change actually shifted.
- Everything must still be derivable from the current diff — never carry state in the contract beyond the cluster definitions themselves.

### 5. Cluster the files

Group the review set into named logical changes, each with a one-line `summary`.

Quality bar: clusters tell the narrative of the change — "Rename fetchUser → getUser", "New caching layer", "Fix off-by-one in pagination" — **not** the directory structure. A cluster spanning `src/`, its tests, and a doc update is one cluster, not three.

- Every changed file should be claimed by a cluster unless it genuinely belongs to no logical change.
- Do **not** invent a junk-drawer cluster ("Misc", "Other") to absorb leftovers. Unclaimed files surface prominently as "Unclustered" in the extension — that is the scope-creep detector, and hiding files in a junk cluster defeats it.
- Use `patterns` only for glob-shaped catch-alls as described in the schema section.

### 6. Write the contract atomically

Serialize the contract JSON (with `"version": 1`) and write it atomically: write to a temporary file in the same `delta-review` directory, then rename it over `clusters-<sanitized-branch>.json`. The extension watches this directory and may read at any moment; a rename is atomic, a partial write is not.

Never commit or push the contract file, and never add it to the working tree or the index — it lives under the git directory (`.git/delta-review/`), invisible to `git status`, and must stay that way.

Finally, tell the user what you wrote: the cluster labels, file counts, and any files you left unclustered (and why).
