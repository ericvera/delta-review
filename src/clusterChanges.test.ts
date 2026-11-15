import { describe, expect, it } from "vitest";
import {
  changedClusterMessage,
  clusterChangesFiles,
  clusterChangesMarkPaths,
  clusterChangesTitle,
  clusterLabelForKey,
  fileForDiffDocument,
  isRowAlreadySelected,
  nothingToReviewMessage,
  sameClusterChangesSource,
} from "./clusterChanges";
import type { ClusterModel } from "./clusters";
import { FileReviewStatus, ReviewFile } from "./model";

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
  diffBaseSha: "abc",
  diffBasePath: path,
  movedFrom: undefined,
  moveDeclared: false,
  originLinesOutOfRange: false,
  originContentUnavailable: false,
  triage: "normal",
  ...overrides,
});

const model = (...labels: string[]): ClusterModel => ({
  clusters: labels.map((label) => ({ label, summary: "", files: [] })),
  unclustered: [],
  auto: [],
});

describe("clusterLabelForKey", () => {
  const m = model("Core", "UI");

  it("labels each key kind", () => {
    expect(clusterLabelForKey(m, "unclustered")).toBe("Unclustered");
    expect(clusterLabelForKey(m, "auto")).toBe("Auto");
    expect(clusterLabelForKey(m, "c1")).toBe("UI");
  });

  it("returns an empty label for unknown and out-of-range keys", () => {
    expect(clusterLabelForKey(m, "bogus")).toBe("");
    expect(clusterLabelForKey(m, "c9")).toBe("");
  });
});

describe("clusterChangesFiles", () => {
  it("keeps needs-review files in order and drops reviewed ones", () => {
    const a = file("a");
    const b = file("b", { status: FileReviewStatus.Reviewed });
    const c = file("c");
    const result = clusterChangesFiles([a, b, c]);
    expect(result).toEqual([a, c]);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(c);
  });
});

describe("clusterChangesTitle", () => {
  it("leaves a unique label unsuffixed", () => {
    const m = model("Core", "UI");
    expect(clusterChangesTitle(m, "c0")).toBe("Cluster Changes: Core");
    expect(clusterChangesTitle(m, "unclustered")).toBe(
      "Cluster Changes: Unclustered",
    );
  });

  it("suffixes repeated real labels by index", () => {
    const m = model("Foo", "Bar", "Foo");
    expect(clusterChangesTitle(m, "c0")).toBe("Cluster Changes: Foo (1)");
    expect(clusterChangesTitle(m, "c1")).toBe("Cluster Changes: Bar");
    expect(clusterChangesTitle(m, "c2")).toBe("Cluster Changes: Foo (3)");
  });

  it("suffixes a real cluster labeled like a synthetic bucket, not the bucket", () => {
    const m = model("Auto");
    expect(clusterChangesTitle(m, "c0")).toBe("Cluster Changes: Auto (1)");
    expect(clusterChangesTitle(m, "auto")).toBe("Cluster Changes: Auto");
  });

  it("skips suffixes a label already occupies", () => {
    const m = model("Foo", "Foo", "Foo (2)");
    const titles = ["c0", "c1", "c2", "unclustered", "auto"].map((key) =>
      clusterChangesTitle(m, key),
    );
    expect(titles.slice(0, 3)).toEqual([
      "Cluster Changes: Foo (1)",
      "Cluster Changes: Foo (3)",
      "Cluster Changes: Foo (2)",
    ]);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("titles an unknown key with an empty label", () => {
    expect(clusterChangesTitle(model("Foo"), "c9")).toBe("Cluster Changes: ");
  });
});

describe("messages", () => {
  it("formats the changed-cluster message", () => {
    expect(changedClusterMessage("Core")).toBe(
      "Cluster 'Core' changed since this diff opened. Reopen it from the Delta Review pane.",
    );
  });

  it("formats the nothing-to-review message", () => {
    expect(nothingToReviewMessage("Core")).toBe(
      "No files in 'Core' need review.",
    );
  });
});

describe("sameClusterChangesSource", () => {
  const source = { repoRoot: "/x", branch: "feat" };

  it("matches the same repo root and branch", () => {
    expect(sameClusterChangesSource(source, { ...source })).toBe(true);
  });

  it("rejects a different repo root", () => {
    expect(
      sameClusterChangesSource(source, { ...source, repoRoot: "/y" }),
    ).toBe(false);
  });

  it("rejects a different branch", () => {
    expect(
      sameClusterChangesSource(source, { ...source, branch: "main" }),
    ).toBe(false);
  });
});

describe("clusterChangesMarkPaths", () => {
  const entry = {
    title: "Cluster Changes: Unclustered",
    label: "Unclustered",
    paths: ["a", "b"],
    repoRoot: "/x",
    branch: "feat",
  };
  const current = {
    title: entry.title,
    label: entry.label,
    repoRoot: entry.repoRoot,
    branch: entry.branch,
  };
  const files = [file("a"), file("b"), file("c")];
  const changed = { message: changedClusterMessage("Unclustered") };

  it("refuses when the label changed", () => {
    expect(
      clusterChangesMarkPaths(entry, { ...current, label: "Other" }, files),
    ).toEqual(changed);
  });

  it("refuses when only the title changed", () => {
    expect(
      clusterChangesMarkPaths(
        entry,
        { ...current, title: "Cluster Changes: Unclustered (2)" },
        files,
      ),
    ).toEqual(changed);
  });

  it("refuses when the repo root differs", () => {
    expect(
      clusterChangesMarkPaths(entry, { ...current, repoRoot: "/y" }, files),
    ).toEqual(changed);
  });

  it("refuses when the branch differs", () => {
    expect(
      clusterChangesMarkPaths(entry, { ...current, branch: "main" }, files),
    ).toEqual(changed);
  });

  it("marks only shown paths that still need review", () => {
    const clusterFiles = [
      file("c"),
      file("b"),
      file("a", { status: FileReviewStatus.Reviewed }),
    ];
    expect(clusterChangesMarkPaths(entry, current, clusterFiles)).toEqual({
      paths: ["b"],
    });
  });

  it("reports nothing to review when no shown path still needs review", () => {
    const clusterFiles = [
      file("a", { status: FileReviewStatus.Reviewed }),
      file("c"),
    ];
    expect(clusterChangesMarkPaths(entry, current, clusterFiles)).toEqual({
      message: nothingToReviewMessage("Unclustered"),
    });
  });
});

describe("fileForDiffDocument", () => {
  it("matches the working side", () => {
    const a = file("a");
    expect(
      fileForDiffDocument([file("b"), a], { scheme: "file", path: "a" }),
    ).toBe(a);
  });

  it("matches a left side by path and sha", () => {
    const moved = file("new", { diffBasePath: "old", diffBaseSha: "s1" });
    expect(
      fileForDiffDocument([moved], {
        scheme: "base",
        path: "old",
        query: "s1",
      }),
    ).toBe(moved);
  });

  it("misses a left side whose sha differs", () => {
    const moved = file("new", { diffBasePath: "old", diffBaseSha: "s1" });
    expect(
      fileForDiffDocument([moved], {
        scheme: "base",
        path: "old",
        query: "s2",
      }),
    ).toBeUndefined();
  });

  it("matches an empty left side", () => {
    const added = file("a", { diffBaseSha: undefined });
    expect(
      fileForDiffDocument([added], {
        scheme: "base",
        path: "a",
        query: "empty",
      }),
    ).toBe(added);
  });

  it("matches a deleted file's right side", () => {
    const gone = file("a", { deleted: true });
    expect(
      fileForDiffDocument([gone], {
        scheme: "base",
        path: "a",
        query: "empty",
      }),
    ).toBe(gone);
  });

  it("does not match a deleted file's path on the file scheme", () => {
    const gone = file("a", { deleted: true });
    expect(
      fileForDiffDocument([gone], { scheme: "file", path: "a" }),
    ).toBeUndefined();
  });

  it("returns the first match", () => {
    const moved = file("new", { diffBasePath: "old", diffBaseSha: "s1" });
    const other = file("old", { diffBaseSha: "s1" });
    expect(
      fileForDiffDocument([moved, other], {
        scheme: "base",
        path: "old",
        query: "s1",
      }),
    ).toBe(moved);
  });
});

describe("isRowAlreadySelected", () => {
  it("reports whether the path is selected", () => {
    expect(isRowAlreadySelected(["a", "b"], "b")).toBe(true);
    expect(isRowAlreadySelected(["a"], "b")).toBe(false);
    expect(isRowAlreadySelected([], "a")).toBe(false);
  });
});
