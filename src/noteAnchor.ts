// Maps a note's creation-time line range to its position in the current
// document by walking the hunks of a `git diff -U0 <creationBlob>
// <currentBlob>` run. Pure logic — no vscode, no git execution: the store
// layer produces the diff text and calls in here once per note, so each
// note shifts, survives, or expires independently. Identical content never
// reaches this module (the store short-circuits when the blobs match).

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type MappedRange = {
  startLine: number;
  endLine: number;
  outdated: boolean;
};

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

// Extracts every `@@ -a[,b] +c[,d] @@` hunk header from unified diff text.
// Omitted counts default to 1 per the unified diff format; every other line
// is ignored. Note the -U0 zero-count conventions: a pure insertion has
// oldLines === 0 with oldStart naming the line *before* the insertion
// point, and a pure deletion has newLines === 0 with newStart naming the
// new file's line before the removed span (0 when the file head was
// deleted).
export const parseUnifiedDiffHunks = (diffText: string): DiffHunk[] => {
  const hunks: DiffHunk[] = [];
  for (const match of diffText.matchAll(hunkHeaderPattern)) {
    hunks.push({
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
};

// A hunk sits entirely above a line when every old line it touches — for a
// pure insertion, the line it inserts after — precedes that line.
const isEntirelyAbove = (hunk: DiffHunk, line: number): boolean =>
  (hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart + hunk.oldLines - 1) <
  line;

// Net line delta of every hunk entirely above the given old-file line.
const shiftFromHunksAbove = (hunks: DiffHunk[], line: number): number => {
  let shift = 0;
  for (const hunk of hunks) {
    if (isEntirelyAbove(hunk, line)) {
      shift += hunk.newLines - hunk.oldLines;
    }
  }
  return shift;
};

// Whether the hunk touches any line of the inclusive [startLine, endLine]
// old-file range. A pure insertion (oldLines === 0) inserts between
// oldStart and oldStart + 1; it touches the range only when it lands
// strictly between the note's first and last line — an insertion at the
// range's outer boundary leaves every anchored line intact.
const touchesRange = (
  hunk: DiffHunk,
  startLine: number,
  endLine: number,
): boolean => {
  if (hunk.oldLines === 0) {
    return hunk.oldStart >= startLine && hunk.oldStart < endLine;
  }
  return (
    hunk.oldStart <= endLine && hunk.oldStart + hunk.oldLines - 1 >= startLine
  );
};

// Maps a 1-based inclusive creation-time range through -U0 hunks (disjoint
// and in ascending order, as git emits them).
//
// - No hunk touches the range: both ends shift by the net delta of the
//   hunks entirely above startLine; outdated is false.
// - Any hunk touches the range: the note is outdated, and the range
//   collapses to a single line at the nearest surviving location
//   (display-only positioning). That location is startLine mapped into the
//   new document: shifted by the hunks above it when the line itself
//   survived; kept at its offset into the replacement (capped at the
//   replacement's last line) when it was rewritten in place; or the line
//   the deletion hunk reports it followed, clamped to a minimum of 1, when
//   it was deleted outright.
export const mapRangeThroughHunks = (
  startLine: number,
  endLine: number,
  hunks: DiffHunk[],
): MappedRange => {
  const outdated = hunks.some((hunk) => touchesRange(hunk, startLine, endLine));
  if (!outdated) {
    const shift = shiftFromHunksAbove(hunks, startLine);
    return {
      startLine: startLine + shift,
      endLine: endLine + shift,
      outdated: false,
    };
  }
  const containing = hunks.find(
    (hunk) =>
      hunk.oldLines > 0 &&
      hunk.oldStart <= startLine &&
      startLine <= hunk.oldStart + hunk.oldLines - 1,
  );
  let mappedStart: number;
  if (containing === undefined) {
    // startLine itself survives; only lines further into the range changed.
    mappedStart = Math.max(
      1,
      startLine + shiftFromHunksAbove(hunks, startLine),
    );
  } else if (containing.newLines > 0) {
    mappedStart =
      containing.newStart +
      Math.min(startLine - containing.oldStart, containing.newLines - 1);
  } else {
    mappedStart = Math.max(1, containing.newStart);
  }
  return { startLine: mappedStart, endLine: mappedStart, outdated: true };
};
