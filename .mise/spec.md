# Spec: cluster notes documents, branch overview, review levels, contract order, line-range agent notes

## What

- **Branch overview row**: when `<git common dir>/delta-review/branch-<sanitized branch>.md` exists, the DELTA REVIEW tree's first root row is "Branch overview" (book icon) in grouped and ungrouped mode, both layouts. Click opens the markdown preview. No review state.
- **Cluster notes row**: when `<git common dir>/delta-review/cluster-notes-<sanitized branch>/<slug>.md` exists for a real cluster, that cluster's first child is "Cluster notes" (note icon), description summarizing the document's sections (e.g. `intro · reading order · 3 questions`). Click opens the markdown source; an inline action opens the preview. No review state; it stays when the cluster is empty or fully reviewed. Never under Unclustered, Auto or Reviewed; absent in ungrouped mode.
- **Notes on a cluster notes document**: the reviewer selects lines in the opened source and adds a review note exactly as on code. The agent replies through the existing responses file. The note lists in REVIEW NOTES under `<cluster label> — notes`. The notes file gains a `document` key and version 2.
- **Review level per file**: clusters contract `levels` map (`"review"` default, `"skim"`), an optional key accepted at every version (no bump). A skim file's row description starts with `skim`, its tooltip gains a skim line, in every mode.
- **Contract order**: in list mode a cluster's needs-review files follow the cluster's `files` array order, then pattern-matched files in path order. Tree mode keeps folders-first alphabetical. Unclustered, Auto, Reviewed and ungrouped stay path-sorted.
- **Line-range agent notes**: clusters contract v4 `notes` values may carry `{ "text", "lines": [start, end] }` items. Each renders as a read-only thread spanning its range (widget under the last line) on the right-side document; the row tooltip counts them and lists their ranges. Plain-string notes keep today's file-level provenance thread.

## Design

### Clusters contract v4 (`src/clusters.ts`)

- Parser accepts versions 1-4; error text `(extension supports 1, 2, 3 and 4)`. `allowsExtraction` and `notes` parsing gate on `version >= 3` (today `=== 3`).
- `levels` (optional object, ungated like `waitPaths`: parsed and used at every version, since older extensions safely ignore the unknown key): path → `"review" | "skim"`; any other value or a non-object rejects the file (`"levels" must be an object`, `levels["<p>"] must be "review" or "skim"`).
- Version rule (cluster skill "Schema changes"): the skill writes `4` only when some `notes` value is an array (it writes an array only when it holds a ranged item), else `3`; `levels` alone stays version 3, so older extensions keep grouping and moves.
- `notes` at version 4: value is a string (file-level, as v3) or an array whose items are a string (file-level) or `{ "text": string, "lines": [start, end] }` (integers, `1 <= start <= end`). File-level strings of one path are joined with a single space into the existing file-level note; empty strings and empty-text items are dropped. Any other shape rejects the file. Version 3 keeps strings only.
- New types: `export type ReviewLevel = "review" | "skim"`; `export interface LineNote { lines: LineRange; text: string }`. `ClustersContract` gains `levels: Map<string, ReviewLevel>` (always present; empty when absent) and `lineNotes: Map<string, LineNote[]>` (always present; empty below v4).
- `resolveClusterModel`: a real cluster's bucket orders explicitly listed members by their index in that cluster's `files`, then pattern-matched members in input (path) order. Unclustered and Auto keep input order.

### Model (`src/model.ts`)

- `ReviewFile` gains `reviewLevel: ReviewLevel` (default `"review"`) and `lineNotes?: LineNote[]` (absent when none). `computeReviewModel` options gain `levels?: ReadonlyMap<string, ReviewLevel>` and `lineNotes?: ReadonlyMap<string, LineNote[]>`, keyed by current path like `notes`; `src/extension.ts` passes them from the contract on both computations.

### Rows

- `src/reviewLevel.ts` (new, pure): `withLevelTag(level, description)` → `skim` alone or `skim · <description>`; unchanged for `review`. `SKIM_TOOLTIP = "Skim — a glance is enough; the agent does not expect a line-by-line read."`.
- Tree-mode ordering: a pure `treeLevel(files, parentPath)` in `src/treeParents.ts` returns sorted folder names and path-sorted direct files; `ReviewTreeProvider.treeChildren` uses it (needed because buckets are no longer path-sorted).

### Agent line threads

- `src/provenance.ts`: `AgentLineNoteEntry { path; deleted; startLine; endLine; body }` from `agentLineNoteEntriesFor(model)` (body = escaped note text); `agentLineNotesTooltipLine(lineNotes)` → `<n> agent note(s) on lines: <ranges>` — `note` singular when n = 1, ranges `a–b` (en dash) or `a` when start = end, joined `, ` (e.g. `2 agent notes on lines: 486–491, 557–573`); undefined for none.
- `src/commentController.ts`: a third cache, separate from notes and provenance, keyed by `<path>\n<index>`; `renderAgentLineThreads(entries)`; thread on the provenance URI (working file, or the empty base document for a deleted file), range `start-1..end-1` clamped with `clampNoteRange` when the document is open, re-clamped in `reclampThreadsFor`; label `Agent note · lines a–b` (`line a` when equal); one comment, author `Claude`, no `contextValue`, `canReply = false`, expanded. Cleared with provenance when there is no repo. `agentLineThreads()` snapshot for `deltaReview.__inspect`.

### Documents (`src/documents.ts`, new; fs allowed, no vscode)

- `clusterSlug(label)`: lowercase, every run of characters outside `[a-z0-9]` → one `-`; no trimming. An empty slug means no document.
- `branchDocumentFileName(branch)` = `branch-<sanitized>.md`; `clusterNotesDirName(branch)` = `cluster-notes-<sanitized>`; sanitization is `sanitizeBranchForFilename`.
- `CLUSTER_NOTES_FILE_PATTERN = /^[a-z0-9-]+\.md$/` — the only file names a document note may carry.
- `deltaReviewDirFor(git)`: `<git common dir>/delta-review`, common dir resolved against the repo root when relative.
- `notesDocumentSummary(text)`: parts joined by ` · ` — `intro` when non-blank, non-heading text precedes the first `## `; then each `## ` heading lowercased, except a heading equal (case-insensitive) to `Check` with list items becomes `<n> question(s)` counting lines starting `- `, `* ` or `<digits>. ` in that section.
- `loadReviewDocuments(dir, branch, labels)` → `ReviewDocuments { clusterNotesDir: string; branchDocument?: string; clusterNotes: Map<number, { path: string; fileName: string; summary: string }> }` (key = cluster index). Missing files are silently absent; read errors other than ENOENT also mean absent.

### Tree (`src/treeProvider.ts`, `src/treeParents.ts`)

- New element `DocumentElement = { kind: "document"; document: "branch" } | { kind: "document"; document: "clusterNotes"; clusterKey: string }` in `ReviewTreeElement`; not collapsible (excluded from `CollapsibleElement`; collapse/expand handlers return early for it).
- Provider gains `getDocuments: () => ReviewDocuments | undefined`. Root prepends the branch row when `branchDocument` is set (both modes). A real cluster's children prepend its notes row when `clusterNotes` has its index, before files or the message row.
- Items: id `document:branch` / `document:clusterNotes:<key>`; contextValue `branchDocument` / `clusterNotesDocument`; tooltip = path code block plus one line (`Branch overview, written by the agent.` / `Notes document for <label>. Click to open it; select lines to leave a review note.`); commands `deltaReview.previewDocument` (branch) and `deltaReview.openDocument` (notes), argument a `vscode.Uri`.
- `parentOf`: branch → undefined; clusterNotes → `{ kind: "cluster", clusterKey }`.
- `src/extension.ts`: each refresh loads documents after the contract (labels from an `ok` contract, else none) into `reviewDocuments`; reset to undefined with the no-repo reset. The contract-dir watcher pattern widens to `{*.json,*.md,cluster-notes-*/*.md}`. Commands `deltaReview.openDocument` (`showTextDocument`) and `deltaReview.previewDocument` (`markdown.showPreview`), contributed in `package.json`, hidden from the palette; inline `deltaReview.previewDocument` (`$(open-preview)`) on `viewItem == clusterNotesDocument`.

### Notes file v2 (`src/notes.ts`, `src/notesStore.ts`, `src/noteTarget.ts`)

- `Note.document?: "clusterNotes"`. With it, `file` is the document's file name inside `cluster-notes-<sanitized branch>/` (must match `CLUSTER_NOTES_FILE_PATTERN`) and `side` must be `"working"`; else the file is rejected. Parsed only at version 2; at version 1 the key is unknown and ignored.
- Notes file accepts versions 1 and 2 (`(extension supports 1 and 2)`); responses and archive stay version 1 only. `saveNotes` writes `version: 2` when any note has `document`, else `1` (`notesFileVersion(notes)` in `src/notes.ts`), so files without document notes stay readable by older extensions.
- `NoteDraft.document?` passes through `createNote`; for a document note `content` is the document's full text, so `contentBlob` snapshots the document at creation and is anchored on `refs/review-notes/<branch>` like any note. `RefreshOptions.readDocumentContent(fileName)` supplies a document note's current content; `refreshDerived` never applies a response anchor to a document note (it stays on its document).
- `noteTargetFor` (task 01_08, together with every `NoteTarget` consumer so the union change compiles in one task): new `DocumentNoteTarget { kind: "document"; file; lines: "current" }` for a document note whose document exists (third parameter generalizes to "the note's working document exists"); a missing document (renamed or deleted) falls back to `{ kind: "base", path: note.file, sha: note.contentBlob, lines: "creation" }`: the thread renders read-only on the creation-time snapshot served by the base content provider, `refreshDerived` marks it outdated and keeps the last position, and the REVIEW NOTES row actions keep it closable.

### Notes UI (`src/commentController.ts`, `src/notesTreeProvider.ts`, `src/extension.ts`)

- Controller gains `getClusterNotesDir: () => string | undefined`. A `file:` document whose directory equals it (both sides normalized through `vscode.Uri.file(dir).fsPath`, so Windows drive-letter case matches) and whose name matches the pattern gets full-document commenting ranges and `addNote` creates a `document: "clusterNotes"` working note; this check runs before `repoRelativePath`, since a common dir inside the repo would otherwise yield a `.git/...` path. Document targets resolve to `Uri.file(join(dir, file))`.
- REVIEW NOTES groups by `(document, file)`; document groups sort first, label from a `documentLabel(file)` resolver (`<cluster label> — notes`, falling back to the file name), description `cluster notes · <n>`, collapse key `notes:clusterNotes:<file>`.
- `deltaReview.openNoteInDiff` on a document note opens its target document (never a diff, never matching a repo file of the same name) and expands the thread; no DELTA REVIEW reveal.

### Docs

- `plugin/skills/cluster/SKILL.md`: `levels` (any version), v4 ranged `notes` and the write-3-unless-ranged version rule, `files` order is the reading order, cluster notes document convention and the rename rule, the branch document path. `plugin/skills/review-notes/SKILL.md`: notes v2 `document` key, how to locate the document, and that a note whose document is gone is answered by reply only. Orphaned document notes: before renaming or deleting a cluster notes document, the agent replies through the responses file to every open or pending note on it, saying where the content went (the agent cannot edit the extension-owned notes file to re-home `file`); stated in the cluster skill's Documents section by task 01_07 (when document notes become possible), referenced from the review-notes skill. `DEVELOPMENT.md`: Clusters contract, provenance/agent threads, documents, review notes, manual steps. Each lands in the task that changes the behavior it describes.

### Removed

- Nothing is removed. Version 3 contracts and version 1 notes files keep parsing unchanged.

## Hard-to-undo

- Clusters contract schema v4 (array-valued `notes` with line ranges): a public file format written by the `delta:cluster` skill; older extensions reject v4 files, which the skill writes only when a ranged note is present.
- Clusters contract optional `levels` key at every version: a public format addition; older extensions ignore it.
- Notes file schema v2 (`document` key): the extension writes version 2 to `notes-<branch>.json` once a document note exists; older extensions then refuse that file until those notes are deleted.
- New public commands and menu contributions in `package.json` (`deltaReview.openDocument`, `deltaReview.previewDocument`).

## Task index

| Task file | What | Files |
| --- | --- | --- |
| `01_01_contract_order.md` | Cluster buckets in contract `files` order; tree mode re-sorts by path | `src/clusters.ts`, `src/treeParents.ts`, `src/treeProvider.ts`, `plugin/skills/cluster/SKILL.md`, `DEVELOPMENT.md` |
| `01_02_clusters_v4_contract.md` | Contract `levels` (all versions) and v4 ranged `notes` parser, carried onto `ReviewFile` | `src/clusters.ts`, `src/model.ts`, `src/extension.ts`, `plugin/skills/cluster/SKILL.md`, `DEVELOPMENT.md` |
| `01_03_review_level_rows.md` | `skim` tag in row description and tooltip | `src/reviewLevel.ts`, `src/treeProvider.ts`, `DEVELOPMENT.md` |
| `01_04_agent_line_threads.md` | Read-only line-range agent threads and tooltip count | `src/provenance.ts`, `src/commentController.ts`, `src/extension.ts`, `src/treeProvider.ts`, `DEVELOPMENT.md` |
| `01_05_document_discovery.md` | Document path convention, summary, loader; skill documents the convention | `src/documents.ts`, `plugin/skills/cluster/SKILL.md` |
| `01_06_document_rows.md` | Branch overview and cluster notes rows, commands, watcher | `src/treeProvider.ts`, `src/treeParents.ts`, `src/extension.ts`, `package.json`, `DEVELOPMENT.md` |
| `01_07_notes_v2_document_notes.md` | Notes file v2 `document` key and store support | `src/notes.ts`, `src/notesStore.ts`, `src/extension.ts`, `plugin/skills/review-notes/SKILL.md`, `plugin/skills/cluster/SKILL.md` |
| `01_08_document_notes_ui.md` | Document note target, commenting, threads, REVIEW NOTES and click for document notes | `src/noteTarget.ts`, `src/commentController.ts`, `src/notesTreeProvider.ts`, `src/extension.ts`, `DEVELOPMENT.md` |
