import { describe, expect, it } from "vitest";
import { baseBlobForNote, reviewBaseUriParts } from "./baseDocument";
import { FileReviewStatus, ReviewFile, ReviewModel } from "./model";

const file = (
  overrides: Partial<ReviewFile> & { path: string },
): ReviewFile => ({
  status: FileReviewStatus.NeedsReview,
  deleted: false,
  existsInMergeBase: true,
  diffBaseIsReviewedSnapshot: false,
  diffBaseSha: undefined,
  diffBasePath: overrides.path,
  movedFrom: undefined,
  moveOrigin: undefined,
  donor: undefined,
  moveNote: undefined,
  moveClassification: undefined,
  originContentUnavailable: false,
  triage: "normal",
  ...overrides,
});

const model = (files: ReviewFile[]): ReviewModel => ({
  branch: "feat/moves",
  mergeBase: "abc123",
  files,
});

describe("baseBlobForNote", () => {
  const modified = file({ path: "src/app.ts", diffBaseSha: "aaa" });
  const snapshot = file({
    path: "src/reviewed.ts",
    status: FileReviewStatus.Reviewed,
    diffBaseIsReviewedSnapshot: true,
    diffBaseSha: "bbb",
  });
  // A repo origin's blob: the base document is identified by the old path
  const repoMove = file({
    path: "src/new/config.ts",
    diffBasePath: "src/old/config.ts",
    diffBaseSha: "ccc",
    movedFrom: "src/old/config.ts",
    moveOrigin: "repo",
    moveClassification: "verbatim",
  });
  // An external origin path never reaches the base-document identity
  const externalMove = file({
    path: "src/vendor/client.ts",
    diffBaseSha: "ddd",
    movedFrom: "../donor-app/src/http/client.ts",
    moveOrigin: "external",
    donor: "donor-app",
    moveClassification: "adapted",
  });
  const full = model([modified, snapshot, repoMove, externalMove]);

  // A declared repo move whose origin file is still in the review set: both
  // rows show `src/old/config.ts` on the left, at different blobs
  const ambiguous = (
    originSha: string | undefined,
    destinationSha: string | undefined,
  ): ReviewModel =>
    model([
      file({
        path: "src/new/config.ts",
        diffBasePath: "src/old/config.ts",
        diffBaseSha: destinationSha,
        movedFrom: "src/old/config.ts",
        moveOrigin: "repo",
      }),
      file({ path: "src/old/config.ts", diffBaseSha: originSha }),
    ]);

  it("returns the base blob of a plain modified file", () => {
    expect(baseBlobForNote(full, "src/app.ts", "aaa")).toBe("aaa");
  });

  it("returns the reviewed snapshot's blob under the file's own path", () => {
    expect(baseBlobForNote(full, "src/reviewed.ts", "bbb")).toBe("bbb");
  });

  it("keys a repo-origin move on the origin path, not the working path", () => {
    expect(baseBlobForNote(full, "src/old/config.ts", "ccc")).toBe("ccc");
    expect(baseBlobForNote(full, "src/new/config.ts", "ccc")).toBeUndefined();
  });

  it("keys an external-origin move on the file's own path", () => {
    expect(baseBlobForNote(full, "src/vendor/client.ts", "ddd")).toBe("ddd");
  });

  it("never matches a declared external move on the donor path", () => {
    expect(
      baseBlobForNote(full, "../donor-app/src/http/client.ts", "ddd"),
    ).toBeUndefined();
  });

  it("prefers the file whose base blob is the note's creation blob", () => {
    // Both orderings: the hash match wins wherever it sits in the list
    expect(
      baseBlobForNote(ambiguous("ooo", "ddd"), "src/old/config.ts", "ooo"),
    ).toBe("ooo");
    expect(
      baseBlobForNote(ambiguous("ooo", "ddd"), "src/old/config.ts", "ddd"),
    ).toBe("ddd");
  });

  it("follows a sole match whose base has advanced past the note's blob", () => {
    const advanced = model([
      file({
        path: "src/app.ts",
        status: FileReviewStatus.Reviewed,
        diffBaseIsReviewedSnapshot: true,
        diffBaseSha: "newer",
      }),
    ]);
    expect(baseBlobForNote(advanced, "src/app.ts", "older")).toBe("newer");
  });

  it("breaks a tie on the file whose own path is the note's file", () => {
    expect(
      baseBlobForNote(ambiguous("ooo", "ddd"), "src/old/config.ts", "gone"),
    ).toBe("ooo");
  });

  it("returns undefined when no tied match owns the note's path", () => {
    const shared = model([
      file({
        path: "src/a.ts",
        diffBasePath: "src/shared.ts",
        diffBaseSha: "eee",
      }),
      file({
        path: "src/b.ts",
        diffBasePath: "src/shared.ts",
        diffBaseSha: "fff",
      }),
    ]);
    expect(baseBlobForNote(shared, "src/shared.ts", "gone")).toBeUndefined();
  });

  it("returns undefined when the sole match has no base blob", () => {
    const added = model([file({ path: "src/added.ts" })]);
    expect(baseBlobForNote(added, "src/added.ts", "gone")).toBeUndefined();
  });

  it("returns undefined for a path no file shows on its base side", () => {
    expect(baseBlobForNote(full, "src/absent.ts", "aaa")).toBeUndefined();
  });
});

describe("reviewBaseUriParts", () => {
  const partsFor = (entry: ReviewFile): { path: string; query: string } =>
    reviewBaseUriParts(entry.diffBasePath, entry.diffBaseSha);

  it("differs when the same diffBasePath carries different blobs", () => {
    const first = file({
      path: "src/a.ts",
      diffBasePath: "src/shared.ts",
      diffBaseSha: "eee",
    });
    const second = file({
      path: "src/b.ts",
      diffBasePath: "src/shared.ts",
      diffBaseSha: "fff",
    });
    expect(partsFor(first)).not.toEqual(partsFor(second));
  });

  it("matches when both path and blob agree", () => {
    const first = file({
      path: "src/a.ts",
      diffBasePath: "src/shared.ts",
      diffBaseSha: "eee",
    });
    const second = file({
      path: "src/b.ts",
      diffBasePath: "src/shared.ts",
      diffBaseSha: "eee",
    });
    expect(partsFor(first)).toEqual(partsFor(second));
  });

  it("reads a missing blob as the empty document", () => {
    expect(reviewBaseUriParts("src/added.ts", undefined)).toEqual({
      path: "/src/added.ts",
      query: "empty",
    });
  });

  it("never carries an external origin path", () => {
    const external = file({
      path: "src/vendor/client.ts",
      diffBaseSha: "ddd",
      movedFrom: "../donor-app/src/http/client.ts",
      moveOrigin: "external",
    });
    expect(partsFor(external)).toEqual({
      path: "/src/vendor/client.ts",
      query: "ddd",
    });
  });
});
