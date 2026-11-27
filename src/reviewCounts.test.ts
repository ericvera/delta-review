import { describe, expect, it } from "vitest";
import { FileReviewStatus, ReviewFile } from "./model";
import { badgeFor, reviewCounts, statusBarText } from "./reviewCounts";

const file = (
  path: string,
  overrides: Partial<ReviewFile> = {},
): ReviewFile => ({
  path,
  status: FileReviewStatus.NeedsReview,
  deleted: false,
  existsInMergeBase: true,
  diffBaseIsReviewedSnapshot: false,
  hasReviewSnapshot: false,
  diffBaseSha: undefined,
  diffBasePath: path,
  movedFrom: undefined,
  moveOrigin: undefined,
  moveDeclared: false,
  donor: undefined,
  moveNote: undefined,
  originLinesOutOfRange: false,
  moveClassification: undefined,
  originContentUnavailable: false,
  triage: "normal",
  reviewLevel: "review",
  ...overrides,
});

const reviewed = { status: FileReviewStatus.Reviewed } as const;
const auto = { triage: "auto" } as const;

describe("reviewCounts", () => {
  it("excludes auto files of either status", () => {
    expect(
      reviewCounts([
        file("a.ts"),
        file("b.ts", reviewed),
        file("c.ts"),
        file(".mise/x.md", auto),
        file(".mise/y.md", { ...auto, ...reviewed }),
      ]),
    ).toEqual({ reviewed: 1, total: 3, needsReview: 2 });
  });

  it("reports full progress when only auto files still need review", () => {
    expect(
      reviewCounts([
        file("a.ts", reviewed),
        file(".mise/x.md", auto),
        file(".mise/y.md", auto),
      ]),
    ).toEqual({ reviewed: 1, total: 1, needsReview: 0 });
  });

  it("counts nothing when every file is auto", () => {
    expect(
      reviewCounts([file(".mise/x.md", auto), file("gen.ts", auto)]),
    ).toEqual({ reviewed: 0, total: 0, needsReview: 0 });
  });
});

describe("badgeFor", () => {
  it("clears the badge when nothing needs review", () => {
    expect(badgeFor({ reviewed: 2, total: 2, needsReview: 0 })).toBeUndefined();
  });

  it("uses the singular for one file", () => {
    expect(badgeFor({ reviewed: 0, total: 1, needsReview: 1 })).toEqual({
      value: 1,
      tooltip: "1 file to review",
    });
  });

  it("uses the plural for several files", () => {
    expect(badgeFor({ reviewed: 1, total: 4, needsReview: 3 })).toEqual({
      value: 3,
      tooltip: "3 files to review",
    });
  });
});

describe("statusBarText", () => {
  it("shows reviewed over total", () => {
    expect(statusBarText({ reviewed: 1, total: 3, needsReview: 2 })).toBe(
      "$(checklist) Review 1/3",
    );
  });

  it("shows 0/0 with no countable files", () => {
    expect(statusBarText({ reviewed: 0, total: 0, needsReview: 0 })).toBe(
      "$(checklist) Review 0/0",
    );
  });
});
