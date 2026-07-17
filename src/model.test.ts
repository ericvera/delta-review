import { describe, expect, it } from "vitest";
import { parseCheckAttrOutput } from "./model";

// Builds `git check-attr -z` output: <path NUL attr NUL value NUL> per entry
const checkAttrOutput = (entries: [path: string, value: string][]): string =>
  entries
    .map(([path, value]) => `${path}\0linguist-generated\0${value}\0`)
    .join("");

describe("parseCheckAttrOutput", () => {
  it("collects paths whose value is set or true", () => {
    const output = checkAttrOutput([
      ["gen/a.ts", "set"],
      ["gen/b.ts", "true"],
      ["src/c.ts", "unspecified"],
      ["src/d.ts", "false"],
      ["src/e.ts", "unset"],
    ]);
    expect(parseCheckAttrOutput(output)).toEqual(
      new Set(["gen/a.ts", "gen/b.ts"]),
    );
  });

  it("keeps triplets aligned across an empty attribute value", () => {
    // `path linguist-generated=` in .gitattributes yields an empty value
    // field (`path NUL attr NUL NUL`); it must not shift later triplets
    const output = checkAttrOutput([
      ["gen/empty.ts", ""],
      ["gen/real.ts", "set"],
      ["src/other.ts", "unspecified"],
    ]);
    expect(parseCheckAttrOutput(output)).toEqual(new Set(["gen/real.ts"]));
  });

  it("returns an empty set for empty output", () => {
    expect(parseCheckAttrOutput("")).toEqual(new Set());
  });
});
