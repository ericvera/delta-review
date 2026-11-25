import { describe, expect, it } from "vitest";
import {
  deriveThreadStatus,
  isFileThread,
  isGeneralThread,
  isLineThread,
  mergeThreads,
  persistedStatus,
  workSet,
} from "./noteThreads";
import type { AnyNoteThread, NoteThread, ThreadTurn } from "./noteThreads";
import type {
  FileNote,
  GeneralNote,
  Note,
  NotesFile,
  ResponseAnchor,
  ResponseEntry,
  ResponsesFile,
} from "./notes";

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

const notesFile = (...notes: Note[]): NotesFile => ({ version: 1, notes });

const response = (overrides: Partial<ResponseEntry> = {}): ResponseEntry => ({
  noteId: "n1",
  response: "renamed it",
  at: "2026-07-01T11:00:00Z",
  ...overrides,
});

const responsesFile = (...responses: ResponseEntry[]): ResponsesFile => ({
  version: 1,
  responses,
});

const anchor = (overrides: Partial<ResponseAnchor> = {}): ResponseAnchor => ({
  file: "src/a.ts",
  line: 7,
  snapshot: "const renamed = 1;",
  ...overrides,
});

const alwaysResolves = (): boolean => true;
const neverResolves = (): boolean => false;

describe("mergeThreads", () => {
  it("returns open with only the reviewer turn when there are no responses", () => {
    const threads = mergeThreads(notesFile(note()), undefined, alwaysResolves);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.status).toBe("open");
    expect(threads[0]?.turns).toEqual([
      {
        author: "reviewer",
        text: "please rename this",
        at: "2026-07-01T10:00:00Z",
      },
    ]);
    expect(threads[0]?.effectiveAnchor).toBeUndefined();
  });

  it("treats an empty responses file like no responses", () => {
    const threads = mergeThreads(
      notesFile(note()),
      responsesFile(),
      alwaysResolves,
    );

    expect(threads[0]?.status).toBe("open");
    expect(threads[0]?.turns).toHaveLength(1);
  });

  it("interleaves a response chronologically and derives addressed", () => {
    const threads = mergeThreads(
      notesFile(note()),
      responsesFile(response()),
      alwaysResolves,
    );

    expect(threads[0]?.status).toBe("addressed");
    expect(threads[0]?.turns.map((turn) => turn.author)).toEqual([
      "reviewer",
      "agent",
    ]);
    expect(threads[0]?.turns[1]?.text).toBe("renamed it");
  });

  it("reopens when a reviewer follow-up is newer than the response", () => {
    const followedUp = note({
      turns: [
        { text: "please rename this", at: "2026-07-01T10:00:00Z" },
        { text: "still not right", at: "2026-07-01T12:00:00Z" },
      ],
    });
    const threads = mergeThreads(
      notesFile(followedUp),
      responsesFile(response({ at: "2026-07-01T11:00:00Z" })),
      alwaysResolves,
    );

    expect(threads[0]?.status).toBe("open");
    expect(threads[0]?.turns.map((turn) => turn.author)).toEqual([
      "reviewer",
      "agent",
      "reviewer",
    ]);
  });

  it("accumulates multiple responses for one noteId in order", () => {
    const threads = mergeThreads(
      notesFile(note()),
      responsesFile(
        response({ response: "first pass", at: "2026-07-01T11:00:00Z" }),
        response({ response: "second pass", at: "2026-07-01T12:00:00Z" }),
      ),
      alwaysResolves,
    );

    expect(threads[0]?.turns.map((turn) => turn.text)).toEqual([
      "please rename this",
      "first pass",
      "second pass",
    ]);
    expect(threads[0]?.status).toBe("addressed");
  });

  it("keeps resolved status when a later response lands, but merges the turn", () => {
    const resolved = note({ status: "resolved" });
    const threads = mergeThreads(
      notesFile(resolved),
      responsesFile(response()),
      alwaysResolves,
    );

    expect(threads[0]?.status).toBe("resolved");
    expect(threads[0]?.turns).toHaveLength(2);
    expect(threads[0]?.turns[1]?.author).toBe("agent");
  });

  it("drops responses referencing unknown note ids", () => {
    const threads = mergeThreads(
      notesFile(note()),
      responsesFile(response({ noteId: "ghost" })),
      alwaysResolves,
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.turns).toHaveLength(1);
    expect(threads[0]?.status).toBe("open");
  });

  it("sets effectiveAnchor when the anchor resolves", () => {
    const landed = anchor();
    const threads = mergeThreads(
      notesFile(note()),
      responsesFile(response({ anchor: landed })),
      alwaysResolves,
    );

    expect(threads[0]?.effectiveAnchor).toEqual(landed);
    expect(threads[0]?.turns[1]?.anchor).toEqual(landed);
  });

  it("ignores a dangling anchor entirely", () => {
    const threads = mergeThreads(
      notesFile(note()),
      responsesFile(response({ anchor: anchor() })),
      neverResolves,
    );

    expect(threads[0]?.effectiveAnchor).toBeUndefined();
  });

  it("picks the newest resolving anchor across responses", () => {
    const older = anchor({ line: 5 });
    const newer = anchor({ line: 9 });
    const threads = mergeThreads(
      notesFile(note()),
      responsesFile(
        response({ anchor: older, at: "2026-07-01T11:00:00Z" }),
        response({ anchor: newer, at: "2026-07-01T12:00:00Z" }),
      ),
      alwaysResolves,
    );

    expect(threads[0]?.effectiveAnchor).toEqual(newer);
  });

  it("falls back to the next-newest anchor when the newest dangles", () => {
    const older = anchor({ line: 5 });
    const newer = anchor({ line: 9 });
    const threads = mergeThreads(
      notesFile(note()),
      responsesFile(
        response({ anchor: older, at: "2026-07-01T11:00:00Z" }),
        response({ anchor: newer, at: "2026-07-01T12:00:00Z" }),
      ),
      (candidate) => candidate.line !== 9,
    );

    expect(threads[0]?.effectiveAnchor).toEqual(older);
  });

  it("keeps reviewer-before-agent file order on a timestamp tie", () => {
    const tied = note({
      turns: [{ text: "please rename this", at: "2026-07-01T10:00:00Z" }],
    });
    const threads = mergeThreads(
      notesFile(tied),
      responsesFile(response({ at: "2026-07-01T10:00:00Z" })),
      alwaysResolves,
    );

    expect(threads[0]?.turns.map((turn) => turn.author)).toEqual([
      "reviewer",
      "agent",
    ]);
    expect(threads[0]?.status).toBe("addressed");
  });

  it("falls back to stable file order on malformed timestamps", () => {
    const malformed = note({
      turns: [
        { text: "first", at: "not-a-date" },
        { text: "second", at: "also-not-a-date" },
      ],
    });
    const threads = mergeThreads(
      notesFile(malformed),
      responsesFile(
        response({ response: "reply one", at: "garbage" }),
        response({ response: "reply two", at: "garbage" }),
      ),
      alwaysResolves,
    );

    expect(threads[0]?.turns.map((turn) => turn.text)).toEqual([
      "first",
      "second",
      "reply one",
      "reply two",
    ]);
  });

  it("merges each note independently and preserves notes-file order", () => {
    const first = note({ id: "n1" });
    const second = note({ id: "n2", file: "src/b.ts" });
    const threads = mergeThreads(
      notesFile(first, second),
      responsesFile(response({ noteId: "n2" })),
      alwaysResolves,
    );

    expect(threads.map((thread) => thread.note.id)).toEqual(["n1", "n2"]);
    expect(threads[0]?.status).toBe("open");
    expect(threads[1]?.status).toBe("addressed");
  });

  it("derives pending when the last turn is a pending response", () => {
    const threads = mergeThreads(
      notesFile(note()),
      responsesFile(response({ pending: true })),
      alwaysResolves,
    );

    expect(threads[0]?.status).toBe("pending");
    expect(threads[0]?.turns[1]?.pending).toBe(true);
  });

  it("derives addressed when a later response is not pending", () => {
    const threads = mergeThreads(
      notesFile(note()),
      responsesFile(
        response({ pending: true, at: "2026-07-01T11:00:00Z" }),
        response({ at: "2026-07-01T12:00:00Z" }),
      ),
      alwaysResolves,
    );

    expect(threads[0]?.status).toBe("addressed");
  });

  it("derives open when a reviewer turn follows a pending response", () => {
    const followedUp = note({
      turns: [
        { text: "please rename this", at: "2026-07-01T10:00:00Z" },
        { text: "any update?", at: "2026-07-01T12:00:00Z" },
      ],
    });
    const threads = mergeThreads(
      notesFile(followedUp),
      responsesFile(response({ pending: true, at: "2026-07-01T11:00:00Z" })),
      alwaysResolves,
    );

    expect(threads[0]?.status).toBe("open");
  });

  it("keeps resolved over a pending response", () => {
    const threads = mergeThreads(
      notesFile(note({ status: "resolved" })),
      responsesFile(response({ pending: true })),
      alwaysResolves,
    );

    expect(threads[0]?.status).toBe("resolved");
  });

  it("does not mutate the input notes", () => {
    const input = note();
    const turnsBefore = input.turns;
    const threads = mergeThreads(
      notesFile(input),
      responsesFile(response()),
      alwaysResolves,
    );

    expect(threads[0]?.note).toBe(input);
    expect(input.turns).toBe(turnsBefore);
    expect(input.turns).toHaveLength(1);
    expect(input.status).toBe("open");
  });
});

const reviewerTurn: ThreadTurn = {
  author: "reviewer",
  text: "please rename this",
  at: "2026-07-01T10:00:00Z",
};
const agentTurn: ThreadTurn = {
  author: "agent",
  text: "renamed it",
  at: "2026-07-01T11:00:00Z",
};
const pendingAgentTurn: ThreadTurn = {
  author: "agent",
  text: "queued the rename",
  at: "2026-07-01T11:00:00Z",
  pending: true,
};

describe("mergeThreads scoped notes", () => {
  const fileNote: FileNote = {
    scope: "file",
    id: "f1",
    file: "src/a.ts",
    contentBlob: "blob-a",
    turns: [{ text: "split this file", at: "2026-07-01T10:00:00Z" }],
    status: "open",
    outdated: false,
    createdAt: "2026-07-01T10:00:00Z",
  };
  const generalNote: GeneralNote = {
    scope: "general",
    id: "g1",
    turns: [{ text: "add a changelog", at: "2026-07-01T10:00:00Z" }],
    status: "open",
    outdated: false,
    createdAt: "2026-07-01T10:00:00Z",
  };

  it("merges responses by noteId and never sets effectiveAnchor", () => {
    const threads = mergeThreads(
      { version: 3, notes: [fileNote, generalNote, note()] },
      responsesFile(
        response({ noteId: "f1", anchor: anchor() }),
        response({
          noteId: "g1",
          anchor: anchor(),
          pending: true,
          at: "2026-07-01T12:00:00Z",
        }),
        response({ noteId: "n1", anchor: anchor() }),
      ),
      alwaysResolves,
    );

    expect(threads.map((thread) => thread.status)).toEqual([
      "addressed",
      "pending",
      "addressed",
    ]);
    expect(threads[0]?.turns.map((turn) => turn.author)).toEqual([
      "reviewer",
      "agent",
    ]);
    expect(threads[0]?.effectiveAnchor).toBeUndefined();
    expect(threads[1]?.effectiveAnchor).toBeUndefined();
    expect(threads[2]?.effectiveAnchor).toEqual(anchor());
  });

  it("keeps an explicit resolve on a scoped note", () => {
    const threads = mergeThreads(
      { version: 3, notes: [{ ...generalNote, status: "resolved" }] },
      responsesFile(response({ noteId: "g1" })),
      alwaysResolves,
    );
    expect(threads[0]?.status).toBe("resolved");
  });

  it("narrows threads by note kind", () => {
    const threads = mergeThreads(
      { version: 3, notes: [fileNote, generalNote, note()] },
      undefined,
      alwaysResolves,
    );
    expect(threads.map(isFileThread)).toEqual([true, false, false]);
    expect(threads.map(isGeneralThread)).toEqual([false, true, false]);
    expect(threads.map(isLineThread)).toEqual([false, false, true]);
  });
});

describe("deriveThreadStatus", () => {
  it("lets an explicit resolve win over a pending last turn", () => {
    expect(
      deriveThreadStatus("resolved", [reviewerTurn, pendingAgentTurn]),
    ).toBe("resolved");
  });

  it("is pending when a pending agent turn is last", () => {
    expect(deriveThreadStatus("open", [reviewerTurn, pendingAgentTurn])).toBe(
      "pending",
    );
  });

  it("is addressed when a non-pending agent turn is last", () => {
    expect(deriveThreadStatus("open", [reviewerTurn, agentTurn])).toBe(
      "addressed",
    );
  });

  it("is open when the reviewer speaks after a pending agent turn", () => {
    expect(
      deriveThreadStatus("addressed", [
        reviewerTurn,
        pendingAgentTurn,
        { ...reviewerTurn, at: "2026-07-01T12:00:00Z" },
      ]),
    ).toBe("open");
  });
});

describe("persistedStatus", () => {
  it("stores pending as addressed and leaves the others unchanged", () => {
    expect(persistedStatus("pending")).toBe("addressed");
    expect(persistedStatus("open")).toBe("open");
    expect(persistedStatus("addressed")).toBe("addressed");
    expect(persistedStatus("resolved")).toBe("resolved");
  });
});

describe("workSet", () => {
  it("keeps exactly the derived-open and pending threads, outdated included", () => {
    const open = note({ id: "n1", outdated: true });
    const addressed = note({ id: "n2" });
    const resolved = note({ id: "n3", status: "resolved" });
    const merged: AnyNoteThread[] = mergeThreads(
      notesFile(open, addressed, resolved),
      responsesFile(response({ noteId: "n2" })),
      alwaysResolves,
    );
    const pendingTurns = [reviewerTurn, pendingAgentTurn];
    const pending: NoteThread = {
      note: note({ id: "n4", status: "addressed" }),
      turns: pendingTurns,
      status: deriveThreadStatus("addressed", pendingTurns),
    };

    expect(
      workSet([...merged, pending]).map((thread) => thread.note.id),
    ).toEqual(["n1", "n4"]);
  });

  it("returns empty for an empty input", () => {
    expect(workSet([])).toEqual([]);
  });
});
