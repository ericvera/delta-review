import { describe, expect, it } from "vitest";
import { parseNameStatusOutput } from "./git";

// Builds `git diff --name-status -z` output from records of NUL-terminated
// fields, e.g. ["M", "src/a.ts"] or ["R100", "old.ts", "new.ts"]
const nameStatusOutput = (records: string[][]): string =>
  records
    .map((fields) => fields.map((field) => `${field}\0`).join(""))
    .join("");

describe("parseNameStatusOutput", () => {
  it("collects paths from mixed single-path records", () => {
    const output = nameStatusOutput([
      ["A", "src/added.ts"],
      ["M", "src/modified.ts"],
      ["D", "src/deleted.ts"],
    ]);
    expect(parseNameStatusOutput(output)).toEqual({
      paths: ["src/added.ts", "src/modified.ts", "src/deleted.ts"],
      movedFrom: new Map(),
    });
  });

  it("maps a pure rename to its destination with the source excluded", () => {
    const output = nameStatusOutput([["R100", "src/old.ts", "src/new.ts"]]);
    expect(parseNameStatusOutput(output)).toEqual({
      paths: ["src/new.ts"],
      movedFrom: new Map([["src/new.ts", "src/old.ts"]]),
    });
  });

  it("handles a rename with edits (lower similarity score)", () => {
    const output = nameStatusOutput([
      ["R087", "src/before.ts", "src/after.ts"],
      ["M", "src/other.ts"],
    ]);
    expect(parseNameStatusOutput(output)).toEqual({
      paths: ["src/after.ts", "src/other.ts"],
      movedFrom: new Map([["src/after.ts", "src/before.ts"]]),
    });
  });

  it("includes a copy destination without recording a move", () => {
    const output = nameStatusOutput([["C075", "src/source.ts", "src/copy.ts"]]);
    expect(parseNameStatusOutput(output)).toEqual({
      paths: ["src/copy.ts"],
      movedFrom: new Map(),
    });
  });

  it("handles paths containing spaces", () => {
    const output = nameStatusOutput([
      ["M", "docs/read me.md"],
      ["R100", "old dir/a file.ts", "new dir/a file.ts"],
    ]);
    expect(parseNameStatusOutput(output)).toEqual({
      paths: ["docs/read me.md", "new dir/a file.ts"],
      movedFrom: new Map([["new dir/a file.ts", "old dir/a file.ts"]]),
    });
  });

  it("returns an empty result for empty output", () => {
    expect(parseNameStatusOutput("")).toEqual({
      paths: [],
      movedFrom: new Map(),
    });
  });

  it("stops silently at a truncated tail", () => {
    const complete = nameStatusOutput([["M", "src/ok.ts"]]);
    expect(parseNameStatusOutput(`${complete}D\0`)).toEqual({
      paths: ["src/ok.ts"],
      movedFrom: new Map(),
    });
    expect(
      parseNameStatusOutput(`${complete}R100\0src/only-source.ts\0`),
    ).toEqual({
      paths: ["src/ok.ts"],
      movedFrom: new Map(),
    });
  });

  it("treats unmerged and unknown statuses as single-path records", () => {
    const output = nameStatusOutput([
      ["U", "src/conflicted.ts"],
      ["Z", "src/unknown.ts"],
      ["M", "src/after.ts"],
    ]);
    expect(parseNameStatusOutput(output)).toEqual({
      paths: ["src/conflicted.ts", "src/unknown.ts", "src/after.ts"],
      movedFrom: new Map(),
    });
  });
});
