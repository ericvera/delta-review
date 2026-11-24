import type { LineNote } from "./clusters";
import { escapeMarkdownText } from "./markdown";
import type { ReviewModel } from "./model";
import { buildTooltipOriginLine } from "./moveDisplay";

// The file-level provenance thread's content, decided without any VS Code
// API so the composition is unit-testable. What the reviewer is told about a
// file before they read its diff: where the code came from, what the author
// said about the move, what the contract says about this file, and how the
// base actually resolved. The thread it feeds is read-only and is never a
// review note — `src/commentController.ts` owns that distinction.

// Mirrors the tooltip's out-of-range wording (`buildTooltipStatusLine` in
// `src/moveDisplay.ts`); the tooltip cannot be reused here because it leads
// with the verbatim/adapted line, which the row already carries.
const OUT_OF_RANGE_WARNING =
  "Declared lines are outside the origin. Showing the whole file.";

export interface ProvenanceEntry {
  path: string;
  // Mirrors ReviewFile.deleted: it decides which document the thread lives
  // on, since a deleted file has no working file to attach to
  deleted: boolean;
  body: string;
}

export interface ProvenanceBodyInput {
  // Already markdown-escaped by buildTooltipOriginLine
  originLine: string | undefined;
  moveNote: string | undefined;
  fileNote: string | undefined;
  warning: string | undefined;
}

// The origin line is a sentence fragment everywhere else it appears (a row, a
// tooltip line, a tab title); here it opens a paragraph the notes continue,
// so it needs the terminator those surfaces leave off.
const asSentence = (line: string): string =>
  line.endsWith(".") ? line : `${line}.`;

// Contract text is the author's prose: passed through verbatim except for
// markdown escaping, so it can neither restyle the body nor link out of it
const noteText = (note: string | undefined): string | undefined =>
  note === undefined || note === "" ? undefined : escapeMarkdownText(note);

// Assembles the thread's single comment body. Returns undefined when there is
// nothing to say, which is the caller's signal to render no thread at all.
export const buildProvenanceBody = ({
  originLine,
  moveNote,
  fileNote,
  warning,
}: ProvenanceBodyInput): string | undefined => {
  const parts = [
    originLine === undefined || originLine === ""
      ? undefined
      : asSentence(originLine),
    noteText(moveNote),
    noteText(fileNote),
    warning === undefined || warning === "" ? undefined : warning,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" ");
};

// The files that earn a provenance thread: a move the author declared, or a
// file the contract remarks on. A rename git detected on its own is deduced
// from the diff and says nothing the row does not, so it stays silent unless
// a note gives it something to carry.
export const provenanceEntriesFor = (model: ReviewModel): ProvenanceEntry[] => {
  const entries: ProvenanceEntry[] = [];
  for (const file of model.files) {
    if (
      !file.moveDeclared &&
      (file.fileNote === undefined || file.fileNote === "")
    ) {
      continue;
    }
    const body = buildProvenanceBody({
      originLine: buildTooltipOriginLine({
        movedFrom: file.movedFrom,
        donor: file.donor,
        originLines: file.originLines,
      }),
      moveNote: file.moveNote,
      fileNote: file.fileNote,
      warning: file.originLinesOutOfRange ? OUT_OF_RANGE_WARNING : undefined,
    });
    if (body !== undefined) {
      entries.push({ path: file.path, deleted: file.deleted, body });
    }
  }
  return entries;
};

// One read-only thread per ranged agent note. Lines stay 1-based inclusive,
// as the contract states them; the controller converts and clamps.
export interface AgentLineNoteEntry {
  path: string;
  deleted: boolean;
  startLine: number;
  endLine: number;
  body: string;
}

export const agentLineNoteEntriesFor = (
  model: ReviewModel,
): AgentLineNoteEntry[] =>
  model.files.flatMap((file) =>
    (file.lineNotes ?? []).map(({ lines: [startLine, endLine], text }) => ({
      path: file.path,
      deleted: file.deleted,
      startLine,
      endLine,
      body: escapeMarkdownText(text),
    })),
  );

const lineSpan = (startLine: number, endLine: number): string =>
  startLine === endLine ? `${startLine}` : `${startLine}–${endLine}`;

export const agentLineNoteLabel = (
  startLine: number,
  endLine: number,
): string =>
  startLine === endLine
    ? `Agent note · line ${startLine}`
    : `Agent note · lines ${lineSpan(startLine, endLine)}`;

export const agentLineNotesTooltipLine = (
  lineNotes: readonly LineNote[] | undefined,
): string | undefined => {
  if (lineNotes === undefined || lineNotes.length === 0) {
    return undefined;
  }
  const noun = lineNotes.length === 1 ? "note" : "notes";
  const ranges = lineNotes
    .map(({ lines: [start, end] }) => lineSpan(start, end))
    .join(", ");
  return `${lineNotes.length} agent ${noun} on lines: ${ranges}`;
};
