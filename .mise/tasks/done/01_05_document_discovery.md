# 01_05 Document path convention and loader

## Goal

A vscode-free module locates the branch document and per-cluster notes documents by path convention, summarizes a notes document's sections, and the cluster skill documents the convention. Nothing is wired into the UI yet.

## Files to modify/create

- `src/documents.ts` (new)
- `plugin/skills/cluster/SKILL.md`

## Background

- Contract files live in `<git common dir>/delta-review/`; common dir from `git rev-parse --git-common-dir`, resolved against `git.repoRoot` when relative (pattern: `loadClustersContract`, `src/clusters.ts:591-622`; private `deltaReviewDir` in `src/notesStore.ts:47`). Branch sanitization: `sanitizeBranchForFilename` (`src/clusters.ts:222-223`). `Git` interface: `src/git.ts`.
- Design decisions (from goals and spec `## Hard-to-undo`):
  - Branch document: `<dir>/branch-<sanitized branch>.md` — the output of the owner's separate "plate" skill, labelled "Branch overview" in the UI.
  - Cluster notes: `<dir>/cluster-notes-<sanitized branch>/<slug>.md`, slug = cluster label lowercased, every run of characters outside `[a-z0-9]` replaced by one `-`, no trimming (`Clusters contract v4` → `clusters-contract-v4`). An empty slug means no document.
  - No contract key names a document; a document exists only when its file exists; absence is silent.
  - Renaming a cluster means renaming its notes file; dropping one deletes it. Notes documents are never committed, so a delete is unrecoverable: only when no remaining cluster maps to the old slug, and never rename onto an existing file.
  - A document note's file name must match `/^[a-z0-9-]+\.md$/` (used by later tasks as a traversal guard).
  - Summary for the row description: parts joined by ` · ` — `intro` when non-blank, non-heading text appears before the first `## ` heading (an `# ` title line does not count as text); then each `## ` heading lowercased, except a heading equal (case-insensitive, trimmed) to `Check` that contains list items becomes `<n> question` / `<n> questions`, counting lines in that section starting `- `, `* `, or `<digits>. ` (leading whitespace allowed). Empty string when nothing qualifies.

## Guides

- plugin/skills/cluster/SKILL.md (doc): the clusters contract file — read before changing cluster generation or its file format

## Implementation details

1. `src/documents.ts` exports:
   - `clusterSlug(label: string): string`
   - `branchDocumentFileName(branch: string): string`, `clusterNotesDirName(branch: string): string`
   - `CLUSTER_NOTES_FILE_PATTERN`
   - `deltaReviewDirFor(git: Git): Promise<string>`
   - `notesDocumentSummary(text: string): string`
   - `interface ClusterNotesDocument { path: string; fileName: string; summary: string }`, `interface ReviewDocuments { clusterNotesDir: string; branchDocument?: string; clusterNotes: Map<number, ClusterNotesDocument> }`
   - `loadReviewDocuments(dir: string, branch: string, labels: readonly string[]): Promise<ReviewDocuments>` — `clusterNotesDir` always set (absolute, may not exist); `branchDocument` set when the file is readable; `clusterNotes` keyed by cluster index for each label whose slug is non-empty and whose file is readable (summary from its text). Any read failure means absent; never throws for missing files.
2. `plugin/skills/cluster/SKILL.md` Contract: new "Documents" section — the two paths, the slug rule (must match the extension's `clusterSlug`), never committed, a row appears only when the file exists, the branch document is written by another skill (do not write it here), a cluster notes document's expected shape (`# <label>`, intro paragraph, `## Reading order` numbered list of files matching the cluster's `files` order, `## Check` list of questions for the reviewer), and "renaming a cluster renames its notes file; dropping a cluster deletes it", guarded: delete or rename the old slug's file only when no cluster in the new contract still maps to that slug (two labels can share one slug), and never rename onto an existing file (leave both files and tell the user instead). State that these files are never committed, so a delete is unrecoverable. Workflow: a step to write or refresh notes documents for clusters that warrant one, referencing the Contract section; step 3's label-stability bullet references the rename rule.

## Gotchas

- Do not describe review notes on documents here: document notes do not exist until task 01_07, which adds the rule for open notes on a renamed or deleted document to this same Documents section.
- Two clusters with the same label (or labels with the same slug) share one slug and therefore one document; acceptable, and the reason for the delete/rename guard in step 2.
- Read text as UTF-8; do not follow anything outside `dir`.
- No `vscode` import in `src/documents.ts`.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Write `src/documents.test.ts`: slug cases (spaces, punctuation runs, leading/trailing symbols kept as hyphens, uppercase, all-symbol label, empty); file and dir names with a `/` in the branch; pattern accepts slugs and rejects `../x.md`, `a/b.md`, `A.md`; summary cases (mock document → `intro · reading order · 3 questions`, no intro, Check with one item → `1 question`, Check without items → `check`, empty text); `loadReviewDocuments` against a temp dir with a branch doc, one present and one absent notes file, and an empty-slug label.
- Skill doc (no test covers it): reread the cluster skill's Documents section and confirm the delete/rename guard (no remaining cluster maps to the old slug; never rename onto an existing file) is stated once, in the Contract, and the workflow step references it.
