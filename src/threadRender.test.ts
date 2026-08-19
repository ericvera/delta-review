import { describe, expect, it } from "vitest";
import type { NoteStatus } from "./notes";
import {
  canReplyFor,
  sameCommentDisplays,
  shouldRecreateThread,
} from "./threadRender";
import type { CommentDisplay } from "./threadRender";

const statuses: NoteStatus[] = ["open", "addressed", "resolved"];

// Preview mode; the numeric values mirror vscode.CommentMode
const PREVIEW = 1;
const EDITING = 0;

const display = (overrides: Partial<CommentDisplay> = {}): CommentDisplay => ({
  authorName: "You",
  bodyText: "please rename this",
  bodyIsMarkdown: true,
  mode: PREVIEW,
  timestampMs: Date.parse("2026-07-01T10:00:00Z"),
  contextValue: "reviewerTurn",
  noteId: "n1",
  turnAt: "2026-07-01T10:00:00Z",
  turnText: "please rename this",
  reviewerTurnIndex: 0,
  ...overrides,
});

describe("canReplyFor", () => {
  it("is true only for addressed", () => {
    expect(canReplyFor("open")).toBe(false);
    expect(canReplyFor("addressed")).toBe(true);
    expect(canReplyFor("resolved")).toBe(false);
  });
});

describe("shouldRecreateThread", () => {
  const cases: [NoteStatus, NoteStatus, boolean][] = [
    ["open", "addressed", true],
    ["resolved", "addressed", true],
    ["addressed", "addressed", false],
    ["addressed", "open", false],
    ["addressed", "resolved", false],
    ["open", "resolved", false],
    ["open", "open", false],
    ["resolved", "open", false],
    ["resolved", "resolved", false],
  ];

  for (const [current, next, expected] of cases) {
    it(`${current} → ${next} ${expected ? "recreates" : "restyles in place"}`, () => {
      expect(shouldRecreateThread(canReplyFor(current), next)).toBe(expected);
    });
  }

  it("never recreates a thread that is already replyable", () => {
    for (const next of statuses) {
      expect(shouldRecreateThread(true, next)).toBe(false);
    }
  });
});

describe("sameCommentDisplays", () => {
  it("treats identical lists as equal", () => {
    expect(
      sameCommentDisplays(
        [display(), display({ authorName: "Claude" })],
        [display(), display({ authorName: "Claude" })],
      ),
    ).toBe(true);
  });

  it("treats two empty lists as equal", () => {
    expect(sameCommentDisplays([], [])).toBe(true);
  });

  it("detects a changed body", () => {
    expect(
      sameCommentDisplays([display()], [display({ bodyText: "renamed it" })]),
    ).toBe(false);
  });

  it("detects the same text sent as a raw string rather than markdown", () => {
    expect(
      sameCommentDisplays(
        [display({ bodyIsMarkdown: false })],
        [display({ bodyIsMarkdown: true })],
      ),
    ).toBe(false);
  });

  it("detects a changed mode", () => {
    expect(sameCommentDisplays([display()], [display({ mode: EDITING })])).toBe(
      false,
    );
  });

  it("detects a changed reviewerTurnIndex", () => {
    expect(
      sameCommentDisplays([display()], [display({ reviewerTurnIndex: 1 })]),
    ).toBe(false);
  });

  it("detects a changed length", () => {
    expect(sameCommentDisplays([display()], [display(), display()])).toBe(
      false,
    );
    expect(sameCommentDisplays([display(), display()], [display()])).toBe(
      false,
    );
  });

  it("detects reordering", () => {
    const first = display({ turnAt: "2026-07-01T10:00:00Z" });
    const second = display({ turnAt: "2026-07-01T11:00:00Z" });
    expect(sameCommentDisplays([first, second], [second, first])).toBe(false);
  });

  it("compares undefined timestamps", () => {
    expect(
      sameCommentDisplays(
        [display({ timestampMs: undefined })],
        [display({ timestampMs: undefined })],
      ),
    ).toBe(true);
    expect(
      sameCommentDisplays([display({ timestampMs: undefined })], [display()]),
    ).toBe(false);
  });

  it("detects a changed contextValue, author, noteId, turnAt or turnText", () => {
    expect(
      sameCommentDisplays([display()], [display({ contextValue: undefined })]),
    ).toBe(false);
    expect(
      sameCommentDisplays([display()], [display({ authorName: "Claude" })]),
    ).toBe(false);
    expect(sameCommentDisplays([display()], [display({ noteId: "n2" })])).toBe(
      false,
    );
    expect(
      sameCommentDisplays(
        [display()],
        [display({ turnAt: "2026-07-01T12:00:00Z" })],
      ),
    ).toBe(false);
    expect(
      sameCommentDisplays([display()], [display({ turnText: "other" })]),
    ).toBe(false);
  });
});
