import { describe, expect, it } from "vitest";
import {
  renderFullNote,
  truncateTurnText,
  turnLineBudget,
  THREAD_LINE_BUDGET,
  TURN_CHAR_BUDGET,
  TURN_LINE_CAP,
  TURN_LINE_FLOOR,
} from "./noteBody";
import type { ThreadTurn, NoteThread } from "./noteThreads";

const threadWith = (
  turns: ThreadTurn[],
  overrides: Partial<NoteThread["note"]> = {},
): NoteThread => ({
  note: {
    id: "n1",
    file: "src/api.ts",
    side: "working",
    startLine: 12,
    endLine: 12,
    snapshot: ["const x = 1;"],
    contentBlob: "abc123",
    turns: turns
      .filter((turn) => turn.author === "reviewer")
      .map((turn) => ({ text: turn.text, at: turn.at })),
    status: "open",
    outdated: false,
    currentStartLine: 12,
    currentEndLine: 12,
    createdAt: "2026-07-18T20:00:00Z",
    ...overrides,
  },
  turns,
  status: "open",
});

describe("turnLineBudget", () => {
  it("gives a single-turn thread the per-turn cap", () => {
    expect(turnLineBudget(1)).toBe(TURN_LINE_CAP);
  });

  it("shrinks the budget as the turn count grows", () => {
    expect(turnLineBudget(3)).toBe(Math.floor(THREAD_LINE_BUDGET / 3));
    expect(turnLineBudget(4)).toBeLessThan(turnLineBudget(3));
  });

  it("never goes below the floor however many turns", () => {
    expect(turnLineBudget(20)).toBe(TURN_LINE_FLOOR);
  });

  it("stays within [floor, cap] for any turn count", () => {
    for (let count = 0; count <= 50; count++) {
      const budget = turnLineBudget(count);
      expect(budget).toBeGreaterThanOrEqual(TURN_LINE_FLOOR);
      expect(budget).toBeLessThanOrEqual(TURN_LINE_CAP);
    }
  });
});

describe("truncateTurnText", () => {
  it("returns text within budget unchanged", () => {
    const text = "line1\nline2\n  line3  ";
    expect(truncateTurnText(text, 5)).toEqual({ text, truncated: false });
  });

  it("returns text at the exact line budget unchanged", () => {
    const text = "a\nb\nc";
    expect(truncateTurnText(text, 3)).toEqual({ text, truncated: false });
  });

  it("keeps text whose only over-budget line is a trailing newline", () => {
    const text = "a\nb\nc\n";
    expect(truncateTurnText(text, 3)).toEqual({ text, truncated: false });
  });

  it("keeps text whose over-budget lines are all blank", () => {
    const text = "a\nb\n\n   \n\n";
    expect(truncateTurnText(text, 2)).toEqual({ text, truncated: false });
  });

  it("cuts on a line boundary past the line budget", () => {
    const text = "a\nb\nc\nd";
    expect(truncateTurnText(text, 2)).toEqual({
      text: "a\nb",
      truncated: true,
    });
  });

  it("cuts on the character budget", () => {
    const text = "x".repeat(TURN_CHAR_BUDGET + 50);
    const result = truncateTurnText(text, 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("x".repeat(TURN_CHAR_BUDGET));
  });

  it("keeps text whose only over-budget characters are whitespace", () => {
    const text = `${"x".repeat(TURN_CHAR_BUDGET)}   `;
    expect(truncateTurnText(text, 10)).toEqual({ text, truncated: false });
  });

  it("does not split a surrogate pair straddling the character budget", () => {
    const text = `${"x".repeat(TURN_CHAR_BUDGET - 1)}😀${"y".repeat(10)}`;
    const result = truncateTurnText(text, 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("x".repeat(TURN_CHAR_BUDGET - 1));
    expect([...result.text].every((char) => char.charCodeAt(0) < 0xd800)).toBe(
      true,
    );
  });

  it("trims trailing whitespace from a cut result", () => {
    const text = "a\n\n  \nkept\nd";
    expect(truncateTurnText(text, 3)).toEqual({ text: "a", truncated: true });
  });
});

describe("renderFullNote", () => {
  it("renders the heading, status and every turn in order", () => {
    const document = renderFullNote(
      threadWith([
        { author: "reviewer", text: "First ask", at: "2026-07-18T20:00:00Z" },
        { author: "agent", text: "Done", at: "2026-07-18T20:05:00Z" },
        { author: "reviewer", text: "Thanks", at: "2026-07-18T20:06:00Z" },
      ]),
    );
    expect(document).toContain("# src/api.ts:12");
    expect(document).toContain("Status: open");
    expect(document).toContain("## You — 2026-07-18T20:00:00Z");
    expect(document).toContain("## Claude — 2026-07-18T20:05:00Z");
    expect(document.indexOf("First ask")).toBeLessThan(
      document.indexOf("Done"),
    );
    expect(document.indexOf("Done")).toBeLessThan(document.indexOf("Thanks"));
  });

  it("renders an outdated marker only when the note is outdated", () => {
    const turns: ThreadTurn[] = [
      { author: "reviewer", text: "note", at: "2026-07-18T20:00:00Z" },
    ];
    expect(renderFullNote(threadWith(turns))).not.toContain("Outdated");
    expect(renderFullNote(threadWith(turns, { outdated: true }))).toContain(
      "⚠ Outdated",
    );
  });

  it("keeps turn text verbatim", () => {
    const text = "check `x[0]` and *this*\n\n  indented  line";
    const document = renderFullNote(
      threadWith([{ author: "reviewer", text, at: "2026-07-18T20:00:00Z" }]),
    );
    expect(document).toContain(text);
    expect(document).not.toContain("&nbsp;");
    expect(document).not.toContain("\\[");
  });
});
