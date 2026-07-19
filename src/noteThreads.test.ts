import { describe, expect, it } from "vitest";
import { mergeThreads, workSet } from "./noteThreads";
import type { NoteThread } from "./noteThreads";
import type {
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
  status: "addressed",
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

describe("workSet", () => {
  it("keeps exactly the derived-open threads, outdated included", () => {
    const open = note({ id: "n1", outdated: true });
    const addressed = note({ id: "n2" });
    const resolved = note({ id: "n3", status: "resolved" });
    const threads: NoteThread[] = mergeThreads(
      notesFile(open, addressed, resolved),
      responsesFile(response({ noteId: "n2" })),
      alwaysResolves,
    );

    expect(workSet(threads).map((thread) => thread.note.id)).toEqual(["n1"]);
  });

  it("returns empty for an empty input", () => {
    expect(workSet([])).toEqual([]);
  });
});
