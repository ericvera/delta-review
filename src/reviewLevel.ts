import { ReviewLevel } from "./clusters";

export const SKIM_TOOLTIP =
  "Skim — a glance is enough; the agent does not expect a line-by-line read.";

export const withLevelTag = (
  level: ReviewLevel,
  description: string | undefined,
): string | undefined => {
  if (level !== "skim") {
    return description;
  }
  return description === undefined || description === ""
    ? "skim"
    : `skim · ${description}`;
};
