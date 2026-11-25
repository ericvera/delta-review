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
  user wants the change broken down for review, or when the user or a
  calling skill supplies its own rules for grouping, file order, review
  levels, notes or notes documents (`/delta:cluster <guidance>`). Requires a
  git repository with a feature branch.
---

# Cluster

Produce the clusters contract the Delta Review VS Code extension renders in its grouped view: a JSON file grouping the branch's changed files into named logical changes, plus the moves and extractions git cannot detect and a one-line note on any file that warrants one. You are the only writer; the extension is the only reader.

Two situations:

- **End of a task you performed** — use what you already know to name and group the clusters, to declare the moves and extractions you made, and to note what the reviewer should know per file.
- **Cold, on an existing branch** — infer the clusters from diff content (`git diff <merge-base>` and the untracked files), not file names. Infer no provenance: declare only the moves and extractions the user describes, and keep the preserved exceptions listed under **Declaring a move**.

## Contract

Binding for every consumer of this file, whatever workflow or guidance is driving.

### File location

Work from the repo root (`git rev-parse --show-toplevel`, `cd` there — `git rev-parse --git-common-dir` can return a relative path).

```bash
COMMON_DIR=$(git rev-parse --git-common-dir)   # may be relative (".git") — resolve against the repo root
BRANCH=$(git rev-parse --abbrev-ref HEAD)
```

Sanitize the branch with `[^A-Za-z0-9._-]` → `-` (`feature/x` → `feature-x`; must match the extension's `sanitizeBranchForFilename`). Contract path: `<COMMON_DIR>/delta-review/clusters-<sanitized-branch>.json`; `mkdir -p` the directory.

Never commit, stage, or push the contract. It lives under the git directory, invisible to `git status`, and must stay that way.

### Diff base

The review set is computed against a per-branch base, shared by every worktree on the branch.

Contract file: `<COMMON_DIR>/delta-review/base-<sanitized-branch>.json`, sanitized as in **File location**. Never committed, like the clusters file.

```json
{ "version": 1, "branch": "feature/x", "base": "feature/parent" }
```

- `branch` (required, non-empty): the owning branch's full name, without a leading `heads/`. Sanitization maps `feature/x` and `feature-x` to one file, so a file whose `branch` differs from the current branch is ignored (treated as absent).
- `base` (required, non-empty): any ref `git rev-parse` resolves.
- Writers: the extension's picker, and any agent that creates or drives a branch and knows its parent.
- Set: `mkdir -p` the directory, write a temp file in it, then `mv` it over the target. Writing overwrites a file owned by another branch.
- Clear: delete the file.
- Invalid (bad JSON, `version` other than 1, missing or empty `branch` or `base`): ignored.
- Resolution order: explicit file → detected → fallback (`deltaReview.baseBranch`, default `main`). On the fallback branch itself, and on a detached HEAD, detection is skipped.
- Detection limitations — write the file instead of relying on detection when: the branch has no reflog (a child branch can win; a brand-new branch picks a farther ancestor until its first commit); every own commit a child branch holds is older than the branch's 32 newest; another branch was created at a commit this branch only fast-forwarded or reset to; several candidates share a commit and none is the branch's creation source.
- The fallback is read from `.vscode/settings.json` (JSONC, read as text). The extension reads the merged VS Code configuration, so a `deltaReview.baseBranch` set in user-scope settings is invisible here; if the base looks wrong, ask the user to set it in the workspace's `.vscode/settings.json`.

This prints the resolved base exactly as the extension computes it (bash 3.2 or zsh; detection needs git >= 2.41 for `%(ahead-behind:…)`). A printed explicit base that does not resolve is an error: stop and ask the user.

```bash
cd "$(git rev-parse --show-toplevel)"
COMMON_DIR=$(git rev-parse --git-common-dir)
BRANCH=$(git rev-parse --abbrev-ref HEAD); BRANCH=${BRANCH#heads/}
FALLBACK=$(cat .vscode/settings.json 2>/dev/null | tr -d '\n' | grep -o '"deltaReview\.baseBranch"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
FALLBACK=${FALLBACK:-main}
BASE=
BASE_FILE="$COMMON_DIR/delta-review/base-$(printf '%s' "$BRANCH" | sed 's/[^A-Za-z0-9._-]/-/g').json"
if [ "$BRANCH" != HEAD ] && [ -f "$BASE_FILE" ]; then
  FILE_JSON=$(tr -d '\n' < "$BASE_FILE")
  FILE_BRANCH=$(printf '%s' "$FILE_JSON" | grep -o '"branch"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
  FILE_BASE=$(printf '%s' "$FILE_JSON" | grep -o '"base"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
  if printf '%s' "$FILE_JSON" | grep -q '"version"[[:space:]]*:[[:space:]]*1[[:space:]]*[,}]' &&
    [ "$FILE_BRANCH" = "$BRANCH" ] && [ -n "$FILE_BASE" ]; then
    BASE=$FILE_BASE
  fi
fi
if [ -z "$BASE" ] && [ "$BRANCH" != HEAD ] && [ "$BRANCH" != "$FALLBACK" ]; then
  HEAD_SHA=$(git rev-parse HEAD)
  TOTAL=$(git rev-list --count HEAD)
  REFLOG=$(git reflog show --format='%H %gs' "refs/heads/$BRANCH" -- 2>/dev/null)
  CREATED_FROM=$(printf '%s\n' "$REFLOG" | awk 'NF { last = $0 }
    END { if (sub(/^[^ ]* branch: Created from /, "", last) && last != "") {
      sub(/^refs\/heads\//, "", last); if (last != "HEAD") print last } }')
  UNMOVED=$(printf '%s\n' "$REFLOG" | awk -v head="$HEAD_SHA" 'NF { n++; last = $0 }
    END { print (n == 1 && last ~ /^[^ ]* branch: Created from ./ && substr(last, 1, index(last, " ") - 1) == head) ? 1 : 0 }')
  OWN=$(printf '%s\n' "$REFLOG" | awk 'NF { n++; line[n] = $0 }
    END { for (i = 1; i <= n; i++) {
      sp = index(line[i], " "); sha = sp ? substr(line[i], 1, sp - 1) : line[i]; subj = sp ? substr(line[i], sp + 1) : ""
      if (i == n && subj ~ /^branch: Created from ./) continue
      if (subj ~ /\(finish\): .* onto [0-9a-f]+$/) { onto = subj; sub(/.* onto /, "", onto); if (onto == sha) continue }
      if ((subj ~ /^(commit|cherry-pick|revert|rebase)/ || (subj ~ /^(merge|pull)/ && index(subj, "Fast-forward") == 0)) && !seen[sha]++) print sha
    } }')
  CONTAINING=
  if [ -n "$OWN" ]; then
    CONTAINING=$(git for-each-ref --format='%(refname:lstrip=2)' $(printf '%s\n' "$OWN" | head -n 32 | sed 's/^/--contains=/') refs/heads | tr '\n' ' ')
  fi
  BASE=$(git for-each-ref --format='%(refname:lstrip=2) %(objectname) %(ahead-behind:HEAD)' refs/heads |
    awk -v cur="$BRANCH" -v total="$TOTAL" -v unmoved="$UNMOVED" -v fb="$FALLBACK" -v cref="$CREATED_FROM" -v containing="$CONTAINING" '
      BEGIN { n = split(containing, c, " "); for (i = 1; i <= n; i++) held[c[i]] = 1 }
      NF >= 4 && $1 != cur {
        behind = $NF + 0
        if (behind == total + 0 || (behind == 0 && unmoved != 1) || (($1 in held) && $1 != fb)) next
        rank = $1 == fb ? 0 : ($1 == cref ? 1 : 2)
        if (!found || behind < best_d || (behind == best_d && rank < best_r)) { found = 1; best = $1; best_d = behind; best_r = rank }
      }
      END { if (found) print best }')
  if [ -z "$BASE" ]; then
    UPSTREAM=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null)
    case "$UPSTREAM" in
      "" | */"$BRANCH") ;;
      *) git merge-base "$UPSTREAM" HEAD > /dev/null 2>&1 && BASE=$UPSTREAM ;;
    esac
  fi
fi
BASE=${BASE:-$FALLBACK}
echo "$BASE"
```

### Schema (version 4)

```json
{
  "version": 4,
  "clusters": [
    {
      "label": "Rename fetchUser → getUser",
      "summary": "Mechanical rename across call sites",
      "files": ["src/api.ts", "src/users.ts"],
      "patterns": ["**/*.test.ts"],
      "wait": true
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
    "src/new/config.ts": "Extracted verbatim; only the import block changed",
    "src/cache/store.ts": [
      "New LRU store backing the cache layer",
      {
        "text": "Eviction runs before the size check on purpose",
        "lines": [42, 51]
      }
    ]
  },
  "levels": {
    "src/cache/store.test.ts": "skim"
  },
  "waitPaths": ["src/cache", "src/api.ts"]
}
```

**One malformed entry, cluster or move, rejects the whole file** — the reviewer loses clustering _and_ every declaration, and sees a warning. Validate before renaming into place.

- `version` — write `4` when any `notes` value is an array (holds a ranged item), else `3`; `levels` alone never bumps it. The extension accepts `1`-`4`; anything else rejects the file. The example is version 4 because it carries a ranged note.
- `clusters` — an array; each entry an object with string `label` and string `summary`.
- `files`, `patterns` — when present, arrays of strings. Each cluster needs at least one of the two non-empty.
- `wait` — optional boolean on a cluster; `true` means you still expect it to change, and the reviewer sees it muted. Any non-boolean value rejects the file. See workflow step 6.
- `waitPaths` — optional top-level array of repo-relative file or directory paths you still expect to change; a directory entry covers every file under it. A non-array or any non-string entry rejects the file. See workflow step 6.
- `moves` — optional; when present, an array of objects.
- `path`, `from` — required, non-empty strings.
- `origin` — required, exactly `"repo"` (elsewhere in this repo) or `"external"` (another project).
- `donor` — optional, non-empty string.
- `baseBlob` — optional, a 40- or 64-character lowercase hex object id. On an `external` entry it holds the whole donor file; on a `repo` entry, the lines `fromLines` declares, concatenated in declared order — or, with no `fromLines`, whatever content the file came from.
- `fromLines` — optional: a non-empty array of 1-based inclusive `[start, end]` integer pairs into the origin, ascending and non-overlapping (each `start` greater than the previous `end`).
- `note` — optional string.
- `notes` — optional top-level object mapping a repo-relative path to a one-line string. An empty-string value counts as no note.
- A `notes` value may instead be an array (version 4 only — a lower version rejects it); write one only when it holds a ranged item. Each item is a string (file-level; several join with one space) or `{ "text": string, "lines": [start, end] }`, a remark on the current file's 1-based inclusive lines, integers with `1 <= start <= end`. Any other item or `lines` shape rejects the file; an empty string or empty `text` counts as no note.
- `levels` — optional top-level object mapping a repo-relative path to `"review"` or `"skim"`, at any version. A non-object, or any other value, rejects the file. See **Review levels** and workflow step 5.

Unknown keys are ignored. Accepted but silently dropped — costing you the declaration, not the file:

- `donor` on a `repo` entry, whatever its value.
- `fromLines` on an `external` entry, whatever its value.
- A `repo` entry whose `from` equals its `path`.
- A second entry for an already-declared `path` — first wins.
- An entry whose `path` is outside the extension's review set.
- A `notes` or `levels` key naming a path outside the extension's review set.
- A `waitPaths` entry covering no clustered file in the review set (Unclustered and Auto files never show as waiting).

### Which review set a move's `path` must name

The extension's own: `git diff --name-status --find-renames` — a detected rename's destination only, never its source — unioned with `git ls-files --others --exclude-standard`. A just-ported file is already in it as untracked, so never commit or stage first. Always name the file's current path.

### Declaring a move

Declare only on evidence: a move you performed in the invoking task, or one the user described. Never infer a donor origin from the diff — a ported file is indistinguishable from new code by inspection. A file you cannot account for stays an ordinary add.

**Named exception — preservation.** On any re-run, keep every existing `moves` entry whose `path` is still in the review set, changing it only as **Re-run relocation** under **Declaring an extraction** directs. A cold run cannot re-substantiate an origin it never saw.

- `donor` — always write it for an external origin. A project name, not a description; it competes with the origin path for the row's width.
- `baseBlob` — on an `external` entry, record the donor file's pre-move content with `git hash-object -w <donor file>` and store the printed id; a `repo` entry takes it from the merge base per **Declaring an extraction**. Unreadable donor (the common case on a cold run) → omit rather than guess: the diff then shows the whole file as an addition, and the row cannot say verbatim or adapted.
- `note` — prose about how the file was adapted, nothing else. **verbatim/adapted/unchanged is not a contract field**; the extension computes it from content hashes.

No commit SHAs anywhere, and no blob id other than `moves[].baseBlob`. Everything in `clusters` must be derivable from the current diff on every run; `moves`, `notes`, `levels`, a cluster's `wait`, and `waitPaths` are the preserved exceptions, because neither provenance, a reviewer's remark, nor the agent's intent is recoverable from the diff.

### Declaring an extraction

A repo move whose destination came from a line region of its origin also carries `fromLines`. Same evidence rule as a move above: an extraction you performed in the invoking task, or one the user described.

Write `fromLines` and `baseBlob` together: `fromLines` alone is unverifiable — the extension slices it but can never confirm the content — while `baseBlob` alone stays a valid base without a line pointer.

Compute `baseBlob` from the merge base, never the working tree (`MERGE_BASE` is the merge base with the branch's diff base, computed in workflow step 2):

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

- A remark about specific lines is a ranged item; a remark about the whole file is a file-level string. Keep a value with no ranged item a single string.
- Drop an entry whose path has left the review set.
- Ranged items: the extension cannot re-anchor them (it only clamps). On every re-run, cold or end-of-task, re-read the file and move each item's `lines` to where the remarked code now is, or drop the item when that code is gone. Re-check ranges in files the task touched; do not merely allow them to change.
- Dropping a value's last ranged item turns it back into a string, or removes it when nothing is left; apply the `version` rule afterwards (it may fall to `3`).

### Review levels

- Omit `review`; it is the default.
- Drop an entry whose path has left the review set.

### Documents

Markdown documents beside the contract, in `<COMMON_DIR>/delta-review/`. No contract key names one; a document's row appears only while its file exists, and absence is silent. Never commit, stage, or push them: they live under the git directory, so a delete is unrecoverable.

- Branch document — `branch-<sanitized-branch>.md`, written by another skill; never write it here.
- Cluster notes document — `cluster-notes-<sanitized-branch>/<slug>.md`. Slug: the cluster's `label` lowercased, every run of characters outside `[a-z0-9]` replaced by one `-`, no trimming (`Clusters contract v4` → `clusters-contract-v4`); must match the extension's `clusterSlug`. An empty slug has no document. Labels sharing a slug share one document.
- Renaming a cluster renames its notes file; dropping a cluster deletes it. Rename or delete the old slug's file only when no cluster in the new contract still maps to that slug. Never rename onto an existing file: leave both files and tell the user. Before renaming or deleting a notes file, reply through the `delta:review-notes` responses file to every open or pending review note whose `document` is `"clusterNotes"` and whose `file` is that file's name: say what the note's concern became and, on a rename, the new file name. The notes file is extension-owned; never re-home a note's `file`.

### Conventions the extension does not reject — it fails silently

- `files` entries and a move's `path` — repo-relative and `/`-separated, as `git diff --name-only` prints them. An absolute or `\`-separated path parses fine and then never matches: the file lands in "Unclustered", or you lose the declaration.
- `waitPaths` entries — repo-relative and `/`-separated like `files`; an absolute or `\`-separated entry never matches.
- `patterns` — picomatch globs; one that fails to compile is ignored. Use them **only** for glob-shaped catch-alls (`**/*.test.ts`, `docs/**`) and list everything else in `files`.
- A move's `from` — `/`-separated; repo-relative for `origin: "repo"`, otherwise whatever names the file in the donor project. A repo `from` naming no path at the merge base silently costs the origin's base content.

### Write rules

Write atomically: a temporary file in the same `delta-review` directory, then rename it over `clusters-<sanitized-branch>.json`. The extension watches the directory and may read mid-write.

### Membership resolution

Explicit `files` beat `patterns`; the first cluster in contract order that claims a file wins; files matched by nothing render prominently under "Unclustered"; auto-triaged files (lockfiles, generated code per the user's extension settings) go to a separate Auto bucket regardless of the contract.

A cluster's `files` order is the reading order the sidebar's list mode shows: explicit members in `files` order, then pattern-only members alphabetically. Tree mode stays alphabetical.

### Schema changes

Any further change requires bumping `version` and updating the extension's parser (`src/clusters.ts` in the delta-review repo) in the same commit — except a new optional key an older extension can safely ignore (like `wait`), which keeps the version.

## Default workflow: clustering the branch

The default when clustering the branch. Guidance from `/delta:cluster` arguments, the user's message, or a calling skill's instructions replaces any step or rule here it addresses; user over calling skill over this workflow. Where guidance is silent, this workflow applies. The Contract binds regardless.

### 1. Resolve the repo root and base

Work from the repo root per the Contract. Resolve the base per **Diff base**.

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

- **Keep cluster labels and identity stable** — reviewers have collapse state and mental context attached to them. Do not rename or reorder gratuitously. A rename moves its notes document per **Documents**.
- Place new or previously-unclustered files into the existing cluster they belong to, or a new one if they are a new logical change.
- Drop `files` entries no longer in the review set. Carry `moves` forward per the preservation rule in **Declaring a move**, `notes` and `levels` per step 5, and `wait` and `waitPaths` per step 6.
- Run the re-run relocation rule in **Declaring an extraction** before declaring anything new.
- Refresh a `label`/`summary` only where the meaning of the change actually shifted.

### 4. Declare moves and extractions

Add new `moves` entries per **Declaring a move** and **Declaring an extraction**, on top of the entries preserved in step 3.

### 5. Write notes

Fill `notes` and `levels` on top of the entries preserved in step 3, encoded and maintained per the Contract's **Notes** and **Review levels**. Set `version` per the Contract.

- Write a `notes` entry for a file that warrants a one-line remark.
- On a cold re-run, preserve existing file-level strings and ranged items' `text` unchanged.
- At the end of a task, the entry of a file that task touched may be rewritten.
- Mark `skim` a file the reviewer need not read line by line: tests mirroring code, mechanical edits, docs.
- On a cold re-run, preserve existing `levels` entries.

### 6. Cluster the files

Group the review set into named logical changes, each with a one-line `summary`.

Clusters tell the narrative of the change — "Rename fetchUser → getUser", "New caching layer", "Fix off-by-one in pagination" — **not** the directory structure. A cluster spanning `src/`, its tests, and a doc update is one cluster, not three.

- Every changed file should be claimed by a cluster unless it genuinely belongs to no logical change.
- Never invent a junk-drawer cluster ("Misc", "Other"). Unclaimed files surface as "Unclustered" — that is the scope-creep detector, and hiding them defeats it.
- List each cluster's `files` in the order a reviewer should read them, per **Membership resolution**.
- Set `wait: true` on a cluster you still expect to change; clear it once the cluster is settled or plans change.
- On a cold re-run, keep an existing `wait` only on a cluster whose label survives. A cold run sets no new `wait`.
- List a file or directory in `waitPaths` when only part of a cluster is still expected to change; use the cluster's `wait` when all of it is. Remove an entry once that path is settled.
- On a cold re-run, keep a `waitPaths` entry only while it still covers a file in the review set. A cold run adds no entry.
- `label` — target **≤ 40 characters**, **50 is a hard cap**. It gets about 34 characters of a default sidebar and truncates from the right, so put the distinguishing words first and move any further detail into `summary`, which renders as a tooltip and is effectively unbounded.

### 7. Write notes documents

Write or refresh a cluster notes document for each cluster that warrants one, and rename or delete documents of renamed or dropped clusters — replying first to their open review notes — per **Documents**.

- Default shape: `# <label>`; an intro paragraph; `## Reading order`, a numbered list of the cluster's files in its `files` order; `## Check`, a list of questions for the reviewer.
- Under guidance that addresses notes documents, the document is `# <label>` followed only by the sections the guidance asks for; `## Reading order` and `## Check` appear only if requested. Guidance asking for no sections means no document is written or refreshed for that cluster; an existing one is left unchanged, and **Documents**' rename/delete rules still apply.

### 8. Write and report

Write per the Contract, then tell the user the cluster labels, file counts, any moves you declared, any extractions (path, origin, lines), any notes you wrote, the files marked `skim`, the clusters flagged `wait` and the paths in `waitPaths`, the notes documents written, renamed, or deleted (and any rename left undone), and any files you left unclustered (and why). This report applies under guidance unless the guidance says otherwise.
