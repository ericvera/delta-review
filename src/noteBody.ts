import type { NoteThread } from "./noteThreads";

// Rendering budgets for review-note comment bodies, and the full-thread
// markdown document the escape hatches open. Pure module — no vscode — so the
// budgets and the document text are unit-testable.
//
// Why a budget at all: a comment thread is a ZoneWidget whose height VS Code
// clamps to `max(12, editorHeight / lineHeight * 0.8)` lines, with the body
// `overflow: hidden` — content past the clamp is clipped with no scrollbar at
// any level, and no extension API reaches either the clamp or the CSS. The
// clamp governs the whole widget (header, every turn's author row and
// timestamp, action bars, reply box), so the per-turn budget is derived from
// the turn count rather than being flat. It bounds the common cases, not an
// arbitrarily long thread — that residual is what the unconditional
// title-bar button covers.

// Total rendered lines a thread aims to stay within
export const THREAD_LINE_BUDGET = 24;
// Upper bound for a single turn, however few turns the thread has
export const TURN_LINE_CAP = 10;
// Lower bound for a single turn, however many turns the thread has
export const TURN_LINE_FLOOR = 4;
// Second budget: long unwrapped lines cost widget height too
export const TURN_CHAR_BUDGET = 600;

// The per-turn line budget for a thread of the given size, always within
// [TURN_LINE_FLOOR, TURN_LINE_CAP]
export const turnLineBudget = (turnCount: number): number => {
  const derived =
    turnCount <= 0 ? TURN_LINE_CAP : Math.floor(THREAD_LINE_BUDGET / turnCount);
  return Math.min(TURN_LINE_CAP, Math.max(TURN_LINE_FLOOR, derived));
};

export interface TruncatedTurn {
  text: string;
  truncated: boolean;
}

// The cut offset at or just below `limit` that does not split a surrogate
// pair: slicing between the two halves of an astral character (an emoji, say)
// would leave a lone surrogate rendering as a replacement glyph.
const charCutOffset = (text: string, limit: number): number => {
  const lead = text.charCodeAt(limit - 1);
  return lead >= 0xd800 && lead <= 0xdbff ? limit - 1 : limit;
};

// Cuts raw turn text to the budgets — line boundary first, then characters.
// Text within budget comes back byte-identical with `truncated: false`; so does
// text whose only over-budget content is whitespace (a trailing newline, blank
// lines), since nothing the author wrote is then lost. A cut result has its
// trailing whitespace trimmed so an appended link never sits after a blank run.
export const truncateTurnText = (
  text: string,
  lineBudget: number,
): TruncatedTurn => {
  const lines = text.split("\n");
  let cut = text;
  let truncated = false;
  if (
    lines.length > lineBudget &&
    lines.slice(lineBudget).join("\n").trim() !== ""
  ) {
    cut = lines.slice(0, lineBudget).join("\n");
    truncated = true;
  }
  if (cut.length > TURN_CHAR_BUDGET) {
    const offset = charCutOffset(cut, TURN_CHAR_BUDGET);
    if (cut.slice(offset).trim() !== "") {
      cut = cut.slice(0, offset);
      truncated = true;
    }
  }
  return truncated
    ? { text: cut.replace(/\s+$/, ""), truncated: true }
    : { text, truncated: false };
};

const authorLabels: Record<"reviewer" | "agent", string> = {
  reviewer: "You",
  agent: "Claude",
};

// The full thread as markdown source for the virtual note document. Turn text
// is verbatim — this is a markdown *source* file opened in a text editor, so
// escaping it would show the escapes.
export const renderFullNote = (thread: NoteThread): string => {
  const sections = [
    `# ${thread.note.file}:${thread.note.currentStartLine}`,
    `Status: ${thread.status}`,
  ];
  if (thread.note.outdated) {
    sections.push(
      "⚠ Outdated — the noted lines changed since the note was written",
    );
  }
  for (const turn of thread.turns) {
    sections.push(`## ${authorLabels[turn.author]} — ${turn.at}`, turn.text);
  }
  return `${sections.join("\n\n")}\n`;
};
