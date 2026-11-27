import { FileReviewStatus, ReviewFile } from "./model";

export interface ReviewCounts {
  reviewed: number;
  total: number;
  needsReview: number;
}

export const reviewCounts = (files: readonly ReviewFile[]): ReviewCounts => {
  const counted = files.filter((file) => file.triage !== "auto");
  const reviewed = counted.filter(
    (file) => file.status === FileReviewStatus.Reviewed,
  ).length;
  return {
    reviewed,
    total: counted.length,
    needsReview: counted.length - reviewed,
  };
};

export const badgeFor = ({
  needsReview,
}: ReviewCounts): { value: number; tooltip: string } | undefined =>
  needsReview > 0
    ? {
        value: needsReview,
        tooltip: `${needsReview} file${needsReview === 1 ? "" : "s"} to review`,
      }
    : undefined;

export const statusBarText = ({ reviewed, total }: ReviewCounts): string =>
  `$(checklist) Review ${reviewed}/${total}`;
