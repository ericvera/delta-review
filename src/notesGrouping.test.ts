import { describe, expect, it } from "vitest";
import type { Note } from "./notes";
import type { NoteThread } from "./noteThreads";
import {
  clusterNotesDocumentLabel,
  groupNoteThreads,
  notesGroupCollapseKey,
} from "./notesGrouping";

const thread = (overrides: Partial<Note>): NoteThread => {
  const note: Note = {
    id: "n1",
    file: "src/a.ts",
    side: "working",
    startLine: 1,
    endLine: 1,
    snapshot: ["x"],
    contentBlob: "blob",
    turns: [{ text: "check", at: "2026-07-01T10:00:00Z" }],
    status: "open",
    outdated: false,
    currentStartLine: 1,
    currentEndLine: 1,
    createdAt: "2026-07-01T10:00:00Z",
    ...overrides,
  };
  return {
    note,
    turns: [{ author: "reviewer", text: "check", at: note.createdAt }],
    status: "open",
  };
};

const summary = (groups: ReturnType<typeof groupNoteThreads>) =>
  groups.map((group) => ({
    document: group.document,
    file: group.file,
    ids: group.threads.map((entry) => entry.note.id),
  }));

describe("groupNoteThreads", () => {
  it("puts document groups before code groups regardless of file name", () => {
    const groups = groupNoteThreads([
      thread({ id: "z", file: "zzz.md", document: "clusterNotes" }),
      thread({ id: "a", file: "aaa.ts" }),
      thread({ id: "y", file: "bbb.md", document: "clusterNotes" }),
    ]);
    expect(summary(groups)).toEqual([
      { document: "clusterNotes", file: "bbb.md", ids: ["y"] },
      { document: "clusterNotes", file: "zzz.md", ids: ["z"] },
      { document: undefined, file: "aaa.ts", ids: ["a"] },
    ]);
  });

  it("keeps a code note and a document note with the same file apart", () => {
    const groups = groupNoteThreads([
      thread({ id: "code", file: "api.md" }),
      thread({ id: "doc", file: "api.md", document: "clusterNotes" }),
    ]);
    expect(summary(groups)).toEqual([
      { document: "clusterNotes", file: "api.md", ids: ["doc"] },
      { document: undefined, file: "api.md", ids: ["code"] },
    ]);
  });

  it("sorts threads within a group by current start line", () => {
    const groups = groupNoteThreads([
      thread({ id: "late", currentStartLine: 20 }),
      thread({ id: "early", currentStartLine: 2 }),
      thread({ id: "mid", currentStartLine: 9 }),
    ]);
    expect(summary(groups)).toEqual([
      { document: undefined, file: "src/a.ts", ids: ["early", "mid", "late"] },
    ]);
  });
});

describe("clusterNotesDocumentLabel", () => {
  it("names the matching cluster", () => {
    expect(clusterNotesDocumentLabel("api-layer.md", ["UI", "API layer"])).toBe(
      "API layer — notes",
    );
  });

  it("takes the first label when two share a slug", () => {
    expect(
      clusterNotesDocumentLabel("api-layer.md", ["API layer", "api: layer"]),
    ).toBe("API layer — notes");
  });

  it("falls back to the file name when no label matches", () => {
    expect(clusterNotesDocumentLabel("api-layer.md", ["UI"])).toBe(
      "api-layer.md",
    );
    expect(clusterNotesDocumentLabel("api-layer.md", [])).toBe("api-layer.md");
  });

  it("never matches a label whose slug is empty", () => {
    expect(clusterNotesDocumentLabel(".md", [""])).toBe(".md");
  });
});

describe("notesGroupCollapseKey", () => {
  it("keeps the code group key unchanged", () => {
    expect(notesGroupCollapseKey({ file: "src/a.ts" })).toBe("notes:src/a.ts");
  });

  it("namespaces document group keys", () => {
    expect(
      notesGroupCollapseKey({ document: "clusterNotes", file: "api.md" }),
    ).toBe("notes:clusterNotes:api.md");
  });
});
