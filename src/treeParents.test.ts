import { describe, expect, it } from "vitest";
import type { ClusterModel } from "./clusters";
import { FileReviewStatus, ReviewFile } from "./model";
import { TreeContext, fileElementFor, parentOf } from "./treeParents";
import type { ReviewTreeElement } from "./treeProvider";
import type { Triage } from "./triage";

const file = (
  path: string,
  options: { status?: FileReviewStatus; triage?: Triage } = {},
): ReviewFile => ({
  path,
  status: options.status ?? FileReviewStatus.NeedsReview,
  deleted: false,
  existsInMergeBase: true,
  diffBaseIsReviewedSnapshot: false,
  diffBaseSha: undefined,
  diffBasePath: path,
  movedFrom: undefined,
  moveOrigin: undefined,
  donor: undefined,
  moveNote: undefined,
  moveClassification: undefined,
  originContentUnavailable: false,
  triage: options.triage ?? "normal",
});

const reviewed = (path: string, triage: Triage = "normal"): ReviewFile =>
  file(path, { status: FileReviewStatus.Reviewed, triage });

const clusterModel = (
  clusters: ReviewFile[][],
  unclustered: ReviewFile[] = [],
  auto: ReviewFile[] = [],
): ClusterModel => ({
  clusters: clusters.map((files, index) => ({
    label: `Cluster ${index}`,
    summary: "",
    files,
  })),
  unclustered,
  auto,
});

const ungrouped = (viewMode: TreeContext["viewMode"]): TreeContext => ({
  clusterModel: undefined,
  viewMode,
  grouped: false,
});

const grouped = (
  model: ClusterModel,
  viewMode: TreeContext["viewMode"],
): TreeContext => ({ clusterModel: model, viewMode, grouped: true });

describe("parentOf — ungrouped, list mode", () => {
  const ctx = ungrouped("list");

  it("puts a needs-review normal file directly under its status group", () => {
    expect(parentOf({ kind: "file", file: file("src/a/b.ts") }, ctx)).toEqual({
      kind: "group",
      status: FileReviewStatus.NeedsReview,
    });
  });

  it("puts a reviewed normal file under the Reviewed group", () => {
    expect(
      parentOf({ kind: "file", file: reviewed("src/a/b.ts") }, ctx),
    ).toEqual({ kind: "group", status: FileReviewStatus.Reviewed });
  });

  it("puts an auto file under the Auto subgroup of its status", () => {
    expect(
      parentOf(
        { kind: "file", file: file("dist/bundle.js", { triage: "auto" }) },
        ctx,
      ),
    ).toEqual({ kind: "autoGroup", status: FileReviewStatus.NeedsReview });
  });

  it("puts the Auto subgroup under its status group", () => {
    expect(
      parentOf({ kind: "autoGroup", status: FileReviewStatus.Reviewed }, ctx),
    ).toEqual({ kind: "group", status: FileReviewStatus.Reviewed });
  });
});

describe("parentOf — ungrouped, tree mode", () => {
  const ctx = ungrouped("tree");

  it("chains a nested file through its folders to the group", () => {
    const folder = parentOf({ kind: "file", file: file("src/a/b.ts") }, ctx);
    expect(folder).toEqual({
      kind: "folder",
      status: FileReviewStatus.NeedsReview,
      clusterKey: undefined,
      inReviewedBucket: undefined,
      path: "src/a",
    });
    const parentFolder = parentOf(folder as ReviewTreeElement, ctx);
    expect(parentFolder).toEqual({
      kind: "folder",
      status: FileReviewStatus.NeedsReview,
      clusterKey: undefined,
      inReviewedBucket: undefined,
      path: "src",
    });
    expect(parentOf(parentFolder as ReviewTreeElement, ctx)).toEqual({
      kind: "group",
      status: FileReviewStatus.NeedsReview,
    });
  });

  it("puts a top-level file directly under its group", () => {
    expect(parentOf({ kind: "file", file: file("README.md") }, ctx)).toEqual({
      kind: "group",
      status: FileReviewStatus.NeedsReview,
    });
  });

  it("keeps an auto file flat under the Auto subgroup", () => {
    expect(
      parentOf(
        { kind: "file", file: file("dist/a/bundle.js", { triage: "auto" }) },
        ctx,
      ),
    ).toEqual({ kind: "autoGroup", status: FileReviewStatus.NeedsReview });
  });

  it("scopes reviewed folders to the Reviewed group", () => {
    expect(
      parentOf({ kind: "file", file: reviewed("src/a/b.ts") }, ctx),
    ).toEqual({
      kind: "folder",
      status: FileReviewStatus.Reviewed,
      clusterKey: undefined,
      inReviewedBucket: undefined,
      path: "src/a",
    });
  });
});

describe("parentOf — grouped", () => {
  const inCluster = file("src/a/b.ts");
  const topLevelInCluster = file("README.md");
  const scattered = file("tools/x.ts");
  const autoFile = file("dist/bundle.js", { triage: "auto" });
  const reviewedInCluster = reviewed("src/a/c.ts");
  const model = clusterModel(
    [[topLevelInCluster], [inCluster, reviewedInCluster]],
    [scattered],
    [autoFile],
  );

  it("puts a needs-review cluster member under its cluster in list mode", () => {
    expect(
      parentOf({ kind: "file", file: inCluster }, grouped(model, "list")),
    ).toEqual({ kind: "cluster", clusterKey: "c1" });
  });

  it("chains a needs-review cluster member through cluster-scoped folders", () => {
    const ctx = grouped(model, "tree");
    const folder = parentOf({ kind: "file", file: inCluster }, ctx);
    expect(folder).toEqual({
      kind: "folder",
      status: undefined,
      clusterKey: "c1",
      inReviewedBucket: undefined,
      path: "src/a",
    });
    const parentFolder = parentOf(folder as ReviewTreeElement, ctx);
    expect(parentFolder).toEqual({
      kind: "folder",
      status: undefined,
      clusterKey: "c1",
      inReviewedBucket: undefined,
      path: "src",
    });
    expect(parentOf(parentFolder as ReviewTreeElement, ctx)).toEqual({
      kind: "cluster",
      clusterKey: "c1",
    });
  });

  it("puts a top-level cluster member under the cluster in tree mode", () => {
    expect(
      parentOf(
        { kind: "file", file: topLevelInCluster },
        grouped(model, "tree"),
      ),
    ).toEqual({ kind: "cluster", clusterKey: "c0" });
  });

  it("keeps Unclustered and Auto members flat in tree mode", () => {
    const ctx = grouped(model, "tree");
    expect(parentOf({ kind: "file", file: scattered }, ctx)).toEqual({
      kind: "cluster",
      clusterKey: "unclustered",
    });
    expect(parentOf({ kind: "file", file: autoFile }, ctx)).toEqual({
      kind: "cluster",
      clusterKey: "auto",
    });
  });

  it("puts a reviewed cluster member in the Reviewed bucket, not its cluster", () => {
    expect(
      parentOf(
        { kind: "file", file: reviewedInCluster },
        grouped(model, "list"),
      ),
    ).toEqual({ kind: "reviewedBucket" });
  });

  it("scopes Reviewed bucket folders to the bucket", () => {
    const ctx = grouped(model, "tree");
    const folder = parentOf({ kind: "file", file: reviewedInCluster }, ctx);
    expect(folder).toEqual({
      kind: "folder",
      status: undefined,
      clusterKey: undefined,
      inReviewedBucket: true,
      path: "src/a",
    });
    const parentFolder = parentOf(folder as ReviewTreeElement, ctx);
    expect(parentOf(parentFolder as ReviewTreeElement, ctx)).toEqual({
      kind: "reviewedBucket",
    });
  });

  it("puts a reviewed auto file in the Reviewed bucket too", () => {
    const reviewedAuto = reviewed("dist/other.js", "auto");
    expect(
      parentOf(
        { kind: "file", file: reviewedAuto },
        grouped(clusterModel([], [], [reviewedAuto]), "list"),
      ),
    ).toEqual({ kind: "reviewedBucket" });
  });

  it("ignores the cluster model when grouping is off", () => {
    expect(
      parentOf(
        { kind: "file", file: inCluster },
        { clusterModel: model, viewMode: "list", grouped: false },
      ),
    ).toEqual({ kind: "group", status: FileReviewStatus.NeedsReview });
  });
});

describe("parentOf — root and non-revealed elements", () => {
  const ctx = ungrouped("tree");

  it("returns undefined for root-level kinds and message rows", () => {
    const roots: ReviewTreeElement[] = [
      { kind: "group", status: FileReviewStatus.NeedsReview },
      { kind: "cluster", clusterKey: "c0" },
      { kind: "cluster", clusterKey: "unclustered" },
      { kind: "reviewedBucket" },
      { kind: "message", text: "All files reviewed." },
    ];
    for (const element of roots) {
      expect(parentOf(element, ctx)).toBeUndefined();
    }
  });

  it("does not throw for a file that no cluster claims", () => {
    const ctx = grouped(clusterModel([[file("src/known.ts")]]), "tree");
    expect(() =>
      parentOf({ kind: "file", file: file("src/stranger.ts") }, ctx),
    ).not.toThrow();
    expect(
      parentOf({ kind: "file", file: file("src/stranger.ts") }, ctx),
    ).toBeUndefined();
  });

  it("does not throw for a folder with no scope set", () => {
    expect(parentOf({ kind: "folder", path: "src" }, ctx)).toBeUndefined();
  });
});

describe("fileElementFor", () => {
  it("marks Auto subgroup members alwaysFlat", () => {
    const autoFile = file("dist/bundle.js", { triage: "auto" });
    expect(fileElementFor(autoFile, ungrouped("tree"))).toEqual({
      kind: "file",
      file: autoFile,
      alwaysFlat: true,
    });
  });

  it("leaves ungrouped non-auto files plain in both view modes", () => {
    const plain = file("src/a/b.ts");
    expect(fileElementFor(plain, ungrouped("tree"))).toEqual({
      kind: "file",
      file: plain,
    });
    expect(fileElementFor(plain, ungrouped("list"))).toEqual({
      kind: "file",
      file: plain,
    });
  });

  it("marks grouped Unclustered and Auto members alwaysFlat, cluster members plain", () => {
    const inCluster = file("src/a/b.ts");
    const scattered = file("tools/x.ts");
    const autoFile = file("dist/bundle.js", { triage: "auto" });
    const reviewedFile = reviewed("src/a/c.ts");
    const ctx = grouped(
      clusterModel([[inCluster, reviewedFile]], [scattered], [autoFile]),
      "tree",
    );
    expect(fileElementFor(scattered, ctx).alwaysFlat).toBe(true);
    expect(fileElementFor(autoFile, ctx).alwaysFlat).toBe(true);
    expect(fileElementFor(inCluster, ctx).alwaysFlat).toBeUndefined();
    expect(fileElementFor(reviewedFile, ctx).alwaysFlat).toBeUndefined();
  });
});

describe("parent chains terminate", () => {
  const isRoot = (element: ReviewTreeElement): boolean =>
    element.kind === "group" ||
    element.kind === "cluster" ||
    element.kind === "reviewedBucket";

  const files = [
    file("README.md"),
    file("src/a/b.ts"),
    file("src/a/deep/nested/c.ts"),
    file("tools/x.ts"),
    file("dist/bundle.js", { triage: "auto" }),
    reviewed("src/a/c.ts"),
    reviewed("docs/readme.md"),
  ];
  const model = clusterModel(
    [
      [files[1], files[5]],
      [files[2], files[6]],
    ],
    [files[0], files[3]],
    [files[4]],
  );
  const contexts: TreeContext[] = [
    ungrouped("list"),
    ungrouped("tree"),
    grouped(model, "list"),
    grouped(model, "tree"),
  ];

  it("reaches a root element in at most 5 steps from every file", () => {
    for (const ctx of contexts) {
      for (const reviewFile of files) {
        let element: ReviewTreeElement | undefined = fileElementFor(
          reviewFile,
          ctx,
        );
        let steps = 0;
        while (element !== undefined && !isRoot(element)) {
          element = parentOf(element, ctx);
          steps++;
          expect(steps).toBeLessThanOrEqual(5);
        }
        expect(element).toBeDefined();
        expect(isRoot(element as ReviewTreeElement)).toBe(true);
      }
    }
  });
});
