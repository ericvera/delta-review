---
name: cluster
description: >-
  Group the current branch's changed files into logical clusters for the
  Delta Review VS Code extension, declare the files moved or extracted in
  from elsewhere, and note individual files for the reviewer, by writing its
  clusters contract file. Use when the user asks to cluster, group, or
  organize the branch's changes for review, to record that a file was moved
  or ported in from another project, to record that a file was extracted
  from lines of another file, to add a reviewer note for a file, to generate
  or update Delta Review clusters, or at the end of a coding task when the
  user wants the change broken down for review. Requires a git repository
  with a feature branch.
---

# Cluster

Produce the clusters contract the Delta Review VS Code extension renders in its grouped view: a JSON file grouping the branch's changed files into named logical changes, plus the moves and extractions git cannot detect and a one-line note on any file that warrants one. You are the only writer; the extension is the only reader.

Two situations:

- **End of a task you performed** — use what you already know to name and group the clusters, to declare the moves and extractions you made, and to note what the reviewer should know per file.
- **Cold, on an existing branch** — infer the clusters from diff content (`git diff <merge-base>` and the untracked files), not file names. Infer no provenance: declare only the moves and extractions the user describes, and preserve the declarations and notes already in the file.

## Contract

Binding for every consumer of this file, whatever workflow is driving.

### File location

Work from the repo root (`git rev-parse --show-toplevel`, `cd` there — `git rev-parse --git-common-dir` can return a relative path).

```bash
COMMON_DIR=$(git rev-parse --git-common-dir)   # may be relative (".git") — resolve against the repo root
BRANCH=$(git rev-parse --abbrev-ref HEAD)
```

Sanitize the branch with `[^A-Za-z0-9._-]` → `-` (`feature/x` → `feature-x`; must match the extension's `sanitizeBranchForFilename`). Contract path: `<COMMON_DIR>/delta-review/clusters-<sanitized-branch>.json`; `mkdir -p` the directory.

Never commit, stage, or push the contract. It lives under the git directory, invisible to `git status`, and must stay that way.

### Schema (version 3)

```json
{
  "version": 3,
  "clusters": [
    {
      "label": "Rename fetchUser → getUser",
      "summary": "Mechanical rename across call sites",
      "files": ["src/api.ts", "src/users.ts"],
      "patterns": ["**/*.test.ts"]
    }
  ],
  "moves": [
    {
      "path": "src/vendor/reporter.ts",
      "from": "../donor-app/src/telemetry/reporter.ts",
      "origin": "external",
      "donor": "donor-app",
      "baseBlob": "1f0acb2d9f4e7c3b6a58d0e19b7c4f2a3d5e6b78",
      "note": "Swapped its logger for ours"
    },
    {
      "path": "src/new/config.ts",
      "from": "src/old/config.ts",
      "origin": "repo",
      "fromLines": [[120, 180]],
      "baseBlob": "9c3d51a0e7b48f26d1a9c05b3e7f84d2610b9ac4"
    }
  ],
  "notes": {
    "src/new/config.ts": "Extracted verbatim; only the import block changed"
  }
}
```

**One malformed entry, cluster or move, rejects the whole file** — the reviewer loses clustering _and_ every declaration, and sees a warning. Validate before renaming into place.

- `version` — write exactly the integer `3` (the extension also accepts `1` and `2`; anything else rejects the file).
- `clusters` — an array; each entry an object with string `label` and string `summary`.
- `files`, `patterns` — when present, arrays of strings. Each cluster needs at least one of the two non-empty.
- `moves` — optional; when present, an array of objects.
- `path`, `from` — required, non-empty strings.
- `origin` — required, exactly `"repo"` (elsewhere in this repo) or `"external"` (another project).
- `donor` — optional, non-empty string.
- `baseBlob` — optional, a 40- or 64-character lowercase hex object id. On an `external` entry it holds the whole donor file; on a `repo` entry, the lines `fromLines` declares, concatenated in declared order — or, with no `fromLines`, whatever content the file came from.
- `fromLines` — optional: a non-empty array of 1-based inclusive `[start, end]` integer pairs into the origin, ascending and non-overlapping (each `start` greater than the previous `end`).
- `note` — optional string.
- `notes` — optional top-level object mapping a repo-relative path to a one-line string. An empty-string value counts as no note.

Unknown keys are ignored. Accepted but silently dropped — costing you the declaration, not the file:

- `donor` on a `repo` entry, whatever its value.
- `fromLines` on an `external` entry, whatever its value.
- A `repo` entry whose `from` equals its `path`.
- A second entry for an already-declared `path` — first wins.
- An entry whose `path` is outside the extension's review set.
- A `notes` key naming a path outside the extension's review set.

### Which review set a move's `path` must name

The extension's own: `git diff --name-status --find-renames` — a detected rename's destination only, never its source — unioned with `git ls-files --others --exclude-standard`. A just-ported file is already in it as untracked, so never commit or stage first. Always name the file's current path.

### Declaring a move

Declare only on evidence: a move you performed in the invoking task, or one the user described. Never infer a donor origin from the diff — a ported file is indistinguishable from new code by inspection. A file you cannot account for stays an ordinary add.

**Named exception — preservation.** On any re-run, keep every existing `moves` entry whose `path` is still in the review set, changing it only as **Re-run relocation** under **Declaring an extraction** directs. A cold run cannot re-substantiate an origin it never saw.

- `donor` — always write it for an external origin. A project name, not a description; it competes with the origin path for the row's width.
- `baseBlob` — on an `external` entry, record the donor file's pre-move content with `git hash-object -w <donor file>` and store the printed id; a `repo` entry takes it from the merge base per **Declaring an extraction**. Unreadable donor (the common case on a cold run) → omit rather than guess: the diff then shows the whole file as an addition, and the row cannot say verbatim or adapted.
- `note` — prose about how the file was adapted, nothing else. **verbatim/adapted is not a contract field**; the extension computes it from content hashes.

No commit SHAs anywhere, and no blob id other than `moves[].baseBlob`. Everything in `clusters` must be derivable from the current diff on every run; `moves` and `notes` are the preserved exceptions, because neither provenance nor a reviewer's remark is recoverable from the diff.

### Declaring an extraction

A repo move whose destination came from a line region of its origin also carries `fromLines`. Same evidence rule as a move above: an extraction you performed in the invoking task, or one the user described.

Write `fromLines` and `baseBlob` together: `fromLines` alone is unverifiable — the extension slices it but can never confirm the content — while `baseBlob` alone stays a valid base without a line pointer.

Compute `baseBlob` from the merge base, never the working tree (`MERGE_BASE` is the merge base with the base branch, computed in workflow step 2):

```bash
git show "${MERGE_BASE}:<origin>" | sed -n '<start>,<end>p' | git hash-object -w --stdin
```

Several ranges: concatenate their slices in declared order, then hash the concatenation once. This pipeline is byte-exact — `sed -n` keeps a missing final newline. Never substitute `awk`, which appends one. Keep the braces: with a bare `$MERGE_BASE`, zsh reads the `:` and the origin path's first letter as a history modifier (`:s`, `:h`, `:e`, …) and the pipeline hashes the empty blob.

**Re-run relocation.** For every preserved repo move that has `fromLines`, re-slice at the current merge base and compare to `baseBlob`:

- Equal → no change.
- Different → search the origin's current merge-base content for the blob's content, byte-exact, starting at a line start and ending at a line end or at end of content; rewrite `fromLines` to where it now sits.
- Not found → drop `fromLines`, keep `baseBlob`.

An entry with `fromLines` but no readable `baseBlob` (absent, or an object git cannot read) takes `baseBlob` from the current slice when the declared lines are in range, and loses `fromLines` when they are not.

Relocation re-finds content already substantiated; it is not inferred provenance.

### Notes

`notes` carries one line per file for the reviewer, separate from a move's `note`.

- Write an entry for a file that warrants a one-line remark.
- On a cold re-run, preserve existing entries unchanged.
- At the end of a task, the entry of a file that task touched may be rewritten.
- Drop an entry whose path has left the review set.

### Conventions the extension does not reject — it fails silently

- `files` entries and a move's `path` — repo-relative and `/`-separated, as `git diff --name-only` prints them. An absolute or `\`-separated path parses fine and then never matches: the file lands in "Unclustered", or you lose the declaration.
- `patterns` — picomatch globs; one that fails to compile is ignored. Use them **only** for glob-shaped catch-alls (`**/*.test.ts`, `docs/**`) and list everything else in `files`.
- A move's `from` — `/`-separated; repo-relative for `origin: "repo"`, otherwise whatever names the file in the donor project. A repo `from` naming no path at the merge base silently costs the origin's base content.

### Write rules

Write atomically: a temporary file in the same `delta-review` directory, then rename it over `clusters-<sanitized-branch>.json`. The extension watches the directory and may read mid-write.

### Membership resolution

Explicit `files` beat `patterns`; the first cluster in contract order that claims a file wins; files matched by nothing render prominently under "Unclustered"; auto-triaged files (lockfiles, generated code per the user's extension settings) go to a separate Auto bucket regardless of the contract.

### Schema changes

Any further change requires bumping `version` and updating the extension's parser (`src/clusters.ts` in the delta-review repo) in the same commit.

## Default workflow: clustering the branch

### 1. Resolve the repo root and base branch

Work from the repo root per the Contract. Read `deltaReview.baseBranch` from `.vscode/settings.json` at the repo root; absent file or key → `main`. It is JSONC, so read it as text rather than assuming strict `JSON.parse`/`jq` succeeds.

The extension reads the _merged_ VS Code configuration, so a `deltaReview.baseBranch` set in user-scope settings is invisible here. If clusters look computed against the wrong base, ask the user to set it in the workspace's `.vscode/settings.json`.

### 2. Compute the review set

```bash
MERGE_BASE=$(git merge-base <base> HEAD)
git diff --name-only --no-renames -z "$MERGE_BASE"   # changed vs merge base, including committed changes and deletions
git ls-files --others --exclude-standard -z          # untracked files
```

Union both lists, deduplicated. Do not filter further — deleted files belong to clusters too. Do not read `deltaReview.autoReview.globs` or replicate the extension's auto-triage; that is extension-side and orthogonal.

`--no-renames` makes this a **superset** of the extension's set: it lists a rename's old and new path, the extension only the new. Harmless for `files`, fatal for a move's `path` — see the Contract.

### 3. Read the existing contract first

If it exists, treat it as the baseline:

- **Keep cluster labels and identity stable** — reviewers have collapse state and mental context attached to them. Do not rename or reorder gratuitously.
- Place new or previously-unclustered files into the existing cluster they belong to, or a new one if they are a new logical change.
- Drop `files` entries no longer in the review set. Carry `moves` and `notes` entries forward per the preservation rules in **Declaring a move** and **Notes**.
- Run the re-run relocation rule in **Declaring an extraction** before declaring anything new.
- Refresh a `label`/`summary` only where the meaning of the change actually shifted.

### 4. Declare moves and extractions

Add new `moves` entries per **Declaring a move** and **Declaring an extraction**, on top of the entries preserved in step 3.

### 5. Write notes

Fill `notes` per the Contract's **Notes** section, on top of the entries preserved in step 3.

### 6. Cluster the files

Group the review set into named logical changes, each with a one-line `summary`.

Clusters tell the narrative of the change — "Rename fetchUser → getUser", "New caching layer", "Fix off-by-one in pagination" — **not** the directory structure. A cluster spanning `src/`, its tests, and a doc update is one cluster, not three.

- Every changed file should be claimed by a cluster unless it genuinely belongs to no logical change.
- Never invent a junk-drawer cluster ("Misc", "Other"). Unclaimed files surface as "Unclustered" — that is the scope-creep detector, and hiding them defeats it.
- `label` — target **≤ 40 characters**, **50 is a hard cap**. It gets about 34 characters of a default sidebar and truncates from the right, so put the distinguishing words first and move any further detail into `summary`, which renders as a tooltip and is effectively unbounded.

### 7. Write and report

Write per the Contract, then tell the user the cluster labels, file counts, any moves you declared, any extractions (path, origin, lines), any notes you wrote, and any files you left unclustered (and why).
