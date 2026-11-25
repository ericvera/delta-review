import { describe, expect, it } from "vitest";
import type { FileNote, GeneralNote, Note } from "./notes";
import type { AnyNoteThread, NoteThread } from "./noteThreads";
import {
  documentNoteGroupDescription,
  documentNoteGroupLabel,
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

const fileThread = (overrides: Partial<FileNote>): AnyNoteThread => {
  const note: FileNote = {
    scope: "file",
    id: "f1",
    file: "src/a.ts",
    contentBlob: "blob",
    turns: [{ text: "whole file", at: "2026-07-01T10:00:00Z" }],
    status: "open",
    outdated: false,
    createdAt: "2026-07-01T10:00:00Z",
    ...overrides,
  };
  return {
    note,
    turns: [{ author: "reviewer", text: "whole file", at: note.createdAt }],
    status: "open",
  };
};

const generalThread = (overrides: Partial<GeneralNote>): AnyNoteThread => {
  const note: GeneralNote = {
    scope: "general",
    id: "g1",
    turns: [{ text: "overall", at: "2026-07-01T10:00:00Z" }],
    status: "open",
    outdated: false,
    createdAt: "2026-07-01T10:00:00Z",
    ...overrides,
  };
  return {
    note,
    turns: [{ author: "reviewer", text: "overall", at: note.createdAt }],
    status: "open",
  };
};

const summary = (groups: ReturnType<typeof groupNoteThreads>) =>
  groups.map((group) =>
    group.kind === "general"
      ? {
          general: true,
          ids: group.threads.map((entry) => entry.note.id),
        }
      : {
          document: group.document,
          file: group.file,
          ids: group.threads.map((entry) => entry.note.id),
        },
  );

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

  it("orders a branch group before cluster notes groups and code groups", () => {
    const groups = groupNoteThreads([
      thread({ id: "code", file: "aaa.ts" }),
      thread({ id: "cluster", file: "aaa.md", document: "clusterNotes" }),
      thread({ id: "branch", file: "zzz.md", document: "branch" }),
    ]);
    expect(summary(groups)).toEqual([
      { document: "branch", file: "zzz.md", ids: ["branch"] },
      { document: "clusterNotes", file: "aaa.md", ids: ["cluster"] },
      { document: undefined, file: "aaa.ts", ids: ["code"] },
    ]);
  });

  it("keeps a branch note and a cluster note with the same file apart", () => {
    const groups = groupNoteThreads([
      thread({ id: "cluster", file: "branch.md", document: "clusterNotes" }),
      thread({ id: "branch", file: "branch.md", document: "branch" }),
    ]);
    expect(summary(groups)).toEqual([
      { document: "branch", file: "branch.md", ids: ["branch"] },
      { document: "clusterNotes", file: "branch.md", ids: ["cluster"] },
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

  it("puts the general group first, ordered by creation", () => {
    const groups = groupNoteThreads([
      thread({ id: "code", file: "aaa.ts" }),
      thread({ id: "branch", file: "zzz.md", document: "branch" }),
      generalThread({ id: "g2", createdAt: "2026-07-02T10:00:00Z" }),
      generalThread({ id: "g1", createdAt: "2026-07-01T10:00:00Z" }),
    ]);
    expect(summary(groups)).toEqual([
      { general: true, ids: ["g1", "g2"] },
      { document: "branch", file: "zzz.md", ids: ["branch"] },
      { document: undefined, file: "aaa.ts", ids: ["code"] },
    ]);
  });

  it("omits the general group when there are no general notes", () => {
    const groups = groupNoteThreads([thread({ id: "code" })]);
    expect(groups.map((group) => group.kind)).toEqual(["file"]);
    expect(groupNoteThreads([])).toEqual([]);
  });

  it("puts file notes before line notes, ordered by creation", () => {
    const groups = groupNoteThreads([
      thread({ id: "line", currentStartLine: 1 }),
      fileThread({ id: "late", createdAt: "2026-07-03T10:00:00Z" }),
      fileThread({ id: "early", createdAt: "2026-07-02T10:00:00Z" }),
    ]);
    expect(summary(groups)).toEqual([
      {
        document: undefined,
        file: "src/a.ts",
        ids: ["early", "late", "line"],
      },
    ]);
  });
});

describe("documentNoteGroupLabel", () => {
  it("names the matching cluster", () => {
    expect(
      documentNoteGroupLabel("clusterNotes", "api-layer.md", [
        "UI",
        "API layer",
      ]),
    ).toBe("API layer — notes");
  });

  it("takes the first label when two share a slug", () => {
    expect(
      documentNoteGroupLabel("clusterNotes", "api-layer.md", [
        "API layer",
        "api: layer",
      ]),
    ).toBe("API layer — notes");
  });

  it("falls back to the file name when no label matches", () => {
    expect(documentNoteGroupLabel("clusterNotes", "api-layer.md", ["UI"])).toBe(
      "api-layer.md",
    );
    expect(documentNoteGroupLabel("clusterNotes", "api-layer.md", [])).toBe(
      "api-layer.md",
    );
  });

  it("labels a branch group Branch overview regardless of cluster labels", () => {
    expect(documentNoteGroupLabel("branch", "branch.md", ["branch"])).toBe(
      "Branch overview",
    );
    expect(documentNoteGroupLabel("branch", "branch.md", [])).toBe(
      "Branch overview",
    );
  });

  it("never matches a label whose slug is empty", () => {
    expect(documentNoteGroupLabel("clusterNotes", ".md", [""])).toBe(".md");
  });
});

describe("documentNoteGroupDescription", () => {
  it("describes a branch overview group", () => {
    expect(documentNoteGroupDescription("branch", 3)).toBe(
      "branch overview · 3",
    );
  });

  it("describes a cluster notes group", () => {
    expect(documentNoteGroupDescription("clusterNotes", 2)).toBe(
      "cluster notes · 2",
    );
  });
});

describe("notesGroupCollapseKey", () => {
  it("gives the general group a key outside the notes: namespace", () => {
    expect(notesGroupCollapseKey({ kind: "general" })).toBe("notesGeneral");
  });

  it("keeps the code group key unchanged", () => {
    expect(notesGroupCollapseKey({ kind: "file", file: "src/a.ts" })).toBe(
      "notes:src/a.ts",
    );
  });

  it("namespaces document group keys", () => {
    expect(
      notesGroupCollapseKey({
        kind: "file",
        document: "clusterNotes",
        file: "api.md",
      }),
    ).toBe("notes:clusterNotes:api.md");
  });

  it("namespaces branch group keys", () => {
    expect(
      notesGroupCollapseKey({
        kind: "file",
        document: "branch",
        file: "branch.md",
      }),
    ).toBe("notes:branch:branch.md");
  });
});
