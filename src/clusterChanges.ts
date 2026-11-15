import {
  type ClusterModel,
  clusterBucketForKey,
  filterByStatus,
} from "./clusters";
import { FileReviewStatus, type ReviewFile } from "./model";

// Pure logic behind the combined "Open Cluster Changes" multi-diff tab, kept
// free of `vscode` so it stays unit-testable under Vitest.

const SYNTHETIC_LABELS: Record<string, string> = {
  unclustered: "Unclustered",
  auto: "Auto",
};

export const clusterLabelForKey = (
  model: ClusterModel,
  clusterKey: string,
): string =>
  SYNTHETIC_LABELS[clusterKey] ??
  clusterBucketForKey(model, clusterKey)?.label ??
  "";

export const clusterChangesFiles = (
  files: readonly ReviewFile[],
): ReviewFile[] => filterByStatus(files, FileReviewStatus.NeedsReview);

const titleFor = (label: string): string => `Cluster Changes: ${label}`;

const clusterChangesTitles = (model: ClusterModel): Map<string, string> => {
  const labels = [
    ...Object.values(SYNTHETIC_LABELS),
    ...model.clusters.map((bucket) => bucket.label),
  ];
  const labelCounts = new Map<string, number>();
  for (const label of labels) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const titles = new Map<string, string>();
  const taken = new Set<string>();
  for (const [key, label] of Object.entries(SYNTHETIC_LABELS)) {
    titles.set(key, titleFor(label));
    taken.add(titleFor(label));
  }
  const colliding: number[] = [];
  model.clusters.forEach((bucket, index) => {
    if ((labelCounts.get(bucket.label) ?? 0) > 1) {
      colliding.push(index);
      return;
    }
    titles.set(`c${index}`, titleFor(bucket.label));
    taken.add(titleFor(bucket.label));
  });
  for (const index of colliding) {
    const label = model.clusters[index]?.label ?? "";
    let n = index + 1;
    while (taken.has(titleFor(`${label} (${n})`))) {
      n++;
    }
    const title = titleFor(`${label} (${n})`);
    titles.set(`c${index}`, title);
    taken.add(title);
  }
  return titles;
};

export const clusterChangesTitle = (
  model: ClusterModel,
  clusterKey: string,
): string =>
  clusterChangesTitles(model).get(clusterKey) ??
  titleFor(clusterLabelForKey(model, clusterKey));

export const changedClusterMessage = (label: string): string =>
  `Cluster '${label}' changed since this diff opened. Reopen it from the Delta Review pane.`;

export const nothingToReviewMessage = (label: string): string =>
  `No files in '${label}' need review.`;

export interface ClusterChangesSource {
  repoRoot: string;
  branch: string;
}

export const sameClusterChangesSource = (
  entry: ClusterChangesSource,
  current: ClusterChangesSource,
): boolean =>
  entry.repoRoot === current.repoRoot && entry.branch === current.branch;

export const clusterChangesMarkPaths = (
  entry: ClusterChangesSource & {
    title: string;
    label: string;
    paths: readonly string[];
  },
  current: ClusterChangesSource & { title: string; label: string },
  clusterFiles: readonly ReviewFile[],
): { paths: string[] } | { message: string } => {
  if (
    !sameClusterChangesSource(entry, current) ||
    current.label !== entry.label ||
    current.title !== entry.title
  ) {
    return { message: changedClusterMessage(entry.label) };
  }
  const shown = new Set(entry.paths);
  const paths = clusterChangesFiles(clusterFiles)
    .map((file) => file.path)
    .filter((path) => shown.has(path));
  return paths.length > 0
    ? { paths }
    : { message: nothingToReviewMessage(entry.label) };
};

export type DiffDocument =
  | { scheme: "file"; path: string }
  | { scheme: "base"; path: string; query: string };

export const fileForDiffDocument = (
  files: readonly ReviewFile[],
  doc: DiffDocument,
): ReviewFile | undefined =>
  files.find((file) =>
    doc.scheme === "file"
      ? !file.deleted && file.path === doc.path
      : (file.diffBasePath === doc.path &&
          (file.diffBaseSha ?? "empty") === doc.query) ||
        (file.deleted && file.path === doc.path && doc.query === "empty"),
  );

export const isRowAlreadySelected = (
  selectedPaths: readonly string[],
  path: string,
): boolean => selectedPaths.includes(path);
