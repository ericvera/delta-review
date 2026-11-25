import type { BaseResolution } from "./diffBase";

export interface BaseStatusPresentation {
  text: string;
  tooltip: string;
  tint: "none" | "warning" | "error";
}

const sourceLines = (
  resolution: BaseResolution,
): { heading: string; origin: string; action: string } => {
  const { base, branch } = resolution;
  if (resolution.source === "explicit") {
    return {
      heading: `Delta Review base: ${base}`,
      origin: `Set for branch ${branch} (all worktrees on this branch).`,
      action: "Click to change the base.",
    };
  }
  if (resolution.source === "detected") {
    return {
      heading: `Delta Review base: ${base} (auto-detected)`,
      origin:
        resolution.detectedVia === "upstream"
          ? `Upstream of this branch (${base}).`
          : "Closest local branch this branch forked from.",
      action: "Click to pin a base for this branch.",
    };
  }
  return {
    heading: `Delta Review base: ${base} (default)`,
    origin: "From setting deltaReview.baseBranch.",
    action: "Click to pin a base for this branch.",
  };
};

export const baseStatusPresentation = (
  resolution: BaseResolution,
  mergeBase: string | undefined,
  options?: { mergeBaseFailed?: boolean },
): BaseStatusPresentation => {
  const { base } = resolution;
  const fileErrorLine =
    resolution.fileError === undefined
      ? []
      : [`Base file ignored: ${resolution.fileError}`];
  if (resolution.missing || options?.mergeBaseFailed === true) {
    const problem = resolution.missing
      ? `Base ${base} not found. Click to choose a base.`
      : `No merge-base between ${base} and HEAD. Click to choose a base.`;
    return {
      text: `$(warning) ← ${base}`,
      tooltip: [problem, ...fileErrorLine].join("\n"),
      tint: "error",
    };
  }
  const { heading, origin, action } = sourceLines(resolution);
  const mergeBaseLine =
    mergeBase === undefined ? [] : [`Merge-base ${mergeBase.slice(0, 7)}`];
  return {
    text: `$(git-compare) ← ${base}`,
    tooltip: [heading, origin, ...mergeBaseLine, action, ...fileErrorLine].join(
      "\n",
    ),
    tint: "none",
  };
};

export const mergeBaseErrorMessage = (resolution: BaseResolution): string => {
  const hint =
    resolution.source === "fallback"
      ? " Check the deltaReview.baseBranch setting or click the base in the status bar to choose one."
      : " Click the base in the status bar to choose another.";
  return `⚠ Cannot compute merge-base with "${resolution.base}".${hint}`;
};
