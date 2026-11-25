import { describe, expect, it } from "vitest";
import { ClustersContract, resolveClusterModel } from "./clusters";
import { FileReviewStatus, ReviewFile, ReviewModel } from "./model";
import {
  applyPendingMarks,
  describeReviewChange,
  gitErrorReason,
  noModelMessage,
  reviewChangeFailedMessage,
  revertReviewStatus,
  withReviewStatus,
} from "./optimisticModel";

const file = (path: string, reviewed = false): ReviewFile => ({
  path,
  status: reviewed ? FileReviewStatus.Reviewed : FileReviewStatus.NeedsReview,
  deleted: false,
  existsInMergeBase: true,
  diffBaseIsReviewedSnapshot: false,
  hasReviewSnapshot: reviewed,
  diffBaseSha: undefined,
  diffBasePath: path,
  movedFrom: undefined,
  moveDeclared: false,
  originLinesOutOfRange: false,
  originContentUnavailable: false,
  triage: "normal",
  reviewLevel: "review",
});

const reviewModel = (files: ReviewFile[]): ReviewModel => ({
  branch: "feat",
  mergeBase: "abc",
  files,
  sliceShas: [],
});

const statusOf = (model: ReviewModel, path: string) => {
  const found = model.files.find((entry) => entry.path === path);
  return found && { status: found.status, snapshot: found.hasReviewSnapshot };
};

describe("withReviewStatus", () => {
  it("marks only the listed files without mutating the input", () => {
    const input = reviewModel([file("a"), file("b")]);
    const before = structuredClone(input);
    const { model } = withReviewStatus(input, ["a"], true);
    expect(statusOf(model, "a")).toEqual({
      status: FileReviewStatus.Reviewed,
      snapshot: true,
    });
    expect(statusOf(model, "b")).toEqual({
      status: FileReviewStatus.NeedsReview,
      snapshot: false,
    });
    expect(model.files[1]).toBe(input.files[1]);
    expect(input).toEqual(before);
  });

  it("unmarks only the listed files", () => {
    const input = reviewModel([file("a", true), file("b", true)]);
    const { model } = withReviewStatus(input, ["b"], false);
    expect(statusOf(model, "a")?.status).toBe(FileReviewStatus.Reviewed);
    expect(statusOf(model, "b")).toEqual({
      status: FileReviewStatus.NeedsReview,
      snapshot: false,
    });
    expect(statusOf(input, "b")?.status).toBe(FileReviewStatus.Reviewed);
  });

  it("captures the prior values", () => {
    const input = reviewModel([file("a"), file("b", true)]);
    const { prior } = withReviewStatus(input, ["a", "b"], true);
    expect(prior).toEqual(
      new Map([
        [
          "a",
          { status: FileReviewStatus.NeedsReview, hasReviewSnapshot: false },
        ],
        ["b", { status: FileReviewStatus.Reviewed, hasReviewSnapshot: true }],
      ]),
    );
  });

  it("ignores unknown paths", () => {
    const input = reviewModel([file("a")]);
    const { model, prior } = withReviewStatus(input, ["missing"], true);
    expect(model.files).toEqual(input.files);
    expect(prior.size).toBe(0);
  });
});

describe("revertReviewStatus", () => {
  it("restores only the listed paths on a different model instance", () => {
    const { prior } = withReviewStatus(
      reviewModel([file("a"), file("b")]),
      ["a"],
      true,
    );
    const current = reviewModel([file("a", true), file("b", true), file("c")]);
    const reverted = revertReviewStatus(current, prior);
    expect(statusOf(reverted, "a")).toEqual({
      status: FileReviewStatus.NeedsReview,
      snapshot: false,
    });
    expect(statusOf(reverted, "b")?.status).toBe(FileReviewStatus.Reviewed);
    expect(statusOf(current, "a")?.status).toBe(FileReviewStatus.Reviewed);
  });
});

describe("applyPendingMarks", () => {
  it("applies entries in order", () => {
    const input = reviewModel([file("a"), file("b")]);
    const result = applyPendingMarks(input, [
      { paths: ["a", "b"], reviewed: true },
      { paths: ["a"], reviewed: false },
    ]);
    expect(statusOf(result, "a")?.status).toBe(FileReviewStatus.NeedsReview);
    expect(statusOf(result, "b")?.status).toBe(FileReviewStatus.Reviewed);
  });

  it("returns the same object for an empty list", () => {
    const input = reviewModel([file("a")]);
    expect(applyPendingMarks(input, [])).toBe(input);
  });
});

describe("gitErrorReason", () => {
  const stderr =
    "fatal: cannot lock ref 'refs/review/x': Unable to create '/r/.git/refs/review/x.lock': File exists.\n";
  const expected =
    "cannot lock ref 'refs/review/x': Unable to create '/r/.git/refs/review/x.lock': File exists";
  const execError = (output: string, withStderr: boolean): Error =>
    Object.assign(
      new Error(
        `Command failed: git update-ref refs/review/x abc def\n${output}`,
      ),
      withStderr ? { stderr: Buffer.from(output) } : {},
    );

  it("reads the fatal line from stderr", () => {
    expect(gitErrorReason(execError(stderr, true))).toBe(expected);
  });

  it("reads the message lines when stderr is absent", () => {
    expect(gitErrorReason(execError(stderr, false))).toBe(expected);
  });

  it("strips an error: prefix", () => {
    expect(
      gitErrorReason(execError("hint: x\nerror: bad object.\n", true)),
    ).toBe("bad object");
  });

  it("falls back to the first non-empty stderr line", () => {
    expect(gitErrorReason(execError("\n  something odd  \nmore\n", true))).toBe(
      "something odd",
    );
  });

  it("uses a plain error's message", () => {
    expect(gitErrorReason(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(gitErrorReason("plain")).toBe("plain");
  });
});

describe("noModelMessage", () => {
  it("says loading when no reason is known", () => {
    expect(noModelMessage(undefined)).toBe(
      "Delta Review: the review is still loading — try again in a moment.",
    );
  });

  it("names the missing base", () => {
    const message = noModelMessage({
      kind: "baseMissing",
      base: "develop",
      branch: "feat",
    });
    expect(message).toBe(
      "Delta Review: nothing to mark — base develop for branch feat does not resolve. Click the base in the status bar to choose one.",
    );
    expect(message).not.toContain("loading");
  });

  it("names the base with no merge-base", () => {
    const message = noModelMessage({ kind: "mergeBaseFailed", base: "main" });
    expect(message).toBe(
      'Delta Review: nothing to mark — no merge-base with "main". Click the base in the status bar to choose another.',
    );
    expect(message).not.toContain("loading");
  });
});

describe("describeReviewChange", () => {
  it.each([
    ["file", "src/a.ts", "mark src/a.ts reviewed", "unmark src/a.ts reviewed"],
    ["folder", "src", "mark folder src reviewed", "unmark folder src"],
    ["cluster", "API", "mark cluster API reviewed", "unmark cluster API"],
    ["auto", "3", "mark 3 auto files reviewed", "unmark 3 auto files"],
    ["all", "7", "mark all 7 files reviewed", "unmark all 7 files"],
  ] as const)("phrases %s", (scope, subject, mark, unmark) => {
    expect(describeReviewChange({ reviewed: true, scope, subject })).toBe(mark);
    expect(describeReviewChange({ reviewed: false, scope, subject })).toBe(
      unmark,
    );
  });

  it("builds the failure toast text", () => {
    expect(
      reviewChangeFailedMessage(
        describeReviewChange({
          reviewed: true,
          scope: "file",
          subject: "src/notesStore.ts",
        }),
        "the review state changed in another window and the retry also failed",
      ),
    ).toBe(
      "Could not mark src/notesStore.ts reviewed: the review state changed in another window and the retry also failed. Your mark was undone.",
    );
  });
});

describe("optimistic files in grouped mode", () => {
  it("places the marked file as reviewed in its cluster bucket", () => {
    const contract: ClustersContract = {
      version: 1,
      clusters: [
        { label: "API", summary: "s", files: ["src/api.ts"], patterns: [] },
      ],
      moves: [],
      notes: new Map(),
      lineNotes: new Map(),
      levels: new Map(),
      waitPaths: [],
    };
    const input = reviewModel([file("src/api.ts"), file("README.md")]);
    const clusters = resolveClusterModel(
      contract,
      withReviewStatus(input, ["src/api.ts"], true).model.files,
    );
    expect(clusters.clusters[0].files.map((entry) => entry.status)).toEqual([
      FileReviewStatus.Reviewed,
    ]);
  });
});
