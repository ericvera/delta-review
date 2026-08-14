import { dirname } from "node:path";
import { ClusterModel, clusterFilesForKey } from "./clusters";
import { FileReviewStatus, ReviewFile } from "./model";
import type {
  FileElement,
  FolderElement,
  ReviewTreeElement,
  ViewMode,
} from "./treeProvider";

// Inverse of ReviewTreeProvider.getChildren: given the state the provider
// renders from, what element contains a given element. Type-only imports from
// ./treeProvider keep this module free of `vscode` at runtime.

export interface TreeContext {
  clusterModel: ClusterModel | undefined;
  viewMode: ViewMode;
  // Effective grouping (preference && a cluster model exists)
  grouped: boolean;
}

// The scope stamped onto folder elements — exactly one field set, matching
// treeChildren's stamping so the folder's collapse key (and therefore its
// rendered row id) is identical
interface FolderScope {
  status?: FileReviewStatus;
  clusterKey?: string;
  inReviewedBucket?: true;
}

// Where a file renders: the container element holding it, whether that
// container's body is a flat list in both view modes (the Auto subgroup, the
// grouped Auto and Unclustered buckets), and the scope of its folder tree
interface Placement {
  container: ReviewTreeElement;
  alwaysFlat: boolean;
  scope: FolderScope;
}

const folderElement = (path: string, scope: FolderScope): FolderElement => ({
  kind: "folder",
  status: scope.status,
  clusterKey: scope.clusterKey,
  inReviewedBucket: scope.inReviewedBucket,
  path,
});

const containerForScope = (
  scope: FolderScope,
): ReviewTreeElement | undefined => {
  if (scope.clusterKey !== undefined) {
    return { kind: "cluster", clusterKey: scope.clusterKey };
  }
  if (scope.inReviewedBucket === true) {
    return { kind: "reviewedBucket" };
  }
  return scope.status === undefined
    ? undefined
    : { kind: "group", status: scope.status };
};

// The bucket holding this path, in root order. Membership uses the cluster
// model's own ReviewFile objects, so match by path — callers re-find the file
// in the current model and path equality is the stable key.
const clusterKeyForPath = (
  model: ClusterModel,
  path: string,
): string | undefined =>
  [
    ...model.clusters.map((_, index) => `c${index}`),
    "unclustered",
    "auto",
  ].find((clusterKey) =>
    clusterFilesForKey(model, clusterKey).some((file) => file.path === path),
  );

const placementFor = (
  file: ReviewFile,
  ctx: TreeContext,
): Placement | undefined => {
  if (ctx.grouped && ctx.clusterModel !== undefined) {
    // Cluster bodies render needs-review rows only, so a reviewed file is in
    // the Reviewed bucket whatever cluster claims it
    if (file.status === FileReviewStatus.Reviewed) {
      return {
        container: { kind: "reviewedBucket" },
        alwaysFlat: false,
        scope: { inReviewedBucket: true },
      };
    }
    const clusterKey = clusterKeyForPath(ctx.clusterModel, file.path);
    if (clusterKey === undefined) {
      return undefined;
    }
    if (clusterKey === "unclustered" || clusterKey === "auto") {
      return {
        container: { kind: "cluster", clusterKey },
        alwaysFlat: true,
        scope: {},
      };
    }
    return {
      container: { kind: "cluster", clusterKey },
      alwaysFlat: false,
      scope: { clusterKey },
    };
  }
  if (file.triage === "auto") {
    return {
      container: { kind: "autoGroup", status: file.status },
      alwaysFlat: true,
      scope: {},
    };
  }
  return {
    container: { kind: "group", status: file.status },
    alwaysFlat: false,
    scope: { status: file.status },
  };
};

// The file element getChildren would produce for this file, including the
// alwaysFlat flag its container stamps.
export const fileElementFor = (
  file: ReviewFile,
  ctx: TreeContext,
): FileElement =>
  placementFor(file, ctx)?.alwaysFlat === true
    ? { kind: "file", file, alwaysFlat: true }
    : { kind: "file", file };

// The element containing `element`, or undefined for root-level elements and
// for a file the current model no longer places anywhere.
export const parentOf = (
  element: ReviewTreeElement,
  ctx: TreeContext,
): ReviewTreeElement | undefined => {
  switch (element.kind) {
    case "file": {
      const placement = placementFor(element.file, ctx);
      if (placement === undefined) {
        return undefined;
      }
      if (placement.alwaysFlat || ctx.viewMode === "list") {
        return placement.container;
      }
      const directory = dirname(element.file.path);
      return directory === "."
        ? placement.container
        : folderElement(directory, placement.scope);
    }
    case "folder": {
      const scope: FolderScope = {
        status: element.status,
        clusterKey: element.clusterKey,
        inReviewedBucket: element.inReviewedBucket,
      };
      const parent = dirname(element.path);
      return parent === "."
        ? containerForScope(scope)
        : folderElement(parent, scope);
    }
    // Reveal never targets the Auto subgroup, but VS Code may call getParent
    // on any element it has rendered
    case "autoGroup":
      return { kind: "group", status: element.status };
    case "group":
    case "cluster":
    case "reviewedBucket":
    case "message":
      return undefined;
  }
};
