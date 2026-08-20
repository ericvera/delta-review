import { describe, expect, it } from "vitest";
import { FileReviewStatus, ReviewFile } from "./model";
import {
  autoGroupContextValue,
  fileContextValue,
  folderContextValue,
} from "./rowContext";

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
  donor: undefined,
  moveNote: undefined,
  moveClassification: undefined,
  originContentUnavailable: false,
  triage: "normal",
  ...overrides,
});

const reviewedFile = (
  path: string,
  overrides: Partial<ReviewFile> = {},
): ReviewFile =>
  file(path, {
    status: FileReviewStatus.Reviewed,
    hasReviewSnapshot: true,
    ...overrides,
  });

describe("fileContextValue", () => {
  it("is needsReviewFile for a needs-review file with no snapshot", () => {
    expect(fileContextValue(file("a.ts"))).toBe("needsReviewFile");
  });

  it("adds the Snapshot token when a needs-review file holds a snapshot", () => {
    expect(fileContextValue(file("a.ts", { hasReviewSnapshot: true }))).toBe(
      "needsReviewFileSnapshot",
    );
  });

  it("orders Deleted before Snapshot", () => {
    expect(fileContextValue(file("a.ts", { deleted: true }))).toBe(
      "needsReviewFileDeleted",
    );
    expect(
      fileContextValue(
        file("a.ts", { deleted: true, hasReviewSnapshot: true }),
      ),
    ).toBe("needsReviewFileDeletedSnapshot");
  });

  it("never adds the Snapshot token to a reviewed file", () => {
    expect(fileContextValue(reviewedFile("a.ts"))).toBe("reviewedFile");
    expect(fileContextValue(reviewedFile("a.ts", { deleted: true }))).toBe(
      "reviewedFileDeleted",
    );
  });
});

describe("folderContextValue", () => {
  it("is needsReviewFolder when no file in scope holds a snapshot", () => {
    expect(
      folderContextValue([file("src/a.ts"), file("src/b.ts")], false),
    ).toBe("needsReviewFolder");
    expect(folderContextValue([], false)).toBe("needsReviewFolder");
  });

  it("is needsReviewFolderSnapshot when any file in scope holds one", () => {
    expect(
      folderContextValue(
        [file("src/a.ts"), file("src/b.ts", { hasReviewSnapshot: true })],
        false,
      ),
    ).toBe("needsReviewFolderSnapshot");
  });

  it("is reviewedFolder for a reviewed scope", () => {
    expect(folderContextValue([reviewedFile("src/a.ts")], true)).toBe(
      "reviewedFolder",
    );
  });
});

describe("autoGroupContextValue", () => {
  it("is needsReviewAutoGroup when no file in the group holds a snapshot", () => {
    expect(
      autoGroupContextValue(
        [file("yarn.lock", { triage: "auto" })],
        FileReviewStatus.NeedsReview,
      ),
    ).toBe("needsReviewAutoGroup");
    expect(autoGroupContextValue([], FileReviewStatus.NeedsReview)).toBe(
      "needsReviewAutoGroup",
    );
  });

  it("is needsReviewAutoGroupSnapshot when any file in the group holds one", () => {
    expect(
      autoGroupContextValue(
        [
          file("yarn.lock", { triage: "auto" }),
          file("out/bundle.js", { triage: "auto", hasReviewSnapshot: true }),
        ],
        FileReviewStatus.NeedsReview,
      ),
    ).toBe("needsReviewAutoGroupSnapshot");
  });

  it("is reviewedAutoGroup for the reviewed group", () => {
    expect(
      autoGroupContextValue(
        [reviewedFile("yarn.lock", { triage: "auto" })],
        FileReviewStatus.Reviewed,
      ),
    ).toBe("reviewedAutoGroup");
  });
});
