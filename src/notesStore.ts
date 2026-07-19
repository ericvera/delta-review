import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Git } from "./git";
import { mapRangeThroughHunks, parseUnifiedDiffHunks } from "./noteAnchor";
import { mergeThreads } from "./noteThreads";
import type { NoteThread } from "./noteThreads";
import {
  notesFileName,
  parseNotesFile,
  parseResponsesFile,
  responsesFileName,
} from "./notes";
import type {
  LoadNotesResult,
  LoadResponsesResult,
  Note,
  NoteSide,
  NotesFile,
  ResponseAnchor,
  ResponsesFile,
} from "./notes";

// Notes store: the single module that reads/writes the notes and responses
// files under <git common dir>/delta-review/, snapshots note content as git
// blobs, anchors those blobs on a dedicated ref so `git gc` never collects
// them, and computes/persists the derived fields (current position, outdated,
// status). Node + Git only — no vscode — so the temp-repo tests run under
// Vitest.
//
// Why a dedicated anchor ref: left-side notes reference merge-base or
// reviewed-snapshot blobs, and Clear Review State deletes
// refs/review/<branch> — so notes anchor every contentBlob on their own
// refs/review-notes/<branch> to survive gc regardless of review-state
// clearing.

export const reviewNotesRefForBranch = (branch: string): string =>
  `refs/review-notes/${branch}`;

// Resolves the delta-review data dir. Uses the git common dir (not
// --git-dir) so notes travel with the branch across linked worktrees,
// matching clusters contracts and review refs. `--git-common-dir` returns a
// relative path (".git") from the main worktree, so resolve against repoRoot.
const deltaReviewDir = async (git: Git): Promise<string> => {
  const commonDirOutput = (
    await git.run(["rev-parse", "--git-common-dir"])
  ).trim();
  const commonDir = isAbsolute(commonDirOutput)
    ? commonDirOutput
    : join(git.repoRoot, commonDirOutput);
  return join(commonDir, "delta-review");
};

type ReadFileResult =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  | { state: "text"; text: string };

const readDeltaReviewFile = async (
  git: Git,
  fileName: string,
): Promise<ReadFileResult> => {
  const path = join(await deltaReviewDir(git), fileName);
  try {
    return { state: "text", text: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing" };
    }
    return {
      state: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const loadNotes = async (
  git: Git,
  branch: string,
): Promise<LoadNotesResult> => {
  const read = await readDeltaReviewFile(git, notesFileName(branch));
  if (read.state !== "text") {
    return read;
  }
  const parsed = parseNotesFile(read.text);
  return parsed.ok
    ? { state: "ok", file: parsed.file }
    : { state: "invalid", error: parsed.error };
};

export const loadResponses = async (
  git: Git,
  branch: string,
): Promise<LoadResponsesResult> => {
  const read = await readDeltaReviewFile(git, responsesFileName(branch));
  if (read.state !== "text") {
    return read;
  }
  const parsed = parseResponsesFile(read.text);
  return parsed.ok
    ? { state: "ok", file: parsed.file }
    : { state: "invalid", error: parsed.error };
};

// Last successfully written serialization per absolute path. Together with
// the on-disk comparison in saveNotes this is the idempotence guard: a save
// that changes nothing never touches the file, so the extension's watcher on
// the delta-review dir cannot enter a refresh→write→refresh loop.
const lastWritten = new Map<string, string>();

// Serializes and atomically writes the notes file (temp file in the same
// directory, renamed over — same-dir keeps the rename atomic). Returns true
// when a write happened, false when the guard skipped an identical save.
export const saveNotes = async (
  git: Git,
  branch: string,
  file: NotesFile,
): Promise<boolean> => {
  const dir = await deltaReviewDir(git);
  const path = join(dir, notesFileName(branch));
  const text = JSON.stringify(file, null, 2) + "\n";
  if (lastWritten.get(path) === text) {
    return false;
  }
  try {
    if ((await readFile(path, "utf8")) === text) {
      lastWritten.set(path, text);
      return false;
    }
  } catch {
    // Missing or unreadable — proceed to write
  }
  await mkdir(dir, { recursive: true });
  const tempPath = join(
    dir,
    `.${notesFileName(branch)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tempPath, text);
    await rename(tempPath, path);
  } finally {
    // Gone already after a successful rename; removes the orphan otherwise
    await unlink(tempPath).catch(() => undefined);
  }
  lastWritten.set(path, text);
  return true;
};

// Hashes content into the object database. Always -w: every sha that may be
// referenced from the anchor ref's tree must actually exist as an object —
// a hash-only sha would leave a dangling tree entry.
export const writeContentBlob = async (
  git: Git,
  content: string,
): Promise<string> =>
  (await git.run(["hash-object", "-w", "--stdin"], { stdin: content })).trim();

// Anchors every note's contentBlob as a commit tree on
// refs/review-notes/<branch> (path = note id, sha = contentBlob), so gc
// keeps the blobs alive. With no notes left the ref is deleted. A commit is
// only created when the anchored tree actually changed — mutation helpers
// anchor after every save, and text-only edits would otherwise pile up
// empty commits.
export const anchorBlobs = async (
  git: Git,
  branch: string,
  notes: Note[],
): Promise<void> => {
  const ref = reviewNotesRefForBranch(branch);
  if (notes.length === 0) {
    try {
      await git.run(["update-ref", "-d", ref]);
    } catch {
      // Ref did not exist — nothing to delete
    }
    return;
  }
  // A temporary index keeps this fully isolated from the user's real index
  const indexFile = join(
    tmpdir(),
    `delta-review-${randomBytes(8).toString("hex")}`,
  );
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git.run(["read-tree", "--empty"], { env });
    const indexInfo = notes
      .map((note) => `100644 ${note.contentBlob} 0\t${note.id}\0`)
      .join("");
    await git.run(["update-index", "-z", "--index-info"], {
      env,
      stdin: indexInfo,
    });
    const tree = (await git.run(["write-tree"], { env })).trim();

    let parentArgs: string[] = [];
    try {
      const parent = (
        await git.run(["rev-parse", "--verify", "--quiet", ref])
      ).trim();
      if (parent !== "") {
        parentArgs = ["-p", parent];
      }
    } catch {
      // No previous anchor commit for this branch
    }
    if (parentArgs.length > 0) {
      const currentTree = (
        await git.run(["rev-parse", `${ref}^{tree}`])
      ).trim();
      if (currentTree === tree) {
        return;
      }
    }
    const commit = (
      await git.run([
        "commit-tree",
        tree,
        ...parentArgs,
        "-m",
        "delta-review notes",
      ])
    ).trim();
    await git.run(["update-ref", ref, commit]);
  } finally {
    await unlink(indexFile).catch(() => undefined);
  }
};

// Mutations must never overwrite a present-but-unparsable notes file (the
// broken state stays readable until a human fixes it), so every mutation
// starts from a successful load. Missing is fine — it becomes an empty file.
const loadNotesForMutation = async (
  git: Git,
  branch: string,
): Promise<NotesFile> => {
  const result = await loadNotes(git, branch);
  if (result.state === "invalid") {
    throw new Error(
      `notes file for branch "${branch}" is invalid and will not be overwritten: ${result.error}`,
    );
  }
  return result.state === "ok" ? result.file : { version: 1, notes: [] };
};

const findNote = (file: NotesFile, noteId: string): Note => {
  const note = file.notes.find((entry) => entry.id === noteId);
  if (note === undefined) {
    throw new Error(`note "${noteId}" not found`);
  }
  return note;
};

export interface NoteDraft {
  // Repo-relative path the note anchors to
  file: string;
  side: NoteSide;
  // 1-based, inclusive range in the side document
  startLine: number;
  endLine: number;
  // The anchored lines' text, one entry per line of the range
  snapshot: string[];
  // Full text of the side document at creation time (hashed into contentBlob)
  content: string;
  // The reviewer's note text — becomes the first turn
  text: string;
}

// Creates a note: snapshots the side document as a blob, appends the note
// with creation-value derived fields, saves, and anchors.
export const createNote = async (
  git: Git,
  branch: string,
  draft: NoteDraft,
): Promise<Note> => {
  const file = await loadNotesForMutation(git, branch);
  const contentBlob = await writeContentBlob(git, draft.content);
  const now = new Date().toISOString();
  const note: Note = {
    id: randomUUID(),
    file: draft.file,
    side: draft.side,
    startLine: draft.startLine,
    endLine: draft.endLine,
    snapshot: [...draft.snapshot],
    contentBlob,
    turns: [{ text: draft.text, at: now }],
    status: "open",
    outdated: false,
    currentStartLine: draft.startLine,
    currentEndLine: draft.endLine,
    createdAt: now,
  };
  file.notes.push(note);
  await saveNotes(git, branch, file);
  await anchorBlobs(git, branch, file.notes);
  return note;
};

export const appendReviewerTurn = async (
  git: Git,
  branch: string,
  noteId: string,
  text: string,
): Promise<Note> => {
  const file = await loadNotesForMutation(git, branch);
  const note = findNote(file, noteId);
  note.turns.push({ text, at: new Date().toISOString() });
  if (note.status !== "resolved") {
    // The reviewer is now the last speaker (an explicit resolve still wins)
    note.status = "open";
  }
  await saveNotes(git, branch, file);
  await anchorBlobs(git, branch, file.notes);
  return note;
};

// Rewrites a turn's text in place; `at` is preserved so the turn keeps its
// position in the merged thread.
export const editReviewerTurn = async (
  git: Git,
  branch: string,
  noteId: string,
  turnIndex: number,
  text: string,
): Promise<Note> => {
  const file = await loadNotesForMutation(git, branch);
  const note = findNote(file, noteId);
  const turn = note.turns[turnIndex];
  if (turn === undefined) {
    throw new Error(`note "${noteId}" has no turn at index ${turnIndex}`);
  }
  turn.text = text;
  await saveNotes(git, branch, file);
  await anchorBlobs(git, branch, file.notes);
  return note;
};

// Deletes the whole thread. Deleting the last note deletes the anchor ref.
export const deleteNote = async (
  git: Git,
  branch: string,
  noteId: string,
): Promise<void> => {
  const file = await loadNotesForMutation(git, branch);
  findNote(file, noteId);
  file.notes = file.notes.filter((note) => note.id !== noteId);
  await saveNotes(git, branch, file);
  await anchorBlobs(git, branch, file.notes);
};

// Resolve sets the sticky "resolved" status; unresolve recomputes the
// derived status from the merged thread's last speaker (agent → addressed,
// reviewer → open).
export const setResolved = async (
  git: Git,
  branch: string,
  noteId: string,
  resolved: boolean,
): Promise<Note> => {
  const file = await loadNotesForMutation(git, branch);
  const note = findNote(file, noteId);
  if (resolved) {
    note.status = "resolved";
  } else {
    // Clear the explicit resolve first — mergeThreads gives it priority
    note.status = "open";
    const responsesResult = await loadResponses(git, branch);
    const responses =
      responsesResult.state === "ok" ? responsesResult.file : undefined;
    const threads = mergeThreads(
      { version: 1, notes: [note] },
      responses,
      () => false,
    );
    const thread = threads[0];
    if (thread !== undefined) {
      note.status = thread.status;
    }
  }
  await saveNotes(git, branch, file);
  await anchorBlobs(git, branch, file.notes);
  return note;
};

export interface RefreshOptions {
  // Current working-tree content of a repo-relative path; undefined when the
  // file is missing from the working tree. Injected so this module stays
  // vscode-free.
  readWorkingContent: (file: string) => Promise<string | undefined>;
  // Current left-side blob for a file (ReviewModel's diffBaseSha); undefined
  // when the file has no base.
  baseBlobFor: (file: string) => string | undefined;
  // Whether a response anchor resolves against the working tree
  // (mergeThreads passthrough); defaults to treating every anchor as
  // dangling.
  anchorResolves?: (anchor: ResponseAnchor) => boolean;
  // Anchor-application hook (Task 3.3): runs on the merged threads before
  // derived fields are computed or persisted, so an applied effectiveAnchor
  // (side flip, relocation, contentBlob re-snapshot) lands in the same save
  // and re-anchor. May mutate the notes the threads reference.
  applyAnchors?: (threads: NoteThread[]) => Promise<void> | void;
}

// The derived-field refresh pass: recomputes each note's current position,
// outdated flag, and status against the current side documents, then
// persists — but only when something actually changed (saveNotes guard), and
// re-anchors only when a contentBlob changed (a loose replacement blob would
// otherwise be pruned by a later gc, breaking re-anchoring for exactly the
// relocated notes). The input file is never mutated; the refreshed file is
// returned.
export const refreshDerived = async (
  git: Git,
  branch: string,
  notesFile: NotesFile,
  responses: ResponsesFile | undefined,
  options: RefreshOptions,
): Promise<NotesFile> => {
  const file = structuredClone(notesFile);
  const blobsBefore = file.notes.map((note) => note.contentBlob).join("\n");
  const threads = mergeThreads(
    file,
    responses,
    options.anchorResolves ?? (() => false),
  );
  if (options.applyAnchors !== undefined) {
    await options.applyAnchors(threads);
  }
  for (const [index, note] of file.notes.entries()) {
    const thread = threads[index];
    if (thread !== undefined) {
      note.status = thread.status;
    }
    let currentBlob: string | undefined;
    if (note.side === "working") {
      const content = await options.readWorkingContent(note.file);
      // -w so the comparison blob is also anchor-able if a later pass
      // re-snapshots the note onto it
      currentBlob =
        content === undefined
          ? undefined
          : await writeContentBlob(git, content);
    } else {
      currentBlob = options.baseBlobFor(note.file);
    }
    if (currentBlob === undefined) {
      // Side document is gone: flag outdated, keep the last known position
      note.outdated = true;
      continue;
    }
    if (currentBlob === note.contentBlob) {
      // Identical content — derived position is the creation position
      note.currentStartLine = note.startLine;
      note.currentEndLine = note.endLine;
      note.outdated = false;
      continue;
    }
    // Blob-vs-blob diff: prints one unified diff between the two contents
    const diffText = await git.run([
      "diff",
      "-U0",
      note.contentBlob,
      currentBlob,
    ]);
    const mapped = mapRangeThroughHunks(
      note.startLine,
      note.endLine,
      parseUnifiedDiffHunks(diffText),
    );
    note.currentStartLine = mapped.startLine;
    note.currentEndLine = mapped.endLine;
    note.outdated = mapped.outdated;
  }
  await saveNotes(git, branch, file);
  const blobsAfter = file.notes.map((note) => note.contentBlob).join("\n");
  if (blobsAfter !== blobsBefore) {
    await anchorBlobs(git, branch, file.notes);
  }
  return file;
};
