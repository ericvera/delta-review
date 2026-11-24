import { ReviewLevel } from "./clusters";

export const SKIM_TOOLTIP =
  "Skim — a glance is enough; the agent does not expect a line-by-line read.";

export const withLevelLabel = (level: ReviewLevel, name: string): string =>
  level === "skim" ? `${name} · skim` : name;
