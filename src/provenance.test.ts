import { describe, expect, it } from "vitest";
import { FileReviewStatus, ReviewFile, ReviewModel } from "./model";
import { buildTooltipStatusLine } from "./moveDisplay";
import {
  buildProvenanceBody,
  provenanceEntriesFor,
  type ProvenanceBodyInput,
} from "./provenance";

const body = (overrides: Partial<ProvenanceBodyInput>): string | undefined =>
  buildProvenanceBody({
    originLine: undefined,
    moveNote: undefined,
    fileNote: undefined,
    warning: undefined,
    ...overrides,
  });

const file = (
  overrides: Partial<ReviewFile> & { path: string },
): ReviewFile => ({
  status: FileReviewStatus.NeedsReview,
  deleted: false,
  existsInMergeBase: true,
  diffBaseIsReviewedSnapshot: false,
  hasReviewSnapshot: false,
  diffBaseSha: undefined,
  diffBasePath: overrides.path,
  movedFrom: undefined,
  moveOrigin: undefined,
  moveDeclared: false,
  donor: undefined,
  moveNote: undefined,
  originLinesOutOfRange: false,
  moveClassification: undefined,
  originContentUnavailable: false,
  triage: "normal",
  ...overrides,
});

const model = (files: ReviewFile[]): ReviewModel => ({
  branch: "feat/provenance",
  mergeBase: "abc123",
  files,
  sliceShas: [],
});

describe("buildProvenanceBody", () => {
  it("joins the origin line, the move note and the file note in order", () => {
    expect(
      body({
        originLine: "Extracted from src/old/big.ts lines 120-180",
        moveNote: "Swapped its logger for ours.",
        fileNote: "Reviewer note.",
      }),
    ).toBe(
      "Extracted from src/old/big.ts lines 120-180. Swapped its logger for ours. Reviewer note.",
    );
  });

  it("terminates a lone origin line", () => {
    expect(body({ originLine: "Moved from src/old/app.ts" })).toBe(
      "Moved from src/old/app.ts.",
    );
  });

  it("leaves a note's own punctuation alone", () => {
    expect(body({ fileNote: "Read the parser first" })).toBe(
      "Read the parser first",
    );
  });

  it("does not double an origin line's existing period", () => {
    expect(body({ originLine: "Moved from src/old/app.ts." })).toBe(
      "Moved from src/old/app.ts.",
    );
  });

  it("escapes markdown in a note", () => {
    expect(body({ moveNote: "see *docs* [here](x)" })).toBe(
      "see \\*docs\\* \\[here\\]\\(x\\)",
    );
  });

  it("appends the warning after every note", () => {
    expect(
      body({
        originLine: "Extracted from src/old/big.ts lines 1-4",
        moveNote: "Trimmed the dead branch.",
        fileNote: "Skim only.",
        warning:
          "Declared lines are outside the origin. Showing the whole file.",
      }),
    ).toBe(
      "Extracted from src/old/big.ts lines 1-4. Trimmed the dead branch. Skim only. Declared lines are outside the origin. Showing the whole file.",
    );
  });

  it("treats an empty note as absent", () => {
    expect(body({ moveNote: "", fileNote: "" })).toBeUndefined();
  });
});

describe("provenanceEntriesFor", () => {
  it("gives a declared move an entry with no notes at all", () => {
    expect(
      provenanceEntriesFor(
        model([
          file({
            path: "src/new/app.ts",
            movedFrom: "src/old/app.ts",
            moveOrigin: "repo",
            moveDeclared: true,
          }),
        ]),
      ),
    ).toEqual([
      {
        path: "src/new/app.ts",
        deleted: false,
        body: "Moved from src/old/app.ts.",
      },
    ]);
  });

  it("spells out a declared extraction's origin lines", () => {
    expect(
      provenanceEntriesFor(
        model([
          file({
            path: "src/new/small.ts",
            movedFrom: "src/old/big.ts",
            moveOrigin: "repo",
            moveDeclared: true,
            moveNote: "Swapped its logger for ours.",
            originLines: [
              [120, 180],
              [200, 204],
            ],
          }),
        ]),
      )[0]?.body,
    ).toBe(
      "Extracted from src/old/big.ts lines 120-180, 200-204. Swapped its logger for ours.",
    );
  });

  it("stays silent on a rename git detected on its own", () => {
    expect(
      provenanceEntriesFor(
        model([
          file({
            path: "src/new/app.ts",
            movedFrom: "src/old/app.ts",
            moveOrigin: "repo",
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it("gives a detected rename an entry once the contract remarks on it", () => {
    const entries = provenanceEntriesFor(
      model([
        file({
          path: "src/new/app.ts",
          movedFrom: "src/old/app.ts",
          moveOrigin: "repo",
          fileNote: "Only the imports changed.",
        }),
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.body).toBe(
      "Moved from src/old/app.ts. Only the imports changed.",
    );
  });

  it("names the donor of an external declaration", () => {
    expect(
      provenanceEntriesFor(
        model([
          file({
            path: "src/new/app.ts",
            movedFrom: "packages/core/app.ts",
            moveOrigin: "external",
            moveDeclared: true,
            donor: "acme",
          }),
        ]),
      )[0]?.body,
    ).toBe("Moved from packages/core/app.ts (donor: acme).");
  });

  it("marks a deleted file's entry so its thread finds the base document", () => {
    expect(
      provenanceEntriesFor(
        model([
          file({
            path: "src/old/gone.ts",
            deleted: true,
            fileNote: "Superseded by the new parser.",
          }),
        ]),
      ),
    ).toEqual([
      {
        path: "src/old/gone.ts",
        deleted: true,
        body: "Superseded by the new parser.",
      },
    ]);
  });

  it("skips a file with nothing to say and one whose note is empty", () => {
    expect(
      provenanceEntriesFor(
        model([
          file({ path: "src/plain.ts" }),
          file({ path: "src/blank.ts", fileNote: "" }),
        ]),
      ),
    ).toEqual([]);
  });

  it("warns when the declared lines fell outside the origin", () => {
    const [entry] = provenanceEntriesFor(
      model([
        file({
          path: "src/new/small.ts",
          movedFrom: "src/old/big.ts",
          moveOrigin: "repo",
          moveDeclared: true,
          originLinesOutOfRange: true,
        }),
      ]),
    );
    expect(entry?.body).toBe(
      "Moved from src/old/big.ts. Declared lines are outside the origin. Showing the whole file.",
    );
    // Pins the wording to the tooltip's, since the two are written separately
    expect(entry?.body).toContain(
      buildTooltipStatusLine({
        moveClassification: "adapted",
        originLines: undefined,
        originContentUnavailable: false,
        originLinesOutOfRange: true,
      }),
    );
  });
});
