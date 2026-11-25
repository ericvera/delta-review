import { FileReviewStatus, ReviewFile, ReviewModel } from "./model";

export type ReviewStatusFields = Pick<
  ReviewFile,
  "status" | "hasReviewSnapshot"
>;

export interface PendingMark {
  readonly paths: readonly string[];
  readonly reviewed: boolean;
}

export type ReviewUnavailable =
  | { kind: "baseMissing"; base: string; branch: string }
  | { kind: "mergeBaseFailed"; base: string }
  | undefined;

export interface ReviewChange {
  reviewed: boolean;
  scope: "file" | "folder" | "cluster" | "auto" | "all";
  subject: string;
}

const withFields = (
  model: ReviewModel,
  fieldsFor: (path: string) => ReviewStatusFields | undefined,
): ReviewModel => ({
  ...model,
  files: model.files.map((file) => {
    const fields = fieldsFor(file.path);
    return fields === undefined ? file : { ...file, ...fields };
  }),
});

export const withReviewStatus = (
  model: ReviewModel,
  paths: readonly string[],
  reviewed: boolean,
): { model: ReviewModel; prior: Map<string, ReviewStatusFields> } => {
  const wanted = new Set(paths);
  const prior = new Map<string, ReviewStatusFields>();
  for (const file of model.files) {
    if (wanted.has(file.path)) {
      prior.set(file.path, {
        status: file.status,
        hasReviewSnapshot: file.hasReviewSnapshot,
      });
    }
  }
  const fields: ReviewStatusFields = reviewed
    ? { status: FileReviewStatus.Reviewed, hasReviewSnapshot: true }
    : { status: FileReviewStatus.NeedsReview, hasReviewSnapshot: false };
  return {
    model: withFields(model, (path) => (wanted.has(path) ? fields : undefined)),
    prior,
  };
};

export const revertReviewStatus = (
  model: ReviewModel,
  prior: ReadonlyMap<string, ReviewStatusFields>,
): ReviewModel => withFields(model, (path) => prior.get(path));

export const applyPendingMarks = (
  model: ReviewModel,
  pending: readonly PendingMark[],
): ReviewModel =>
  pending.reduce(
    (current, entry) =>
      withReviewStatus(current, entry.paths, entry.reviewed).model,
    model,
  );

const stderrOf = (error: Error): string | undefined => {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString("utf8");
  }
  return typeof stderr === "string" ? stderr : undefined;
};

export const gitErrorReason = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const lines = error.message.split("\n");
  const firstLine = lines[0] ?? "";
  const output =
    stderrOf(error) ??
    (firstLine.startsWith("Command failed:")
      ? lines.slice(1).join("\n")
      : error.message);
  const outputLines = output.split("\n").map((line) => line.trim());
  const prefixed = outputLines.find(
    (line) => line.startsWith("fatal:") || line.startsWith("error:"),
  );
  const reason =
    prefixed?.replace(/^(fatal|error):/, "").trim() ??
    outputLines.find((line) => line !== "") ??
    firstLine;
  return reason.replace(/\.$/, "");
};

export const noModelMessage = (unavailable: ReviewUnavailable): string => {
  if (unavailable === undefined) {
    return "Delta Review: the review is still loading — try again in a moment.";
  }
  if (unavailable.kind === "baseMissing") {
    return `Delta Review: nothing to mark — base ${unavailable.base} for branch ${unavailable.branch} does not resolve. Click the base in the status bar to choose one.`;
  }
  return `Delta Review: nothing to mark — no merge-base with "${unavailable.base}". Click the base in the status bar to choose another.`;
};

export const describeReviewChange = ({
  reviewed,
  scope,
  subject,
}: ReviewChange): string => {
  switch (scope) {
    case "file":
      return `${reviewed ? "mark" : "unmark"} ${subject} reviewed`;
    case "folder":
      return reviewed
        ? `mark folder ${subject} reviewed`
        : `unmark folder ${subject}`;
    case "cluster":
      return reviewed
        ? `mark cluster ${subject} reviewed`
        : `unmark cluster ${subject}`;
    case "auto":
      return reviewed
        ? `mark ${subject} auto files reviewed`
        : `unmark ${subject} auto files`;
    case "all":
      return reviewed
        ? `mark all ${subject} files reviewed`
        : `unmark all ${subject} files`;
  }
};

export const reviewChangeFailedMessage = (
  description: string,
  reason: string,
): string => `Could not ${description}: ${reason}. Your mark was undone.`;
