import { describe, expect, it } from "vitest";
import {
  FileNote,
  GeneralNote,
  Note,
  ResponseEntry,
  archiveFileName,
  notesFileName,
  notesFileVersion,
  parseArchiveFile,
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

describe("notesFileName / responsesFileName / archiveFileName", () => {
  it("sanitizes the branch the same way clusters filenames do", () => {
    expect(notesFileName("feat/x")).toBe("notes-feat-x.json");
    expect(responsesFileName("feat/x")).toBe("responses-feat-x.json");
    expect(archiveFileName("feature/x")).toBe("archive-feature-x.json");
  });

  it("keeps safe characters as-is", () => {
    expect(notesFileName("release-1.2_rc")).toBe("notes-release-1.2_rc.json");
    expect(archiveFileName("release-1.2_rc")).toBe(
      "archive-release-1.2_rc.json",
    );
  });

  it("never collides with the clusters- prefix", () => {
    // A branch literally named "clusters-x" still gets a distinct prefix
    expect(notesFileName("clusters-x")).toBe("notes-clusters-x.json");
    expect(responsesFileName("clusters-x")).toBe("responses-clusters-x.json");
    expect(archiveFileName("clusters-x")).toBe("archive-clusters-x.json");
    expect(notesFileName("main").startsWith("clusters-")).toBe(false);
    expect(responsesFileName("main").startsWith("clusters-")).toBe(false);
    expect(archiveFileName("main").startsWith("clusters-")).toBe(false);
  });

  it("never collides with the notes- or responses- prefixes", () => {
    expect(archiveFileName("notes-x")).toBe("archive-notes-x.json");
    expect(archiveFileName("responses-x")).toBe("archive-responses-x.json");
    expect(archiveFileName("main").startsWith("notes-")).toBe(false);
    expect(archiveFileName("main").startsWith("responses-")).toBe(false);
  });
});

describe("parseNotesFile document notes", () => {
  const documentNote: Note = {
    ...validNote,
    file: "auth-flow.md",
    document: "clusterNotes",
    side: "working",
  };
  const v2Text = (note: Record<string, unknown>): string =>
    JSON.stringify({ version: 2, notes: [note] });

  it("parses a version 2 document note and keeps the key after file", () => {
    const result = parseNotesFile(v2Text({ ...documentNote }));
    expect(result).toEqual({
      ok: true,
      file: { version: 2, notes: [documentNote] },
    });
    if (result.ok) {
      expect(Object.keys(result.file.notes[0] ?? {}).slice(0, 4)).toEqual([
        "id",
        "file",
        "document",
        "side",
      ]);
    }
  });

  it("parses a version 2 file without document notes", () => {
    expect(parseNotesFile(v2Text({ ...validNote }))).toEqual({
      ok: true,
      file: { version: 2, notes: [validNote] },
    });
  });

  it("rejects an invalid document value", () => {
    expect(parseNotesFile(v2Text({ ...documentNote, document: "x" }))).toEqual({
      ok: false,
      error: 'note 1 ("a1b2"): "document" must be "clusterNotes" or "branch"',
    });
  });

  it.each(["../x.md", "a/b.md", "Auth.md", "x.txt"])(
    "rejects document file name %j",
    (file) => {
      expect(parseNotesFile(v2Text({ ...documentNote, file }))).toEqual({
        ok: false,
        error:
          'note 1 ("a1b2"): a document note\'s "file" must be a cluster notes file name',
      });
    },
  );

  it("rejects a base-side document note", () => {
    expect(parseNotesFile(v2Text({ ...documentNote, side: "base" }))).toEqual({
      ok: false,
      error: 'note 1 ("a1b2"): a document note\'s "side" must be "working"',
    });
  });

  const branchNote: Note = {
    ...validNote,
    file: "branch-feat-x.md",
    document: "branch",
    side: "working",
  };

  it("parses a version 2 branch document note", () => {
    expect(parseNotesFile(v2Text({ ...branchNote }))).toEqual({
      ok: true,
      file: { version: 2, notes: [branchNote] },
    });
  });

  it.each(["notes.md", "../branch-x.md", "branch-a/b.md"])(
    "rejects branch document file name %j",
    (file) => {
      expect(parseNotesFile(v2Text({ ...branchNote, file }))).toEqual({
        ok: false,
        error:
          'note 1 ("a1b2"): a branch document note\'s "file" must be a branch document file name',
      });
    },
  );

  it("rejects a base-side branch document note", () => {
    expect(parseNotesFile(v2Text({ ...branchNote, side: "base" }))).toEqual({
      ok: false,
      error: 'note 1 ("a1b2"): a document note\'s "side" must be "working"',
    });
  });

  it("writes a file holding only a branch note at version 2", () => {
    expect(notesFileVersion([branchNote])).toBe(2);
  });

  it("ignores a document key in a version 1 file", () => {
    expect(
      parseNotesFile(noteWith({ document: "clusterNotes", file: "../x" })),
    ).toEqual({
      ok: true,
      file: { version: 1, notes: [{ ...validNote, file: "../x" }] },
    });
  });
});

const fileNote: FileNote = {
  scope: "file",
  id: "f1",
  file: "src/api.ts",
  contentBlob: "4567cdef",
  turns: [{ text: "split this module", at: "2026-07-18T10:00:00Z" }],
  status: "open",
  outdated: false,
  createdAt: "2026-07-18T10:00:00Z",
};

const generalNote: GeneralNote = {
  scope: "general",
  id: "g1",
  turns: [{ text: "add a changelog entry", at: "2026-07-18T10:00:00Z" }],
  status: "addressed",
  outdated: false,
  createdAt: "2026-07-18T10:00:00Z",
};

describe("parseNotesFile scoped notes", () => {
  const documentNote: Note = {
    ...validNote,
    id: "d1",
    file: "auth-flow.md",
    document: "clusterNotes",
    side: "working",
  };
  const v3Text = (...notes: unknown[]): string =>
    JSON.stringify({ version: 3, notes });

  it("parses a version 3 file holding every note kind", () => {
    expect(
      parseNotesFile(v3Text(fileNote, generalNote, validNote, documentNote)),
    ).toEqual({
      ok: true,
      file: {
        version: 3,
        notes: [fileNote, generalNote, validNote, documentNote],
      },
    });
  });

  it("ignores scope below version 3", () => {
    expect(
      parseNotesFile(JSON.stringify({ version: 2, notes: [generalNote] })),
    ).toEqual({
      ok: false,
      error: 'note 1 ("g1"): "file" must be a non-empty string',
    });
  });

  it("rejects an unknown scope", () => {
    expect(parseNotesFile(v3Text({ ...generalNote, scope: "line" }))).toEqual({
      ok: false,
      error: 'note 1 ("g1"): "scope" must be "file" or "general"',
    });
  });

  it.each([
    ["file", 'note 1 ("f1"): "file" must be a non-empty string'],
    ["contentBlob", 'note 1 ("f1"): "contentBlob" must be a non-empty string'],
  ])("rejects a file note without %s", (key, error) => {
    expect(parseNotesFile(v3Text({ ...fileNote, [key]: undefined }))).toEqual({
      ok: false,
      error,
    });
  });

  it("validates shared fields on scoped notes", () => {
    expect(parseNotesFile(v3Text({ ...generalNote, turns: [] }))).toEqual({
      ok: false,
      error: 'note 1 ("g1"): "turns" must have at least one entry',
    });
    expect(parseNotesFile(v3Text({ ...fileNote, outdated: "no" }))).toEqual({
      ok: false,
      error: 'note 1 ("f1"): "outdated" must be a boolean',
    });
  });

  it("drops line-note keys from scoped notes", () => {
    const result = parseNotesFile(
      v3Text(
        { ...generalNote, startLine: 3, file: "x.ts", stray: true },
        { ...fileNote, side: "working", snapshot: [], document: "branch" },
      ),
    );
    expect(result).toEqual({
      ok: true,
      file: { version: 3, notes: [generalNote, fileNote] },
    });
  });
});

describe("notesFileVersion", () => {
  it("is 3 when any note is scoped", () => {
    expect(notesFileVersion([validNote, fileNote])).toBe(3);
    expect(notesFileVersion([generalNote])).toBe(3);
    expect(
      notesFileVersion([
        { ...validNote, file: "a.md", side: "working", document: "branch" },
        generalNote,
      ]),
    ).toBe(3);
  });

  it("is 1 without document notes", () => {
    expect(notesFileVersion([])).toBe(1);
    expect(notesFileVersion([validNote])).toBe(1);
  });

  it("is 2 when any note has a document", () => {
    expect(
      notesFileVersion([
        validNote,
        {
          ...validNote,
          file: "a.md",
          side: "working",
          document: "clusterNotes",
        },
      ]),
    ).toBe(2);
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
      error: 'missing "version" (extension supports 1, 2 and 3)',
    });
  });

  it.each([
    [0, "unsupported version 0 (extension supports 1, 2 and 3)"],
    [4, "unsupported version 4 (extension supports 1, 2 and 3)"],
    ["1", 'unsupported version "1" (extension supports 1, 2 and 3)'],
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

  it("round-trips an entry with pending: true", () => {
    const result = parseResponsesFile(responseWith({ pending: true }));
    expect(result).toEqual({
      ok: true,
      file: { version: 1, responses: [{ ...validResponse, pending: true }] },
    });
  });

  it("parses pending: false to an entry without the key", () => {
    const result = parseResponsesFile(responseWith({ pending: false }));
    expect(result).toEqual({
      ok: true,
      file: { version: 1, responses: [validResponse] },
    });
  });

  it("rejects a non-boolean pending", () => {
    const result = parseResponsesFile(responseWith({ pending: "yes" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"pending" must be a boolean');
    }
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

describe("parseArchiveFile", () => {
  const archiveText = (notes: unknown[]): string =>
    JSON.stringify({ version: 1, notes });

  it("accepts an empty archive", () => {
    expect(parseArchiveFile(archiveText([]))).toEqual({
      ok: true,
      file: { version: 1, notes: [] },
    });
  });

  it("carries over extra top-level keys", () => {
    expect(
      parseArchiveFile(JSON.stringify({ version: 1, notes: [1], extra: true })),
    ).toEqual({ ok: true, file: { version: 1, notes: [1], extra: true } });
  });

  it("keeps entries opaque — nothing is validated as a note", () => {
    // Entries are history: an archive written by a future version, or an
    // entry that never matched the note schema, must still round-trip
    const entries = [
      { id: "gone", deletedAt: "2026-07-18T10:00:00Z", future: { a: [1] } },
      "not even an object",
      null,
    ];
    const result = parseArchiveFile(archiveText(entries));
    expect(result.ok && result.file.notes).toEqual(entries);
  });

  it("rejects invalid JSON", () => {
    const result = parseArchiveFile("{ nope");
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
    expect(parseArchiveFile(text)).toEqual({
      ok: false,
      error: "top level must be an object",
    });
  });

  it("rejects a missing version", () => {
    expect(parseArchiveFile(JSON.stringify({ notes: [] }))).toEqual({
      ok: false,
      error: 'missing "version" (extension supports 1)',
    });
  });

  it.each([
    [0, "unsupported version 0 (extension supports 1)"],
    [2, "unsupported version 2 (extension supports 1)"],
    ["1", 'unsupported version "1" (extension supports 1)'],
  ])("rejects version %j", (version, error) => {
    expect(parseArchiveFile(JSON.stringify({ version, notes: [] }))).toEqual({
      ok: false,
      error,
    });
  });

  it("rejects non-array notes", () => {
    expect(parseArchiveFile(JSON.stringify({ version: 1, notes: {} }))).toEqual(
      { ok: false, error: '"notes" must be an array' },
    );
  });
});
