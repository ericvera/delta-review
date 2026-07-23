import { describe, expect, it } from "vitest";
import {
  Note,
  ResponseEntry,
  notesFileName,
  parseNotesFile,
  parseResponsesFile,
  responsesFileName,
} from "./notes";

const validNote: Note = {
  id: "a1b2",
  file: "src/api.ts",
  side: "base",
  startLine: 3,
  endLine: 4,
  snapshot: ["const a = 1;", ""],
  contentBlob: "0123abcd",
  turns: [{ text: "why is this here?", at: "2026-07-18T10:00:00Z" }],
  status: "open",
  outdated: false,
  currentStartLine: 3,
  currentEndLine: 4,
  createdAt: "2026-07-18T10:00:00Z",
};

const notesText = (notes: unknown[]): string =>
  JSON.stringify({ version: 1, notes });

const noteWith = (overrides: Record<string, unknown>): string =>
  notesText([{ ...validNote, ...overrides }]);

const validResponse: ResponseEntry = {
  noteId: "a1b2",
  response: "Renamed the variable as suggested.",
  at: "2026-07-18T11:00:00Z",
};

const responsesText = (responses: unknown[]): string =>
  JSON.stringify({ version: 1, responses });

const responseWith = (overrides: Record<string, unknown>): string =>
  responsesText([{ ...validResponse, ...overrides }]);

describe("notesFileName / responsesFileName", () => {
  it("sanitizes the branch the same way clusters filenames do", () => {
    expect(notesFileName("feat/x")).toBe("notes-feat-x.json");
    expect(responsesFileName("feat/x")).toBe("responses-feat-x.json");
  });

  it("keeps safe characters as-is", () => {
    expect(notesFileName("release-1.2_rc")).toBe("notes-release-1.2_rc.json");
  });

  it("never collides with the clusters- prefix", () => {
    // A branch literally named "clusters-x" still gets a distinct prefix
    expect(notesFileName("clusters-x")).toBe("notes-clusters-x.json");
    expect(responsesFileName("clusters-x")).toBe("responses-clusters-x.json");
    expect(notesFileName("main").startsWith("clusters-")).toBe(false);
    expect(responsesFileName("main").startsWith("clusters-")).toBe(false);
  });
});

describe("parseNotesFile", () => {
  it("round-trips a valid notes file", () => {
    const result = parseNotesFile(notesText([validNote]));
    expect(result).toEqual({
      ok: true,
      file: { version: 1, notes: [validNote] },
    });
  });

  it("accepts an empty notes array", () => {
    expect(parseNotesFile(notesText([]))).toEqual({
      ok: true,
      file: { version: 1, notes: [] },
    });
  });

  it("preserves appliedAnchorAt when present", () => {
    const result = parseNotesFile(
      noteWith({ appliedAnchorAt: "2026-07-18T12:00:00Z" }),
    );
    expect(result).toEqual({
      ok: true,
      file: {
        version: 1,
        notes: [{ ...validNote, appliedAnchorAt: "2026-07-18T12:00:00Z" }],
      },
    });
  });

  it("omits the appliedAnchorAt key entirely when absent", () => {
    const result = parseNotesFile(notesText([validNote]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("appliedAnchorAt" in result.file.notes[0]).toBe(false);
    }
  });

  it("accepts multiple turns and empty snapshot lines", () => {
    const result = parseNotesFile(
      noteWith({
        snapshot: ["", "  ", "x"],
        endLine: 5,
        currentEndLine: 5,
        turns: [
          { text: "first", at: "2026-07-18T10:00:00Z" },
          { text: "", at: "2026-07-18T10:05:00Z" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("ignores unknown extra keys at every level", () => {
    const result = parseNotesFile(
      JSON.stringify({
        version: 1,
        generatedBy: "extension",
        notes: [
          {
            ...validNote,
            severity: "high",
            turns: [{ text: "t", at: "now", author: "eric" }],
          },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      file: {
        version: 1,
        notes: [{ ...validNote, turns: [{ text: "t", at: "now" }] }],
      },
    });
  });

  it("rejects invalid JSON", () => {
    const result = parseNotesFile("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not valid JSON");
    }
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["string", '"hi"'],
  ])("rejects a non-object top level (%s)", (_name, text) => {
    expect(parseNotesFile(text)).toEqual({
      ok: false,
      error: "top level must be an object",
    });
  });

  it("rejects a missing version", () => {
    expect(parseNotesFile(JSON.stringify({ notes: [] }))).toEqual({
      ok: false,
      error: 'missing "version" (extension supports 1)',
    });
  });

  it.each([
    [0, "unsupported version 0 (extension supports 1)"],
    [2, "unsupported version 2 (extension supports 1)"],
    ["1", 'unsupported version "1" (extension supports 1)'],
  ])("rejects version %j", (version, error) => {
    expect(parseNotesFile(JSON.stringify({ version, notes: [] }))).toEqual({
      ok: false,
      error,
    });
  });

  it("rejects non-array notes", () => {
    expect(parseNotesFile(JSON.stringify({ version: 1, notes: {} }))).toEqual({
      ok: false,
      error: '"notes" must be an array',
    });
  });

  it("rejects a non-object note entry", () => {
    expect(parseNotesFile(notesText(["nope"]))).toEqual({
      ok: false,
      error: "note 1 must be an object",
    });
  });

  it.each([
    [
      "missing id",
      { id: undefined },
      'note 1: "id" must be a non-empty string',
    ],
    ["empty id", { id: "" }, 'note 1: "id" must be a non-empty string'],
    ["non-string id", { id: 7 }, 'note 1: "id" must be a non-empty string'],
    [
      "empty file",
      { file: "" },
      'note 1 ("a1b2"): "file" must be a non-empty string',
    ],
    [
      "bad side",
      { side: "left" },
      'note 1 ("a1b2"): "side" must be "base" or "working"',
    ],
    [
      "startLine 0",
      { startLine: 0 },
      'note 1 ("a1b2"): "startLine" must be an integer >= 1',
    ],
    [
      "fractional startLine",
      { startLine: 1.5 },
      'note 1 ("a1b2"): "startLine" must be an integer >= 1',
    ],
    [
      "string startLine",
      { startLine: "3" },
      'note 1 ("a1b2"): "startLine" must be an integer >= 1',
    ],
    [
      "endLine 0",
      { endLine: 0 },
      'note 1 ("a1b2"): "endLine" must be an integer >= 1',
    ],
    [
      "endLine before startLine",
      { startLine: 5, endLine: 4, currentStartLine: 5, currentEndLine: 5 },
      'note 1 ("a1b2"): "endLine" must be >= "startLine"',
    ],
    [
      "non-array snapshot",
      { snapshot: "const a = 1;" },
      'note 1 ("a1b2"): "snapshot" must be an array of strings',
    ],
    [
      "snapshot with non-strings",
      { snapshot: ["x", 3] },
      'note 1 ("a1b2"): "snapshot" must be an array of strings',
    ],
    [
      "empty contentBlob",
      { contentBlob: "" },
      'note 1 ("a1b2"): "contentBlob" must be a non-empty string',
    ],
    [
      "non-array turns",
      { turns: "hello" },
      'note 1 ("a1b2"): "turns" must be an array',
    ],
    [
      "empty turns",
      { turns: [] },
      'note 1 ("a1b2"): "turns" must have at least one entry',
    ],
    [
      "non-object turn",
      { turns: ["hello"] },
      'note 1 ("a1b2"): turn 1 must be an object',
    ],
    [
      "turn with non-string text",
      { turns: [{ text: 3, at: "now" }] },
      'note 1 ("a1b2"): turn 1: "text" must be a string',
    ],
    [
      "turn with missing at",
      { turns: [{ text: "t" }] },
      'note 1 ("a1b2"): turn 1: "at" must be a string',
    ],
    [
      "second turn invalid",
      { turns: [{ text: "t", at: "now" }, { text: "u" }] },
      'note 1 ("a1b2"): turn 2: "at" must be a string',
    ],
    [
      "bad status",
      { status: "closed" },
      'note 1 ("a1b2"): "status" must be "open", "addressed", or "resolved"',
    ],
    [
      "non-boolean outdated",
      { outdated: "no" },
      'note 1 ("a1b2"): "outdated" must be a boolean',
    ],
    [
      "currentStartLine 0",
      { currentStartLine: 0 },
      'note 1 ("a1b2"): "currentStartLine" must be an integer >= 1',
    ],
    [
      "currentEndLine before currentStartLine",
      { currentStartLine: 9, currentEndLine: 8 },
      'note 1 ("a1b2"): "currentEndLine" must be >= "currentStartLine"',
    ],
    [
      "empty createdAt",
      { createdAt: "" },
      'note 1 ("a1b2"): "createdAt" must be a non-empty string',
    ],
    [
      "non-string appliedAnchorAt",
      { appliedAnchorAt: 3 },
      'note 1 ("a1b2"): "appliedAnchorAt" must be a string',
    ],
  ])("rejects a note with %s", (_name, overrides, error) => {
    expect(parseNotesFile(noteWith(overrides))).toEqual({ ok: false, error });
  });

  it("accepts addressed and resolved statuses", () => {
    expect(parseNotesFile(noteWith({ status: "addressed" })).ok).toBe(true);
    expect(parseNotesFile(noteWith({ status: "resolved" })).ok).toBe(true);
  });

  it("reports the failing note's position among valid siblings", () => {
    const result = parseNotesFile(
      notesText([validNote, { ...validNote, id: "b2c3", side: "both" }]),
    );
    expect(result).toEqual({
      ok: false,
      error: 'note 2 ("b2c3"): "side" must be "base" or "working"',
    });
  });
});

describe("parseResponsesFile", () => {
  it("round-trips a valid responses file", () => {
    const result = parseResponsesFile(responsesText([validResponse]));
    expect(result).toEqual({
      ok: true,
      file: { version: 1, responses: [validResponse] },
    });
  });

  it("accepts an empty responses array", () => {
    expect(parseResponsesFile(responsesText([]))).toEqual({
      ok: true,
      file: { version: 1, responses: [] },
    });
  });

  it("round-trips an entry with an anchor", () => {
    const anchor = { file: "src/api.ts", line: 12, snapshot: "const b = 2;" };
    const result = parseResponsesFile(responseWith({ anchor }));
    expect(result).toEqual({
      ok: true,
      file: { version: 1, responses: [{ ...validResponse, anchor }] },
    });
  });

  it("accepts an anchor with an empty snapshot line", () => {
    const result = parseResponsesFile(
      responseWith({ anchor: { file: "a.ts", line: 1, snapshot: "" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("omits the anchor key entirely when absent", () => {
    const result = parseResponsesFile(responsesText([validResponse]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("anchor" in result.file.responses[0]).toBe(false);
    }
  });

  it("ignores unknown extra keys at every level", () => {
    const result = parseResponsesFile(
      JSON.stringify({
        version: 1,
        agent: "claude",
        responses: [
          {
            ...validResponse,
            confidence: 0.9,
            anchor: { file: "a.ts", line: 1, snapshot: "", column: 4 },
          },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      file: {
        version: 1,
        responses: [
          { ...validResponse, anchor: { file: "a.ts", line: 1, snapshot: "" } },
        ],
      },
    });
  });

  it("ignores a legacy status key on an entry", () => {
    const result = parseResponsesFile(responseWith({ status: "addressed" }));
    expect(result).toEqual({
      ok: true,
      file: { version: 1, responses: [validResponse] },
    });
  });

  it("rejects invalid JSON", () => {
    const result = parseResponsesFile("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not valid JSON");
    }
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
  ])("rejects a non-object top level (%s)", (_name, text) => {
    expect(parseResponsesFile(text)).toEqual({
      ok: false,
      error: "top level must be an object",
    });
  });

  it("rejects a missing version", () => {
    expect(parseResponsesFile(JSON.stringify({ responses: [] }))).toEqual({
      ok: false,
      error: 'missing "version" (extension supports 1)',
    });
  });

  it.each([
    [0, "unsupported version 0 (extension supports 1)"],
    [2, "unsupported version 2 (extension supports 1)"],
    ["1", 'unsupported version "1" (extension supports 1)'],
  ])("rejects version %j", (version, error) => {
    expect(
      parseResponsesFile(JSON.stringify({ version, responses: [] })),
    ).toEqual({ ok: false, error });
  });

  it("rejects non-array responses", () => {
    expect(
      parseResponsesFile(JSON.stringify({ version: 1, responses: {} })),
    ).toEqual({ ok: false, error: '"responses" must be an array' });
  });

  it("rejects a non-object response entry", () => {
    expect(parseResponsesFile(responsesText([42]))).toEqual({
      ok: false,
      error: "response 1 must be an object",
    });
  });

  it.each([
    [
      "missing noteId",
      { noteId: undefined },
      'response 1: "noteId" must be a non-empty string',
    ],
    [
      "empty noteId",
      { noteId: "" },
      'response 1: "noteId" must be a non-empty string',
    ],
    [
      "empty response",
      { response: "" },
      'response 1 ("a1b2"): "response" must be a non-empty string',
    ],
    [
      "empty at",
      { at: "" },
      'response 1 ("a1b2"): "at" must be a non-empty string',
    ],
    [
      "non-object anchor",
      { anchor: "a.ts:3" },
      'response 1 ("a1b2"): "anchor" must be an object',
    ],
    [
      "array anchor",
      { anchor: ["a.ts", 3] },
      'response 1 ("a1b2"): "anchor" must be an object',
    ],
    [
      "anchor missing file",
      { anchor: { line: 1, snapshot: "" } },
      'response 1 ("a1b2"): anchor "file" must be a non-empty string',
    ],
    [
      "anchor empty file",
      { anchor: { file: "", line: 1, snapshot: "" } },
      'response 1 ("a1b2"): anchor "file" must be a non-empty string',
    ],
    [
      "anchor line 0",
      { anchor: { file: "a.ts", line: 0, snapshot: "" } },
      'response 1 ("a1b2"): anchor "line" must be an integer >= 1',
    ],
    [
      "anchor fractional line",
      { anchor: { file: "a.ts", line: 1.5, snapshot: "" } },
      'response 1 ("a1b2"): anchor "line" must be an integer >= 1',
    ],
    [
      "anchor missing snapshot",
      { anchor: { file: "a.ts", line: 1 } },
      'response 1 ("a1b2"): anchor "snapshot" must be a string',
    ],
    [
      "anchor non-string snapshot",
      { anchor: { file: "a.ts", line: 1, snapshot: 3 } },
      'response 1 ("a1b2"): anchor "snapshot" must be a string',
    ],
  ])("rejects an entry with %s", (_name, overrides, error) => {
    expect(parseResponsesFile(responseWith(overrides))).toEqual({
      ok: false,
      error,
    });
  });

  it("reports the failing entry's position among valid siblings", () => {
    const result = parseResponsesFile(
      responsesText([validResponse, { ...validResponse, noteId: "z9" }, 7]),
    );
    expect(result).toEqual({
      ok: false,
      error: "response 3 must be an object",
    });
  });
});
