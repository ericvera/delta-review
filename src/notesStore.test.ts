import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, Git } from "./git";
import {
  ArchiveShell,
  Note,
  NotesFile,
  parseArchiveFile,
  ResponseEntry,
  ResponsesFile,
} from "./notes";
import {
  anchorBlobs,
  archiveNotes,
  archiveWarning,
  buildAnchorResolver,
  appendReviewerTurn,
  createNote,
  deleteNote,
  deleteNotes,
  deleteReviewerTurn,
  editReviewerTurn,
  loadNotes,
  loadResponses,
  NoteDraft,
  refreshDerived,
  RefreshOptions,
  reviewNotesRefForBranch,
  saveNotes,
  setResolved,
  writeContentBlob,
} from "./notesStore";
import { reviewRefForBranch, writeReviewState } from "./reviewState";

// Real temp git repos: ref and blob behavior (anchoring, gc survival,
// blob-vs-blob diffs) is the point of this suite, so a fake Git would test
// nothing.

const fileContent = "alpha\nbeta\ngamma\ndelta\n";

let repoRoot: string;
let git: Git;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "delta-review-store-"));
  git = createGit(repoRoot);
  await git.run(["init", "-b", "main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "Test"]);
  await git.run(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repoRoot, "a.txt"), fileContent);
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "init"]);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

const draft = (overrides: Partial<NoteDraft> = {}): NoteDraft => ({
  file: "a.txt",
  side: "working",
  startLine: 2,
  endLine: 3,
  snapshot: ["beta", "gamma"],
  content: fileContent,
  text: "first note",
  ...overrides,
});

const notesPath = (branch = "main"): string =>
  join(repoRoot, ".git", "delta-review", `notes-${branch}.json`);

const contractDir = (): string => join(repoRoot, ".git", "delta-review");

const archivePath = (branch = "main"): string =>
  join(contractDir(), `archive-${branch}.json`);

const readArchive = async (): Promise<ArchiveShell> => {
  const parsed = parseArchiveFile(await readFile(archivePath(), "utf8"));
  if (!parsed.ok) {
    throw new Error(`expected a valid archive, got: ${parsed.error}`);
  }
  return parsed.file;
};

const archivedIds = async (): Promise<unknown[]> =>
  (await readArchive()).notes.map((entry) => (entry as { id: unknown }).id);

const archiveExists = async (): Promise<boolean> => {
  try {
    await readFile(archivePath(), "utf8");
    return true;
  } catch {
    return false;
  }
};

const writeResponseEntries = async (
  entries: Array<Partial<ResponseEntry> & { noteId: string }>,
): Promise<void> => {
  const dir = join(repoRoot, ".git", "delta-review");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "responses-main.json"),
    JSON.stringify({
      version: 1,
      responses: entries.map((entry) => ({
        response: "done",
        at: "2099-01-01T00:00:00.000Z",
        ...entry,
      })),
    }),
  );
};

const writeResponses = async (
  noteId: string,
  at = "2099-01-01T00:00:00.000Z",
): Promise<void> => writeResponseEntries([{ noteId, at }]);

const loadedResponses = async (): Promise<ResponsesFile> => {
  const result = await loadResponses(git, "main");
  if (result.state !== "ok") {
    throw new Error(`expected responses, got ${result.state}`);
  }
  return result.file;
};

const refreshOptions = (
  overrides: Partial<RefreshOptions> = {},
): RefreshOptions => ({
  readWorkingContent: async (file) => {
    try {
      return await readFile(join(repoRoot, file), "utf8");
    } catch {
      return undefined;
    }
  },
  baseBlobFor: (_file: string, _contentBlob: string) => undefined,
  ...overrides,
});

// Wraps the real git so tests can assert which subcommands ran
const spyingGit = (): { git: Git; commands: string[] } => {
  const commands: string[] = [];
  const real = git;
  return {
    commands,
    git: {
      repoRoot: real.repoRoot,
      run: (args, options) => {
        commands.push(args[0]);
        return real.run(args, options);
      },
    },
  };
};

describe("loadNotes / loadResponses", () => {
  it("returns missing when the delta-review dir does not exist", async () => {
    expect(await loadNotes(git, "main")).toEqual({ state: "missing" });
    expect(await loadResponses(git, "main")).toEqual({ state: "missing" });
  });

  it("round-trips a saved notes file", async () => {
    const note = await createNote(git, "main", draft());
    const result = await loadNotes(git, "main");
    expect(result).toEqual({
      state: "ok",
      file: { version: 1, notes: [note] },
    });
  });

  it("returns invalid with the parse error for corrupt JSON", async () => {
    await mkdir(join(repoRoot, ".git", "delta-review"), { recursive: true });
    await writeFile(notesPath(), "not json");
    const result = await loadNotes(git, "main");
    expect(result.state).toBe("invalid");
    expect(result.state === "invalid" && result.error).toMatch(
      /not valid JSON/,
    );
  });

  it("loads a valid responses file", async () => {
    await writeResponses("some-note-id");
    const result = await loadResponses(git, "main");
    expect(result.state).toBe("ok");
    expect(result.state === "ok" && result.file.responses[0].noteId).toBe(
      "some-note-id",
    );
  });
});

describe("saveNotes idempotence guard", () => {
  const file = (notes: Note[] = []): NotesFile => ({ version: 1, notes });

  it("writes once, then skips identical saves (module state)", async () => {
    const notes = file([]);
    expect(await saveNotes(git, "main", notes)).toBe(true);
    expect(await saveNotes(git, "main", notes)).toBe(false);
    expect(await readFile(notesPath(), "utf8")).toBe(
      JSON.stringify(notes, null, 2) + "\n",
    );
  });

  it("skips when identical content is already on disk (no prior save)", async () => {
    // Simulates another process having written the same bytes: this repo's
    // path was never saved by this module instance, so only the on-disk
    // comparison can catch it.
    const notes = file([]);
    await mkdir(join(repoRoot, ".git", "delta-review"), { recursive: true });
    await writeFile(notesPath(), JSON.stringify(notes, null, 2) + "\n");
    expect(await saveNotes(git, "main", notes)).toBe(false);
  });

  it("writes again when the content changed", async () => {
    await saveNotes(git, "main", file([]));
    const note = await createNote(git, "main", draft());
    expect(await readFile(notesPath(), "utf8")).toContain(note.id);
  });
});

describe("createNote", () => {
  it("creates a note with derived fields equal to creation values", async () => {
    const note = await createNote(git, "main", draft());
    expect(note.status).toBe("open");
    expect(note.outdated).toBe(false);
    expect(note.currentStartLine).toBe(2);
    expect(note.currentEndLine).toBe(3);
    expect(note.turns).toEqual([{ text: "first note", at: note.createdAt }]);
    expect(note.id).not.toBe("");
  });

  it("writes the content blob and anchors it under the notes ref", async () => {
    const note = await createNote(git, "main", draft());
    // Blob exists in the object database
    await expect(git.run(["cat-file", "-e", note.contentBlob])).resolves.toBe(
      "",
    );
    // The ref's tree lists the note id -> contentBlob
    const tree = await git.run([
      "ls-tree",
      "-r",
      reviewNotesRefForBranch("main"),
    ]);
    expect(tree).toContain(note.id);
    expect(tree).toContain(note.contentBlob);
  });

  it("sanitizes the branch in the filename but keeps the ref raw", async () => {
    await createNote(git, "feat/x", draft());
    // The file lands at the sanitized path (feat/x → feat-x)
    const onDisk = JSON.parse(await readFile(notesPath("feat-x"), "utf8"));
    expect(onDisk.notes).toHaveLength(1);
    const ref = (
      await git.run(["rev-parse", "--verify", "refs/review-notes/feat/x"])
    ).trim();
    expect(ref).not.toBe("");
  });

  it("refuses to mutate on top of a corrupt notes file", async () => {
    await mkdir(join(repoRoot, ".git", "delta-review"), { recursive: true });
    await writeFile(notesPath(), "{broken");
    await expect(createNote(git, "main", draft())).rejects.toThrow(
      /invalid and will not be overwritten/,
    );
    expect(await readFile(notesPath(), "utf8")).toBe("{broken");
  });
});

describe("gc survival", () => {
  it("keeps note blobs alive through gc --prune=now with refs/review/<branch> deleted", async () => {
    // Content that exists nowhere else — not in any commit — so only the
    // anchor ref keeps it alive
    const uncommitted = fileContent + "epsilon\n";
    const note = await createNote(git, "main", draft({ content: uncommitted }));

    // Simulate review state existing and then being cleared (the Clear
    // Review State command deletes refs/review/<branch>)
    await writeReviewState(git, "main", new Map([["a.txt", note.contentBlob]]));
    await git.run(["update-ref", "-d", reviewRefForBranch("main")]);

    // A control blob with no anchor must be pruned — proving gc has teeth
    const controlBlob = await writeContentBlob(git, "unanchored content\n");

    await git.run(["gc", "--prune=now"]);

    await expect(git.run(["cat-file", "-e", note.contentBlob])).resolves.toBe(
      "",
    );
    await expect(git.run(["cat-file", "-e", controlBlob])).rejects.toThrow();
  });
});

describe("mutation helpers", () => {
  it("appendReviewerTurn adds a turn and reopens an addressed note", async () => {
    const note = await createNote(git, "main", draft());
    const loaded = await loadNotes(git, "main");
    if (loaded.state !== "ok") {
      throw new Error("expected notes");
    }
    loaded.file.notes[0].status = "addressed";
    await saveNotes(git, "main", loaded.file);

    const updated = await appendReviewerTurn(git, "main", note.id, "reply");
    expect(updated.turns).toHaveLength(2);
    expect(updated.turns[1].text).toBe("reply");
    expect(updated.status).toBe("open");
  });

  it("appendReviewerTurn does not add a new anchor commit (tree unchanged)", async () => {
    const note = await createNote(git, "main", draft());
    await appendReviewerTurn(git, "main", note.id, "reply");
    const count = (
      await git.run(["rev-list", "--count", reviewNotesRefForBranch("main")])
    ).trim();
    expect(count).toBe("1");
  });

  it("editReviewerTurn rewrites text and preserves the timestamp", async () => {
    const note = await createNote(git, "main", draft());
    const updated = await editReviewerTurn(
      git,
      "main",
      note.id,
      note.turns[0].at,
      "edited",
    );
    expect(updated.turns[0]).toEqual({ text: "edited", at: note.turns[0].at });
  });

  it("editReviewerTurn rejects a timestamp no turn carries", async () => {
    const note = await createNote(git, "main", draft());
    await expect(
      editReviewerTurn(git, "main", note.id, "2020-01-01T00:00:00.000Z", "x"),
    ).rejects.toThrow(/no turn with timestamp 2020-01-01T00:00:00\.000Z/);
  });

  it("editReviewerTurn still hits the right turn after another turn is deleted", async () => {
    const note = await createNote(git, "main", draft({ text: "first" }));
    await appendReviewerTurn(git, "main", note.id, "second");
    const withThird = await appendReviewerTurn(git, "main", note.id, "third");
    const thirdAt = withThird.turns[2].at;

    // Deleting an earlier turn shifts array indices under the third turn
    await deleteReviewerTurn(git, "main", note.id, 0);
    const updated = await editReviewerTurn(
      git,
      "main",
      note.id,
      thirdAt,
      "third-edited",
    );

    expect(updated.turns.map((turn) => turn.text)).toEqual([
      "second",
      "third-edited",
    ]);
    expect(updated.turns[1].at).toBe(thirdAt);
    const loaded = await loadNotes(git, "main");
    expect(
      loaded.state === "ok" && loaded.file.notes[0].turns.map((t) => t.text),
    ).toEqual(["second", "third-edited"]);
  });

  it("editReviewerTurn rejects a deleted turn's timestamp", async () => {
    const note = await createNote(git, "main", draft({ text: "first" }));
    await appendReviewerTurn(git, "main", note.id, "second");
    const firstAt = note.turns[0].at;
    await deleteReviewerTurn(git, "main", note.id, 0);
    await expect(
      editReviewerTurn(git, "main", note.id, firstAt, "edited"),
    ).rejects.toThrow(/no turn with timestamp/);
  });

  it("deleteNote removes the note and drops it from the anchor tree", async () => {
    const keep = await createNote(git, "main", draft({ text: "keep" }));
    const remove = await createNote(
      git,
      "main",
      draft({ text: "remove", content: fileContent + "zeta\n" }),
    );
    await deleteNote(git, "main", remove.id);

    const result = await loadNotes(git, "main");
    expect(result.state === "ok" && result.file.notes.map((n) => n.id)).toEqual(
      [keep.id],
    );
    const tree = await git.run([
      "ls-tree",
      "-r",
      reviewNotesRefForBranch("main"),
    ]);
    expect(tree).toContain(keep.id);
    expect(tree).not.toContain(remove.id);
  });

  it("deleting the last note deletes the anchor ref", async () => {
    const note = await createNote(git, "main", draft());
    await deleteNote(git, "main", note.id);
    await expect(
      git.run(["rev-parse", "--verify", reviewNotesRefForBranch("main")]),
    ).rejects.toThrow();
  });

  it("deleteNotes removes all listed notes in one pass and re-anchors", async () => {
    const keep = await createNote(git, "main", draft({ text: "keep" }));
    const removeA = await createNote(
      git,
      "main",
      draft({ text: "remove a", content: fileContent + "zeta\n" }),
    );
    const removeB = await createNote(
      git,
      "main",
      draft({ text: "remove b", content: fileContent + "eta\n" }),
    );

    const result = await deleteNotes(git, "main", [
      removeA.id,
      removeB.id,
      "unknown-id",
    ]);

    expect(result.deleted).toBe(2);
    const loaded = await loadNotes(git, "main");
    expect(loaded.state === "ok" && loaded.file.notes.map((n) => n.id)).toEqual(
      [keep.id],
    );
    const tree = await git.run([
      "ls-tree",
      "-r",
      reviewNotesRefForBranch("main"),
    ]);
    expect(tree).toContain(keep.id);
    expect(tree).not.toContain(removeA.id);
    expect(tree).not.toContain(removeB.id);
  });

  it("deleteNotes with no matching ids touches neither the file nor the ref", async () => {
    await createNote(git, "main", draft());
    const fileBefore = await readFile(notesPath(), "utf8");
    const refBefore = (
      await git.run(["rev-parse", reviewNotesRefForBranch("main")])
    ).trim();

    const spy = spyingGit();
    const result = await deleteNotes(spy.git, "main", ["unknown-id"]);

    expect(result).toEqual({ deleted: 0 });
    expect(await archiveExists()).toBe(false);
    expect(spy.commands).not.toContain("update-ref");
    expect(spy.commands).not.toContain("commit-tree");
    expect(await readFile(notesPath(), "utf8")).toBe(fileBefore);
    expect(
      (await git.run(["rev-parse", reviewNotesRefForBranch("main")])).trim(),
    ).toBe(refBefore);
  });

  it("deleteNotes deleting every note deletes the anchor ref", async () => {
    const a = await createNote(git, "main", draft({ text: "a" }));
    const b = await createNote(git, "main", draft({ text: "b" }));
    const result = await deleteNotes(git, "main", [a.id, b.id]);

    expect(result.deleted).toBe(2);
    const loaded = await loadNotes(git, "main");
    expect(loaded.state === "ok" && loaded.file.notes).toEqual([]);
    await expect(
      git.run(["rev-parse", "--verify", reviewNotesRefForBranch("main")]),
    ).rejects.toThrow();
  });

  it("deleteNotes refuses to rewrite an invalid notes file", async () => {
    await createNote(git, "main", draft());
    await writeFile(notesPath(), "{ not json");
    await expect(deleteNotes(git, "main", ["any"])).rejects.toThrow(
      /will not be overwritten/,
    );
    expect(await readFile(notesPath(), "utf8")).toBe("{ not json");
    expect(await archiveExists()).toBe(false);
  });

  it("anchorBlobs tolerates deleting an absent ref", async () => {
    await expect(anchorBlobs(git, "main", [])).resolves.toBeUndefined();
  });

  it("mutating an unknown note id throws", async () => {
    await createNote(git, "main", draft());
    await expect(
      appendReviewerTurn(git, "main", "nope", "text"),
    ).rejects.toThrow(/not found/);
  });
});

describe("deleteReviewerTurn", () => {
  it("removes the targeted turn and keeps the note", async () => {
    const note = await createNote(git, "main", draft());
    await appendReviewerTurn(git, "main", note.id, "second");
    const updated = await deleteReviewerTurn(git, "main", note.id, 0);
    expect(updated?.turns.map((turn) => turn.text)).toEqual(["second"]);
    expect(updated?.status).toBe("open");
    const loaded = await loadNotes(git, "main");
    expect(
      loaded.state === "ok" && loaded.file.notes[0].turns.map((t) => t.text),
    ).toEqual(["second"]);
  });

  it("deletes the whole note when its only turn is removed", async () => {
    const note = await createNote(git, "main", draft());
    const result = await deleteReviewerTurn(git, "main", note.id, 0);
    expect(result).toBeUndefined();
    const loaded = await loadNotes(git, "main");
    expect(loaded.state === "ok" && loaded.file.notes).toEqual([]);
    // Last note gone → anchor ref deleted too
    await expect(
      git.run(["rev-parse", "--verify", reviewNotesRefForBranch("main")]),
    ).rejects.toThrow();
  });

  it("re-derives the status from the remaining merged thread", async () => {
    const note = await createNote(git, "main", draft());
    await appendReviewerTurn(git, "main", note.id, "second");
    // Agent response after both reviewer turns: once a reviewer turn is
    // deleted the agent is still the last speaker → addressed
    await writeResponses(note.id);
    const updated = await deleteReviewerTurn(git, "main", note.id, 1);
    expect(updated?.status).toBe("addressed");
  });

  it("keeps an explicit resolve sticky", async () => {
    const note = await createNote(git, "main", draft());
    await appendReviewerTurn(git, "main", note.id, "second");
    await setResolved(git, "main", note.id, true);
    const updated = await deleteReviewerTurn(git, "main", note.id, 1);
    expect(updated?.status).toBe("resolved");
  });

  it("rejects an out-of-range turn index", async () => {
    const note = await createNote(git, "main", draft());
    await expect(deleteReviewerTurn(git, "main", note.id, 3)).rejects.toThrow(
      /no turn at index 3/,
    );
  });
});

describe("setResolved", () => {
  it("resolve sets the sticky resolved status", async () => {
    const note = await createNote(git, "main", draft());
    const updated = await setResolved(git, "main", note.id, true);
    expect(updated.status).toBe("resolved");
  });

  it("unresolve recomputes from the last speaker: agent → addressed", async () => {
    const note = await createNote(git, "main", draft());
    await writeResponses(note.id);
    await setResolved(git, "main", note.id, true);
    const updated = await setResolved(git, "main", note.id, false);
    expect(updated.status).toBe("addressed");
  });

  it("unresolve without responses → open", async () => {
    const note = await createNote(git, "main", draft());
    await setResolved(git, "main", note.id, true);
    const updated = await setResolved(git, "main", note.id, false);
    expect(updated.status).toBe("open");
  });
});

describe("archiving on deleteNotes", () => {
  // Root ignores directory mode bits, so the chmod-based write failures
  // cannot be provoked there
  const skipAsRoot = process.getuid?.() === 0;
  const rawNotes = async (): Promise<Array<Record<string, unknown>>> =>
    (JSON.parse(await readFile(notesPath(), "utf8")) as NotesFile)
      .notes as unknown as Array<Record<string, unknown>>;

  it("appends every removed note exactly as it stood, with one deletedAt", async () => {
    const keep = await createNote(git, "main", draft({ text: "keep" }));
    const removeA = await createNote(
      git,
      "main",
      draft({ text: "remove a", content: fileContent + "zeta\n" }),
    );
    const removeB = await createNote(
      git,
      "main",
      draft({ text: "remove b", content: fileContent + "eta\n" }),
    );
    const onDisk = await rawNotes();
    const removedOnDisk = onDisk.filter(
      (note) => note.id === removeA.id || note.id === removeB.id,
    );

    const result = await deleteNotes(git, "main", [
      removeA.id,
      removeB.id,
      "unknown-id",
    ]);

    expect(result.deleted).toBe(2);
    expect(result.archive).toEqual({ state: "archived" });
    const archive = await readArchive();
    expect(archive.version).toBe(1);
    const entries = archive.notes as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    const deletedAt = entries[0].deletedAt as string;
    expect(Number.isNaN(Date.parse(deletedAt))).toBe(false);
    // Original file order, every field intact, one shared timestamp
    expect(entries).toEqual(
      removedOnDisk.map((note) => ({ ...note, deletedAt })),
    );
    expect(entries.map((entry) => entry.id)).toEqual([removeA.id, removeB.id]);

    const loaded = await loadNotes(git, "main");
    expect(loaded.state === "ok" && loaded.file.notes.map((n) => n.id)).toEqual(
      [keep.id],
    );
    const tree = await git.run([
      "ls-tree",
      "-r",
      reviewNotesRefForBranch("main"),
    ]);
    expect(tree).toContain(keep.id);
    expect(tree).not.toContain(removeA.id);
    expect(tree).not.toContain(removeB.id);
  });

  it("appends after existing entries and keeps foreign top-level keys", async () => {
    const note = await createNote(git, "main", draft());
    await writeFile(
      archivePath(),
      JSON.stringify({ version: 1, notes: [{ id: "old" }], extra: true }),
    );

    const result = await deleteNotes(git, "main", [note.id]);

    expect(result.archive).toEqual({ state: "archived" });
    expect(await archivedIds()).toEqual(["old", note.id]);
    expect((await readArchive()).extra).toBe(true);
  });

  it("serializes the archive like the notes file and leaves no temp file", async () => {
    const note = await createNote(git, "main", draft());
    await deleteNotes(git, "main", [note.id]);

    const text = await readFile(archivePath(), "utf8");
    // 2-space indent and a trailing newline, exactly like the notes file
    expect(text.startsWith('{\n  "version": 1,\n  "notes": [\n    {\n')).toBe(
      true,
    );
    expect(text.endsWith("}\n")).toBe(true);
    expect(
      (await readdir(contractDir())).filter((e) => e.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("moves a corrupt archive aside and starts a fresh one", async () => {
    const note = await createNote(git, "main", draft());
    await writeFile(archivePath(), "{ nope");

    const result = await deleteNotes(git, "main", [note.id]);

    expect(result.deleted).toBe(1);
    expect(result.archive?.state).toBe("moved-aside");
    const asidePath =
      result.archive?.state === "moved-aside" ? result.archive.asidePath : "";
    expect(asidePath).toMatch(
      /archive-main\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/,
    );
    expect(await readFile(asidePath, "utf8")).toBe("{ nope");
    expect(await archivedIds()).toEqual([note.id]);
    const loaded = await loadNotes(git, "main");
    expect(loaded.state === "ok" && loaded.file.notes).toEqual([]);
  });

  it("treats an unsupported archive version as corrupt", async () => {
    const note = await createNote(git, "main", draft());
    await writeFile(archivePath(), JSON.stringify({ version: 2, notes: [] }));

    const result = await deleteNotes(git, "main", [note.id]);

    expect(result.archive?.state).toBe("moved-aside");
    expect(await archivedIds()).toEqual([note.id]);
  });

  it("leaves an unreadable archive alone and still clears the notes", async () => {
    const note = await createNote(git, "main", draft());
    // A directory at the archive path makes readFile fail with EISDIR
    await mkdir(archivePath());

    const result = await deleteNotes(git, "main", [note.id]);

    expect(result.deleted).toBe(1);
    expect(result.archive?.state).toBe("failed");
    if (result.archive?.state === "failed") {
      expect(result.archive.error).not.toBe("");
      expect(result.archive.asidePath).toBeUndefined();
    }
    const entries = await readdir(contractDir());
    expect(entries.filter((e) => e.includes(".corrupt-"))).toEqual([]);
    expect((await stat(archivePath())).isDirectory()).toBe(true);
    const loaded = await loadNotes(git, "main");
    expect(loaded.state === "ok" && loaded.file.notes).toEqual([]);
    await expect(
      git.run(["rev-parse", "--verify", reviewNotesRefForBranch("main")]),
    ).rejects.toThrow();
  });

  it.skipIf(skipAsRoot)(
    "reports a write failure without touching the archive",
    async () => {
      const note = await createNote(git, "main", draft());
      const before = JSON.stringify({ version: 1, notes: [] }, null, 2) + "\n";
      await writeFile(archivePath(), before);

      await chmod(contractDir(), 0o555);
      let outcome;
      try {
        outcome = await archiveNotes(
          git,
          "main",
          [note],
          "2026-08-19T15:30:00.123Z",
        );
      } finally {
        await chmod(contractDir(), 0o755);
      }

      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") {
        expect(outcome.error).not.toBe("");
        expect(outcome.asidePath).toBeUndefined();
      }
      expect(await readFile(archivePath(), "utf8")).toBe(before);
      expect(
        (await readdir(contractDir())).filter((e) => e.endsWith(".tmp")),
      ).toEqual([]);
    },
  );

  it.skipIf(skipAsRoot)(
    "reports a failed move-aside with no aside path and the corrupt file intact",
    async () => {
      const note = await createNote(git, "main", draft());
      await writeFile(archivePath(), "{ nope");

      await chmod(contractDir(), 0o555);
      let outcome;
      try {
        outcome = await archiveNotes(
          git,
          "main",
          [note],
          "2026-08-19T15:30:00.123Z",
        );
      } finally {
        await chmod(contractDir(), 0o755);
      }

      expect(outcome.state).toBe("failed");
      if (outcome.state === "failed") {
        expect(outcome.asidePath).toBeUndefined();
      }
      expect(await readFile(archivePath(), "utf8")).toBe("{ nope");
      expect(
        (await readdir(contractDir())).filter((e) => e.includes(".corrupt-")),
      ).toEqual([]);
    },
  );

  it("deleteNote never archives", async () => {
    const note = await createNote(git, "main", draft());
    await deleteNote(git, "main", note.id);
    expect(await archiveExists()).toBe(false);
  });

  it("deleteReviewerTurn never archives, only turn included", async () => {
    const solo = await createNote(git, "main", draft());
    expect(await deleteReviewerTurn(git, "main", solo.id, 0)).toBeUndefined();
    expect(await archiveExists()).toBe(false);

    const multi = await createNote(git, "main", draft({ text: "first" }));
    await appendReviewerTurn(git, "main", multi.id, "second");
    await deleteReviewerTurn(git, "main", multi.id, 1);
    expect(await archiveExists()).toBe(false);
  });

  it("setResolved never archives", async () => {
    const note = await createNote(git, "main", draft());
    await setResolved(git, "main", note.id, true);
    await setResolved(git, "main", note.id, false);
    expect(await archiveExists()).toBe(false);
  });
});

describe("archiveWarning", () => {
  // Pure formatting: no repo, no fs — the temp repo from beforeEach is unused
  const asidePath = "/repo/.git/delta-review/archive-main.json.corrupt-stamp";
  const asideName = "archive-main.json.corrupt-stamp";

  it("says nothing when there is nothing to report", () => {
    expect(archiveWarning(undefined, 0)).toBeUndefined();
    expect(archiveWarning({ state: "archived" }, 3)).toBeUndefined();
  });

  it("names only the aside file's basename when the archive was moved aside", () => {
    const message = archiveWarning({ state: "moved-aside", asidePath }, 2);
    expect(message).toBe(
      `Delta Review: the review-note archive for this branch could not be parsed and was moved aside to ${asideName}; a fresh archive was started with the cleared notes.`,
    );
    // The reviewer gets a file name, not a path into the git dir
    expect(message).not.toContain("/repo/.git");
  });

  it("carries the count and the error when the archive write failed", () => {
    expect(
      archiveWarning({ state: "failed", error: "EACCES: denied" }, 1),
    ).toBe(
      "Delta Review: cleared 1 resolved note, but could not archive them (EACCES: denied).",
    );
    expect(
      archiveWarning({ state: "failed", error: "EACCES: denied" }, 4),
    ).toBe(
      "Delta Review: cleared 4 resolved notes, but could not archive them (EACCES: denied).",
    );
  });

  it("names the aside file when a move-aside preceded the failure", () => {
    expect(
      archiveWarning({ state: "failed", error: "ENOSPC", asidePath }, 2),
    ).toBe(
      `Delta Review: cleared 2 resolved notes, but could not archive them (ENOSPC); the previous archive was moved aside to ${asideName}.`,
    );
  });

  it("prefixes every message with the extension name", () => {
    const messages = [
      archiveWarning({ state: "moved-aside", asidePath }, 1),
      archiveWarning({ state: "failed", error: "boom" }, 1),
      archiveWarning({ state: "failed", error: "boom", asidePath }, 2),
    ];
    for (const message of messages) {
      expect(message?.startsWith("Delta Review: ")).toBe(true);
    }
  });
});

describe("refreshDerived", () => {
  const loadedNotes = async (): Promise<NotesFile> => {
    const result = await loadNotes(git, "main");
    if (result.state !== "ok") {
      throw new Error(`expected notes, got ${result.state}`);
    }
    return result.file;
  };

  it("short-circuits without diffing when content is unchanged", async () => {
    await createNote(git, "main", draft());
    const spy = spyingGit();
    const refreshed = await refreshDerived(
      spy.git,
      "main",
      await loadedNotes(),
      undefined,
      refreshOptions(),
    );
    expect(spy.commands).not.toContain("diff");
    expect(refreshed.notes[0].outdated).toBe(false);
    expect(refreshed.notes[0].currentStartLine).toBe(2);
    expect(refreshed.notes[0].currentEndLine).toBe(3);
  });

  it("shifts the current range for an edit above the note (real git diff)", async () => {
    await createNote(git, "main", draft());
    await writeFile(join(repoRoot, "a.txt"), "inserted\n" + fileContent);
    const refreshed = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      undefined,
      refreshOptions(),
    );
    expect(refreshed.notes[0]).toMatchObject({
      currentStartLine: 3,
      currentEndLine: 4,
      outdated: false,
      // Creation coordinates untouched
      startLine: 2,
      endLine: 3,
    });
    // Persisted
    expect((await loadedNotes()).notes[0].currentStartLine).toBe(3);
  });

  it("marks the note outdated when its own lines changed", async () => {
    await createNote(git, "main", draft());
    await writeFile(join(repoRoot, "a.txt"), "alpha\nBETA\ngamma\ndelta\n");
    const refreshed = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      undefined,
      refreshOptions(),
    );
    expect(refreshed.notes[0]).toMatchObject({
      currentStartLine: 2,
      currentEndLine: 2,
      outdated: true,
    });
  });

  it("keeps the last position and flags outdated when the file is missing", async () => {
    await createNote(git, "main", draft());
    await unlink(join(repoRoot, "a.txt"));
    const refreshed = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      undefined,
      refreshOptions(),
    );
    expect(refreshed.notes[0]).toMatchObject({
      currentStartLine: 2,
      currentEndLine: 3,
      outdated: true,
    });
  });

  it("resolves base-side notes through baseBlobFor", async () => {
    const note = await createNote(git, "main", draft({ side: "base" }));
    const baseSha = (await git.run(["rev-parse", "HEAD:a.txt"])).trim();
    // The note's own creation blob is what identifies its base document
    const lookups: Array<[string, string]> = [];
    const unchanged = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      undefined,
      refreshOptions({
        baseBlobFor: (file, contentBlob) => {
          lookups.push([file, contentBlob]);
          return baseSha;
        },
      }),
    );
    expect(lookups).toEqual([["a.txt", note.contentBlob]]);
    expect(unchanged.notes[0].outdated).toBe(false);

    // No base blob (e.g. history rewritten): outdated, position kept
    const gone = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      undefined,
      refreshOptions({
        baseBlobFor: (_file: string, _contentBlob: string) => undefined,
      }),
    );
    expect(gone.notes[0]).toMatchObject({
      currentStartLine: 2,
      currentEndLine: 3,
      outdated: true,
    });
  });

  it("remaps a base-side note when its base document advanced", async () => {
    await createNote(git, "main", draft({ side: "base" }));
    // The advanced base (a reviewed snapshot, say) gains two leading lines
    const advanced = await writeContentBlob(git, `zero\none\n${fileContent}`);
    const refreshed = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      undefined,
      refreshOptions({
        baseBlobFor: (_file: string, _contentBlob: string) => advanced,
      }),
    );
    expect(refreshed.notes[0]).toMatchObject({
      currentStartLine: 4,
      currentEndLine: 5,
      outdated: false,
    });
  });

  it("persists the merged-thread status (agent last speaker → addressed)", async () => {
    const note = await createNote(git, "main", draft());
    await writeResponses(note.id);
    const responses = await loadResponses(git, "main");
    const refreshed = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      responses.state === "ok" ? responses.file : undefined,
      refreshOptions(),
    );
    expect(refreshed.notes[0].status).toBe("addressed");
    expect((await loadedNotes()).notes[0].status).toBe("addressed");
  });

  it("does not mutate the input file and skips identical re-saves", async () => {
    await createNote(git, "main", draft());
    const input = await loadedNotes();
    const inputCopy = structuredClone(input);
    const refreshed = await refreshDerived(
      git,
      "main",
      input,
      undefined,
      refreshOptions(),
    );
    expect(input).toEqual(inputCopy);
    // The refresh persisted through saveNotes, so an identical save is
    // caught by the guard — the watcher never sees a redundant write
    expect(await saveNotes(git, "main", refreshed)).toBe(false);
  });

  it("keeps an explicit resolve through a late agent response", async () => {
    const note = await createNote(git, "main", draft());
    await setResolved(git, "main", note.id, true);
    await writeResponses(note.id);
    const refreshed = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      await loadedResponses(),
      refreshOptions(),
    );
    expect(refreshed.notes[0].status).toBe("resolved");
    expect((await loadedNotes()).notes[0].status).toBe("resolved");
  });
});

describe("anchor application", () => {
  const anchoredContent = "one\ntwo fixed\nthree\n";
  const responseAt = "2099-01-01T00:00:00.000Z";

  const loadedNotes = async (): Promise<NotesFile> => {
    const result = await loadNotes(git, "main");
    if (result.state !== "ok") {
      throw new Error(`expected notes, got ${result.state}`);
    }
    return result.file;
  };

  const refreshWithResponses = async (): Promise<NotesFile> =>
    refreshDerived(
      git,
      "main",
      await loadedNotes(),
      await loadedResponses(),
      refreshOptions(),
    );

  it("applies a resolving anchor: side flip, relocation, re-snapshot, persistence", async () => {
    const note = await createNote(git, "main", draft({ side: "base" }));
    await writeFile(join(repoRoot, "b.txt"), anchoredContent);
    await writeResponseEntries([
      {
        noteId: note.id,
        at: responseAt,
        anchor: { file: "b.txt", line: 2, snapshot: "two fixed" },
      },
    ]);
    const refreshed = await refreshWithResponses();
    const expectedBlob = await writeContentBlob(git, anchoredContent);
    expect(refreshed.notes[0]).toMatchObject({
      side: "working",
      file: "b.txt",
      startLine: 2,
      endLine: 2,
      currentStartLine: 2,
      currentEndLine: 2,
      snapshot: ["two fixed"],
      contentBlob: expectedBlob,
      outdated: false,
      status: "addressed",
      appliedAnchorAt: responseAt,
    });
    // Persisted, including the one-shot guard field
    expect((await loadedNotes()).notes[0].appliedAnchorAt).toBe(responseAt);
    // The re-snapshot blob is re-anchored on the notes ref in the same pass
    const tree = await git.run([
      "ls-tree",
      "-r",
      reviewNotesRefForBranch("main"),
    ]);
    expect(tree).toContain(expectedBlob);
  });

  it("is one-shot: a second refresh does not re-apply the same anchor", async () => {
    const note = await createNote(git, "main", draft());
    await writeFile(join(repoRoot, "b.txt"), anchoredContent);
    await writeResponseEntries([
      {
        noteId: note.id,
        at: responseAt,
        anchor: { file: "b.txt", line: 2, snapshot: "two fixed" },
      },
    ]);
    const first = await refreshWithResponses();
    const second = await refreshWithResponses();
    expect(second).toEqual(first);
    // Identical derived state — the guard makes the re-save a no-op write
    expect(await saveNotes(git, "main", second)).toBe(false);
  });

  it("applies a newer anchor over an already-applied older one", async () => {
    const note = await createNote(git, "main", draft());
    await writeFile(join(repoRoot, "b.txt"), anchoredContent);
    await writeResponseEntries([
      {
        noteId: note.id,
        at: responseAt,
        anchor: { file: "b.txt", line: 2, snapshot: "two fixed" },
      },
    ]);
    await refreshWithResponses();
    const laterAt = "2099-02-01T00:00:00.000Z";
    await writeResponseEntries([
      {
        noteId: note.id,
        at: responseAt,
        anchor: { file: "b.txt", line: 2, snapshot: "two fixed" },
      },
      {
        noteId: note.id,
        at: laterAt,
        anchor: { file: "b.txt", line: 3, snapshot: "three" },
      },
    ]);
    const refreshed = await refreshWithResponses();
    expect(refreshed.notes[0]).toMatchObject({
      startLine: 3,
      endLine: 3,
      snapshot: ["three"],
      appliedAnchorAt: laterAt,
    });
  });

  it("ignores a dangling anchor to a missing file entirely", async () => {
    const note = await createNote(git, "main", draft());
    await writeResponseEntries([
      {
        noteId: note.id,
        at: responseAt,
        anchor: { file: "missing.txt", line: 1, snapshot: "gone" },
      },
    ]);
    const refreshed = await refreshWithResponses();
    expect(refreshed.notes[0]).toMatchObject({
      side: "working",
      file: "a.txt",
      startLine: 2,
      endLine: 3,
      snapshot: ["beta", "gamma"],
      contentBlob: note.contentBlob,
      // The response still merges as an agent turn — only the anchor is
      // ignored
      status: "addressed",
    });
    expect(refreshed.notes[0].appliedAnchorAt).toBeUndefined();
  });

  it("treats a traversal anchor as dangling even when an injected resolver accepts it", async () => {
    const note = await createNote(git, "main", draft());
    await writeResponseEntries([
      {
        noteId: note.id,
        at: responseAt,
        anchor: { file: "../outside.txt", line: 1, snapshot: "outside" },
      },
    ]);
    const defaults = refreshOptions();
    const refreshed = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      await loadedResponses(),
      refreshOptions({
        // Even a readable escape target must never be applied
        readWorkingContent: async (file) =>
          file === "../outside.txt"
            ? "outside\n"
            : defaults.readWorkingContent(file),
        anchorResolves: () => true,
      }),
    );
    expect(refreshed.notes[0]).toMatchObject({
      side: "working",
      file: "a.txt",
      startLine: 2,
      endLine: 3,
      contentBlob: note.contentBlob,
      // The response still merges as an agent turn — only the anchor is
      // ignored
      status: "addressed",
    });
    expect(refreshed.notes[0].appliedAnchorAt).toBeUndefined();
  });

  it("ignores an anchor whose line is beyond the file's line count", async () => {
    const note = await createNote(git, "main", draft());
    await writeResponseEntries([
      {
        noteId: note.id,
        at: responseAt,
        anchor: { file: "a.txt", line: 99, snapshot: "nope" },
      },
    ]);
    const refreshed = await refreshWithResponses();
    expect(refreshed.notes[0]).toMatchObject({
      startLine: 2,
      endLine: 3,
      contentBlob: note.contentBlob,
    });
    expect(refreshed.notes[0].appliedAnchorAt).toBeUndefined();
  });
});

describe("buildAnchorResolver", () => {
  const responsesWith = (
    anchors: Array<{ file: string; line: number }>,
  ): ResponsesFile => ({
    version: 1,
    responses: anchors.map((anchor, index) => ({
      noteId: `note-${index}`,
      response: "done",
      at: "2099-01-01T00:00:00.000Z",
      anchor: { ...anchor, snapshot: "" },
    })),
  });

  const readContent = async (file: string): Promise<string | undefined> => {
    if (file === "trailing.txt") {
      return "a\nb\nc\n";
    }
    if (file === "no-trailing.txt") {
      return "a\nb";
    }
    return undefined;
  };

  it("resolves within the line count, rejects beyond it and missing files", async () => {
    const resolves = await buildAnchorResolver(
      responsesWith([
        { file: "trailing.txt", line: 1 },
        { file: "no-trailing.txt", line: 1 },
        { file: "missing.txt", line: 1 },
      ]),
      readContent,
    );
    expect(resolves({ file: "trailing.txt", line: 3, snapshot: "" })).toBe(
      true,
    );
    expect(resolves({ file: "trailing.txt", line: 4, snapshot: "" })).toBe(
      false,
    );
    expect(resolves({ file: "no-trailing.txt", line: 2, snapshot: "" })).toBe(
      true,
    );
    expect(resolves({ file: "no-trailing.txt", line: 3, snapshot: "" })).toBe(
      false,
    );
    expect(resolves({ file: "missing.txt", line: 1, snapshot: "" })).toBe(
      false,
    );
  });

  it("treats every anchor as dangling with no responses", async () => {
    const resolves = await buildAnchorResolver(undefined, readContent);
    expect(resolves({ file: "trailing.txt", line: 1, snapshot: "" })).toBe(
      false,
    );
  });

  it("rejects non-repo-relative anchor paths without ever reading them", async () => {
    const readAttempts: string[] = [];
    const readAnything = async (file: string): Promise<string> => {
      readAttempts.push(file);
      return "a\nb\nc\n";
    };
    const badPaths = [
      "../outside.txt",
      "nested/../../outside.txt",
      "/etc/passwd",
      "..\\outside.txt",
      "nested\\file.txt",
      "C:\\outside.txt",
      "C:/outside.txt",
      "./a.txt",
      "",
    ];
    const resolves = await buildAnchorResolver(
      responsesWith(badPaths.map((file) => ({ file, line: 1 }))),
      readAnything,
    );
    for (const file of badPaths) {
      expect(resolves({ file, line: 1, snapshot: "" })).toBe(false);
    }
    expect(readAttempts).toEqual([]);
  });
});
