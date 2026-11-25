import { describe, expect, it } from "vitest";
import { mergeThreads } from "./noteThreads";
import type { AnyNoteThread } from "./noteThreads";
import type { Note, NoteStatus, ResponseEntry } from "./notes";
import {
  isPendingUnread,
  marksFor,
  prunedBranchMarks,
  prunedReadMarks,
  prunedRepoMarks,
  readMarkBranch,
  withReadMark,
  withRepoReadMark,
} from "./pendingRead";
import type { BranchReadMarks, RepoReadMarks } from "./pendingRead";

const note = (overrides: Partial<Note> = {}): Note => ({
  id: "n1",
  file: "src/a.ts",
  side: "working",
  startLine: 3,
  endLine: 4,
  snapshot: ["const a = 1;", "const b = 2;"],
  contentBlob: "blob-a",
  turns: [{ text: "please rename this", at: "2026-07-01T10:00:00Z" }],
  status: "open",
  outdated: false,
  currentStartLine: 3,
  currentEndLine: 4,
  createdAt: "2026-07-01T10:00:00Z",
  ...overrides,
});

const response = (overrides: Partial<ResponseEntry> = {}): ResponseEntry => ({
  noteId: "n1",
  response: "renamed it",
  at: "2026-07-01T11:00:00Z",
  ...overrides,
});

const threadsOf = (
  notes: Note[],
  responses: ResponseEntry[],
): AnyNoteThread[] =>
  mergeThreads({ version: 1, notes }, { version: 1, responses }, () => true);

const threadOf = (
  responses: ResponseEntry[],
  status: NoteStatus = "open",
  id = "n1",
): AnyNoteThread => {
  const [thread] = threadsOf(
    [note({ id, status })],
    responses.map((entry) => ({ ...entry, noteId: id })),
  );
  if (thread === undefined) {
    throw new Error("no thread");
  }
  return thread;
};

const pendingThread = (id = "n1"): AnyNoteThread =>
  threadOf(
    [
      response({ at: "2026-07-01T11:00:00Z" }),
      response({ at: "2026-07-01T12:00:00Z", pending: true }),
    ],
    "open",
    id,
  );

describe("isPendingUnread", () => {
  it("is true for an unmarked pending note", () => {
    expect(isPendingUnread(pendingThread(), {})).toBe(true);
  });

  it("is false when marked at the newest agent turn", () => {
    expect(
      isPendingUnread(pendingThread(), { n1: "2026-07-01T12:00:00Z" }),
    ).toBe(false);
  });

  it("is true when a newer pending reply arrived after the mark", () => {
    expect(
      isPendingUnread(pendingThread(), { n1: "2026-07-01T11:00:00Z" }),
    ).toBe(true);
  });

  it("is false for non-pending statuses", () => {
    expect(isPendingUnread(threadOf([]), {})).toBe(false);
    expect(isPendingUnread(threadOf([response()]), {})).toBe(false);
    expect(
      isPendingUnread(threadOf([response({ pending: true })], "resolved"), {}),
    ).toBe(false);
  });
});

describe("withReadMark", () => {
  it("sets the newest agent turn's at", () => {
    expect(withReadMark({ other: "x" }, pendingThread())).toEqual({
      other: "x",
      n1: "2026-07-01T12:00:00Z",
    });
  });

  it("returns the input when the thread has no agent turn", () => {
    const marks = { other: "x" };
    expect(withReadMark(marks, threadOf([]))).toBe(marks);
  });
});

describe("prunedReadMarks", () => {
  it("drops ids absent from the threads", () => {
    expect(prunedReadMarks({ n1: "a", gone: "b" }, [pendingThread()])).toEqual({
      n1: "a",
    });
  });

  it("returns the same object when nothing was dropped", () => {
    const marks = { n1: "a" };
    expect(prunedReadMarks(marks, [pendingThread()])).toBe(marks);
  });
});

describe("prunedBranchMarks", () => {
  const threads = [pendingThread()];

  it("drops a branch absent from liveBranches", () => {
    const all: BranchReadMarks = { main: { n1: "a" }, old: { x: "b" } };
    expect(prunedBranchMarks(all, "main", threads, new Set(["main"]))).toEqual({
      main: { n1: "a" },
    });
  });

  it("keeps other branches when liveBranches is undefined", () => {
    const all: BranchReadMarks = { main: { n1: "a" }, old: { x: "b" } };
    expect(prunedBranchMarks(all, "main", threads, undefined)).toBe(all);
  });

  it("drops a branch whose map becomes empty", () => {
    const all: BranchReadMarks = { main: { gone: "a" }, other: { x: "b" } };
    expect(prunedBranchMarks(all, "main", threads, undefined)).toEqual({
      other: { x: "b" },
    });
  });

  it("prunes the current branch's ids only", () => {
    const all: BranchReadMarks = {
      main: { n1: "a", gone: "b" },
      other: { gone: "c" },
    };
    expect(prunedBranchMarks(all, "main", threads, undefined)).toEqual({
      main: { n1: "a" },
      other: { gone: "c" },
    });
  });

  it("returns the same object when nothing changed", () => {
    const all: BranchReadMarks = { main: { n1: "a" }, other: { x: "b" } };
    expect(
      prunedBranchMarks(all, "main", threads, new Set(["main", "other"])),
    ).toBe(all);
  });

  it("drops the current branch's key entirely for empty threads", () => {
    const all: BranchReadMarks = { main: { n1: "a" }, other: { x: "b" } };
    expect(prunedBranchMarks(all, "main", [], undefined)).toEqual({
      other: { x: "b" },
    });
  });
});

describe("prunedRepoMarks", () => {
  const threads = [pendingThread()];

  it("leaves another repo's map untouched", () => {
    const otherRepo = { main: { gone: "x" }, deleted: { y: "z" } };
    const all: RepoReadMarks = {
      "/a": { main: { n1: "a", gone: "b" }, deleted: { q: "r" } },
      "/b": otherRepo,
    };
    const result = prunedRepoMarks(
      all,
      "/a",
      "main",
      threads,
      new Set(["main"]),
    );
    expect(result).toEqual({ "/a": { main: { n1: "a" } }, "/b": otherRepo });
    expect(result["/b"]).toBe(otherRepo);
  });

  it("drops the repo key when its map becomes empty", () => {
    const all: RepoReadMarks = {
      "/a": { main: { gone: "b" } },
      "/b": { main: { x: "y" } },
    };
    expect(prunedRepoMarks(all, "/a", "main", threads, undefined)).toEqual({
      "/b": { main: { x: "y" } },
    });
  });

  it("returns the same object when nothing changed", () => {
    const all: RepoReadMarks = { "/a": { main: { n1: "a" } } };
    expect(prunedRepoMarks(all, "/a", "main", threads, undefined)).toBe(all);
    expect(prunedRepoMarks(all, "/c", "main", threads, undefined)).toBe(all);
  });
});

describe("withRepoReadMark / marksFor", () => {
  it("keeps a mark set in one repo invisible under another repo", () => {
    const thread = pendingThread();
    const all = withRepoReadMark({}, "/a", "main", thread);
    expect(marksFor(all, "/a", "main")).toEqual({
      n1: "2026-07-01T12:00:00Z",
    });
    expect(marksFor(all, "/b", "main")).toEqual({});
    expect(isPendingUnread(thread, marksFor(all, "/b", "main"))).toBe(true);
  });

  it("returns the input when the thread has no agent turn", () => {
    const all: RepoReadMarks = { "/a": { main: { n1: "a" } } };
    expect(withRepoReadMark(all, "/a", "main", threadOf([]))).toBe(all);
  });
});

describe("readMarkBranch", () => {
  it("strips the heads/ prefix rev-parse adds when a tag shares the name", () => {
    expect(readMarkBranch("heads/feat/x")).toBe("feat/x");
  });

  it("leaves an unambiguous branch name unchanged", () => {
    expect(readMarkBranch("feat/x")).toBe("feat/x");
  });
});
