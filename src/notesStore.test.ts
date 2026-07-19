import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, Git } from "./git";
import { Note, NotesFile } from "./notes";
import {
  anchorBlobs,
  appendReviewerTurn,
  createNote,
  deleteNote,
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

const writeResponses = async (
  noteId: string,
  at = "2099-01-01T00:00:00.000Z",
): Promise<void> => {
  const dir = join(repoRoot, ".git", "delta-review");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "responses-main.json"),
    JSON.stringify({
      version: 1,
      responses: [{ noteId, status: "addressed", response: "done", at }],
    }),
  );
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
  baseBlobFor: () => undefined,
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
    const updated = await editReviewerTurn(git, "main", note.id, 0, "edited");
    expect(updated.turns[0]).toEqual({ text: "edited", at: note.turns[0].at });
  });

  it("editReviewerTurn rejects an out-of-range turn index", async () => {
    const note = await createNote(git, "main", draft());
    await expect(
      editReviewerTurn(git, "main", note.id, 5, "edited"),
    ).rejects.toThrow(/no turn at index 5/);
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
    await createNote(git, "main", draft({ side: "base" }));
    const baseSha = (await git.run(["rev-parse", "HEAD:a.txt"])).trim();
    const unchanged = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      undefined,
      refreshOptions({ baseBlobFor: () => baseSha }),
    );
    expect(unchanged.notes[0].outdated).toBe(false);

    // No base blob (e.g. history rewritten): outdated, position kept
    const gone = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      undefined,
      refreshOptions({ baseBlobFor: () => undefined }),
    );
    expect(gone.notes[0]).toMatchObject({
      currentStartLine: 2,
      currentEndLine: 3,
      outdated: true,
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

  it("re-anchors when the applyAnchors hook changes a contentBlob", async () => {
    await createNote(git, "main", draft());
    const newContent = "alpha\nbeta\ngamma\ndelta\nnew tail\n";
    await writeFile(join(repoRoot, "a.txt"), newContent);
    const newBlob = await writeContentBlob(git, newContent);
    const refreshed = await refreshDerived(
      git,
      "main",
      await loadedNotes(),
      undefined,
      refreshOptions({
        applyAnchors: (threads) => {
          // Stand-in for Task 3.3's anchor application: re-snapshot the note
          threads[0].note.contentBlob = newBlob;
        },
      }),
    );
    expect(refreshed.notes[0].contentBlob).toBe(newBlob);
    const tree = await git.run([
      "ls-tree",
      "-r",
      reviewNotesRefForBranch("main"),
    ]);
    expect(tree).toContain(newBlob);
  });
});
