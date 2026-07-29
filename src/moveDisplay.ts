import { escapeMarkdownText } from "./markdown";
import type { MoveClassification, MoveOrigin } from "./model";

// Character count above which the assembled description is shortened. A
// tuning constant matched to a ~300px sidebar, not a contract.
export const ROW_DESCRIPTION_THRESHOLD = 48;

// U+2026, one character — the length arithmetic below depends on that
const ELLIPSIS = "…";

export interface TooltipOriginInput {
  // Origin path, declared or detected; undefined when the file is not a move
  movedFrom: string | undefined;
  donor: string | undefined;
}

export interface RowDescriptionInput {
  // Current repo-relative path of the file
  path: string;
  // Directory text the tree provider already computed: shown in list mode
  // and on always-flat rows, undefined in tree mode
  directoryText: string | undefined;
  // Origin path, declared or detected; undefined when the file is not a move
  movedFrom: string | undefined;
  moveOrigin: MoveOrigin | undefined;
  donor: string | undefined;
  moveClassification: MoveClassification | undefined;
}

// Splits a path into non-empty segments, so a leading "/" or "../" never
// yields an empty segment that could match an empty donor name
const splitSegments = (path: string): string[] =>
  path.split("/").filter((segment) => segment !== "");

// Reduces an external origin to its portion within the donor project: the
// segments following the last whole segment equal to the donor name. With no
// such segment — including an absolute path — leading "." and ".." are
// dropped and the remainder used.
const donorRelativeSegments = (
  from: string,
  donor: string | undefined,
): string[] => {
  const segments = splitSegments(from);
  if (donor !== undefined && donor !== "") {
    const donorIndex = segments.lastIndexOf(donor);
    if (donorIndex !== -1) {
      return segments.slice(donorIndex + 1);
    }
  }
  let start = 0;
  while (
    start < segments.length &&
    (segments[start] === "." || segments[start] === "..")
  ) {
    start += 1;
  }
  return segments.slice(start);
};

// Drops the trailing segments the origin shares with the destination,
// comparing whole segments so "reporter.ts" and "telemetryReporter.ts" share
// nothing
const stripSharedSuffix = (
  origin: string[],
  destination: string[],
): string[] => {
  let shared = 0;
  while (
    shared < origin.length &&
    shared < destination.length &&
    origin[origin.length - 1 - shared] ===
      destination[destination.length - 1 - shared]
  ) {
    shared += 1;
  }
  return origin.slice(0, origin.length - shared);
};

const classificationText = (
  classification: MoveClassification | undefined,
): string | undefined =>
  classification === "verbatim" || classification === "adapted"
    ? `· ${classification}`
    : undefined;

const joinParts = (parts: (string | undefined)[]): string =>
  parts.filter((part) => part !== undefined && part !== "").join(" ");

// Keeps the final segment and drops the head. Returns undefined when the
// result would not actually be shorter — a single-segment path must never
// gain an ellipsis implying an elision that did not happen.
const shortenOriginPath = (originPath: string): string | undefined => {
  const segments = splitSegments(originPath);
  const last = segments[segments.length - 1];
  if (last === undefined) {
    return undefined;
  }
  const shortened = `${ELLIPSIS}/${last}`;
  return shortened.length < originPath.length ? shortened : undefined;
};

// Truncates the donor name to the length that brings the assembled
// description down to the threshold, with a floor of one character plus the
// ellipsis. Returns undefined when that would not actually be shorter.
const truncateDonor = (
  donor: string,
  assembledLength: number,
): string | undefined => {
  const overflow = assembledLength - ROW_DESCRIPTION_THRESHOLD;
  const keep = Math.max(1, donor.length - overflow - ELLIPSIS.length);
  const truncated = `${donor.slice(0, keep)}${ELLIPSIS}`;
  return truncated.length < donor.length ? truncated : undefined;
};

// Assembles the dim description shown after a file's name: the directory
// text, the origin segment, and the classification word. Returns the
// directory text unchanged when the file is not a move, and undefined when
// there is nothing to show.
export const buildRowDescription = ({
  path,
  directoryText,
  movedFrom,
  moveOrigin,
  donor,
  moveClassification,
}: RowDescriptionInput): string | undefined => {
  if (movedFrom === undefined || movedFrom === "") {
    return directoryText;
  }

  // Brackets mean "another project"; their absence means nothing in
  // particular, so an external move with no donor renders unbracketed
  const donorName =
    moveOrigin === "external" && donor !== undefined && donor !== ""
      ? donor
      : undefined;
  const reduced =
    moveOrigin === "external"
      ? donorRelativeSegments(movedFrom, donor)
      : splitSegments(movedFrom);
  const remainder = stripSharedSuffix(reduced, splitSegments(path));

  let originPath: string | undefined =
    remainder.length > 0 ? remainder.join("/") : undefined;
  // Nothing left to show: a donor carries the origin on its own, otherwise
  // fall back to the full path so the arrow is never left dangling
  if (originPath === undefined && donorName === undefined) {
    originPath = movedFrom;
  }

  const classification = classificationText(moveClassification);
  const assemble = (name: string | undefined, originText: string | undefined) =>
    joinParts([
      directoryText,
      "←",
      name === undefined ? undefined : `[${name}]`,
      originText,
      classification,
    ]);

  const assembled = assemble(donorName, originPath);
  if (assembled.length <= ROW_DESCRIPTION_THRESHOLD) {
    return assembled;
  }
  // Shortening is applied once; a still-over-threshold result is accepted
  if (originPath !== undefined) {
    const shortened = shortenOriginPath(originPath);
    return shortened === undefined ? assembled : assemble(donorName, shortened);
  }
  if (donorName !== undefined) {
    const truncated = truncateDonor(donorName, assembled.length);
    if (truncated !== undefined) {
      return assemble(truncated, undefined);
    }
  }
  return assembled;
};

// Contract-supplied text bound for a tooltip line: newlines collapse to a
// space so it cannot open a paragraph of its own and forge a following
// status line, then markdown syntax is escaped so it cannot restyle or link
const escapeOriginText = (text: string): string =>
  escapeMarkdownText(text.replace(/[ \t]*[\r\n]+[ \t]*/g, " "));

// The tooltip's move line: the complete origin, never the row's reduced or
// shortened form. A donor name that is not a whole segment of that path is
// named separately, so the bracketed name on the row connects to something.
// Returns undefined when the file is not a move, matching buildRowDescription.
export const buildTooltipOriginLine = ({
  movedFrom,
  donor,
}: TooltipOriginInput): string | undefined => {
  if (movedFrom === undefined || movedFrom === "") {
    return undefined;
  }
  const line = `Moved from ${escapeOriginText(movedFrom)}`;
  if (
    donor === undefined ||
    donor === "" ||
    splitSegments(movedFrom).includes(donor)
  ) {
    return line;
  }
  return `${line} (donor: ${escapeOriginText(donor)})`;
};
