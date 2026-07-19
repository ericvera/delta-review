import { describe, expect, it } from "vitest";
import type { DiffHunk } from "./noteAnchor";
import { mapRangeThroughHunks, parseUnifiedDiffHunks } from "./noteAnchor";

const hunk = (
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
): DiffHunk => ({ oldStart, oldLines, newStart, newLines });

describe("parseUnifiedDiffHunks", () => {
  it("parses a single hunk with explicit counts", () => {
    expect(parseUnifiedDiffHunks("@@ -3,2 +3,5 @@")).toEqual([
      hunk(3, 2, 3, 5),
    ]);
  });

  it("parses multiple hunks in order", () => {
    const text = [
      "@@ -1,2 +1,1 @@",
      "-a",
      "-b",
      "+ab",
      "@@ -10,1 +9,4 @@",
      "-x",
      "+x1",
      "+x2",
      "+x3",
      "+x4",
    ].join("\n");
    expect(parseUnifiedDiffHunks(text)).toEqual([
      hunk(1, 2, 1, 1),
      hunk(10, 1, 9, 4),
    ]);
  });

  it("defaults omitted counts to 1", () => {
    expect(parseUnifiedDiffHunks("@@ -5 +7 @@")).toEqual([hunk(5, 1, 7, 1)]);
    expect(parseUnifiedDiffHunks("@@ -5,2 +7 @@")).toEqual([hunk(5, 2, 7, 1)]);
    expect(parseUnifiedDiffHunks("@@ -5 +7,2 @@")).toEqual([hunk(5, 1, 7, 2)]);
  });

  it("parses zero-count insertion and deletion hunks", () => {
    expect(parseUnifiedDiffHunks("@@ -4,0 +5,3 @@")).toEqual([
      hunk(4, 0, 5, 3),
    ]);
    expect(parseUnifiedDiffHunks("@@ -10,3 +9,0 @@")).toEqual([
      hunk(10, 3, 9, 0),
    ]);
    expect(parseUnifiedDiffHunks("@@ -1,3 +0,0 @@")).toEqual([
      hunk(1, 3, 0, 0),
    ]);
  });

  it("returns [] for empty or whitespace-only input", () => {
    expect(parseUnifiedDiffHunks("")).toEqual([]);
    expect(parseUnifiedDiffHunks("   \n\t\n")).toEqual([]);
  });

  it("returns [] when the diff has no hunk headers", () => {
    expect(
      parseUnifiedDiffHunks("diff --git a/f.ts b/f.ts\nindex 111..222 100644"),
    ).toEqual([]);
  });

  it("ignores non-header lines in a realistic -U0 diff", () => {
    const text = [
      "diff --git a/src/f.ts b/src/f.ts",
      "index 1111111..2222222 100644",
      "--- a/src/f.ts",
      "+++ b/src/f.ts",
      "@@ -2,0 +3,1 @@ const context = 1;",
      "+inserted",
      "@@ -7,1 +8,1 @@ more @@ context",
      "-old",
      "+new",
    ].join("\n");
    expect(parseUnifiedDiffHunks(text)).toEqual([
      hunk(2, 0, 3, 1),
      hunk(7, 1, 8, 1),
    ]);
  });

  it("does not match hunk headers mid-line", () => {
    expect(parseUnifiedDiffHunks("+text @@ -1,2 +3,4 @@")).toEqual([]);
  });
});

describe("mapRangeThroughHunks", () => {
  it.each([
    {
      name: "no hunks leaves the range unchanged",
      start: 5,
      end: 8,
      hunks: [],
      expected: { startLine: 5, endLine: 8, outdated: false },
    },
    {
      name: "note above all hunks is unchanged",
      start: 1,
      end: 3,
      hunks: [hunk(20, 2, 20, 2)],
      expected: { startLine: 1, endLine: 3, outdated: false },
    },
    {
      name: "note below an insertion shifts down",
      start: 10,
      end: 12,
      hunks: [hunk(4, 0, 5, 3)],
      expected: { startLine: 13, endLine: 15, outdated: false },
    },
    {
      name: "note below a deletion shifts up",
      start: 10,
      end: 12,
      hunks: [hunk(3, 2, 2, 0)],
      expected: { startLine: 8, endLine: 10, outdated: false },
    },
    {
      name: "multiple hunks above accumulate their deltas",
      start: 20,
      end: 21,
      hunks: [hunk(2, 0, 3, 3), hunk(8, 2, 11, 1), hunk(12, 1, 14, 1)],
      expected: { startLine: 22, endLine: 23, outdated: false },
    },
    {
      name: "insertion at the boundary just above shifts, not outdates",
      start: 5,
      end: 6,
      hunks: [hunk(4, 0, 5, 2)],
      expected: { startLine: 7, endLine: 8, outdated: false },
    },
    {
      name: "insertion at the boundary just below leaves the note alone",
      start: 5,
      end: 6,
      hunks: [hunk(6, 0, 7, 1)],
      expected: { startLine: 5, endLine: 6, outdated: false },
    },
    {
      name: "insertion right after a single-line note is not outdating",
      start: 5,
      end: 5,
      hunks: [hunk(5, 0, 6, 1)],
      expected: { startLine: 5, endLine: 5, outdated: false },
    },
    {
      name: "range inside an edited hunk is outdated",
      start: 6,
      end: 7,
      hunks: [hunk(5, 4, 5, 4)],
      expected: { startLine: 6, endLine: 6, outdated: true },
    },
    {
      name: "only the middle line changed still outdates the whole range",
      start: 5,
      end: 8,
      hunks: [hunk(6, 2, 6, 2)],
      expected: { startLine: 5, endLine: 5, outdated: true },
    },
    {
      name: "insertion strictly inside a multi-line range is outdated",
      start: 5,
      end: 8,
      hunks: [hunk(6, 0, 7, 2)],
      expected: { startLine: 5, endLine: 5, outdated: true },
    },
    {
      name: "insertion between the first and second note lines is outdated",
      start: 5,
      end: 8,
      hunks: [hunk(5, 0, 6, 1)],
      expected: { startLine: 5, endLine: 5, outdated: true },
    },
    {
      name: "edit at exactly startLine is outdated",
      start: 5,
      end: 7,
      hunks: [hunk(5, 1, 5, 1)],
      expected: { startLine: 5, endLine: 5, outdated: true },
    },
    {
      name: "edit at exactly endLine is outdated",
      start: 5,
      end: 7,
      hunks: [hunk(7, 1, 7, 1)],
      expected: { startLine: 5, endLine: 5, outdated: true },
    },
    {
      name: "rewritten start keeps its offset into the replacement",
      start: 6,
      end: 7,
      hunks: [hunk(5, 3, 5, 3)],
      expected: { startLine: 6, endLine: 6, outdated: true },
    },
    {
      name: "start offset is capped at the replacement's last line",
      start: 7,
      end: 7,
      hunks: [hunk(5, 3, 5, 1)],
      expected: { startLine: 5, endLine: 5, outdated: true },
    },
    {
      name: "fully deleted range maps to the line before the deletion",
      start: 10,
      end: 12,
      hunks: [hunk(10, 3, 9, 0)],
      expected: { startLine: 9, endLine: 9, outdated: true },
    },
    {
      name: "range deleted at the top of the file clamps to line 1",
      start: 1,
      end: 2,
      hunks: [hunk(1, 3, 0, 0)],
      expected: { startLine: 1, endLine: 1, outdated: true },
    },
    {
      name: "outdated position accounts for hunks above the note",
      start: 10,
      end: 11,
      hunks: [hunk(2, 0, 3, 3), hunk(10, 1, 13, 1)],
      expected: { startLine: 13, endLine: 13, outdated: true },
    },
    {
      name: "surviving start below a shifting hunk repositions the collapse",
      start: 8,
      end: 12,
      hunks: [hunk(3, 2, 2, 0), hunk(10, 2, 8, 2)],
      expected: { startLine: 6, endLine: 6, outdated: true },
    },
  ])("$name", ({ start, end, hunks, expected }) => {
    expect(mapRangeThroughHunks(start, end, hunks)).toEqual(expected);
  });

  it("maps notes in the same file independently", () => {
    // One edit at lines 4-5 (net -1): a note on the edit expires, a note
    // above survives untouched, a note below shifts up by one.
    const hunks = parseUnifiedDiffHunks("@@ -4,2 +4,1 @@\n-a\n-b\n+ab");
    expect(mapRangeThroughHunks(1, 2, hunks)).toEqual({
      startLine: 1,
      endLine: 2,
      outdated: false,
    });
    expect(mapRangeThroughHunks(4, 5, hunks)).toEqual({
      startLine: 4,
      endLine: 4,
      outdated: true,
    });
    expect(mapRangeThroughHunks(9, 10, hunks)).toEqual({
      startLine: 8,
      endLine: 9,
      outdated: false,
    });
  });
});
