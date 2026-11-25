import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatCreated,
  formatRelative,
  generalNoteTitle,
  plainTextHtml,
  renderGeneralNoteHtml,
  sameNotesKey,
} from "./generalNoteHtml";
import type { GeneralNoteHtmlInput } from "./generalNoteHtml";
import type { GeneralNote } from "./notes";
import type { NoteThread, ThreadStatus } from "./noteThreads";
import { readMarkBranch } from "./pendingRead";

const now = new Date("2026-11-25T12:00:00.000Z");

const thread = (
  status: ThreadStatus = "open",
  text = "Should the base picker move?\nMore detail.",
): NoteThread<GeneralNote> => ({
  note: {
    scope: "general",
    id: "n1",
    turns: [{ text, at: "2026-11-25T11:20:00.000Z" }],
    status: status === "pending" ? "addressed" : status,
    outdated: false,
    createdAt: "2026-11-25T11:20:00.000Z",
  },
  turns: [
    { author: "reviewer", text, at: "2026-11-25T11:20:00.000Z" },
    { author: "agent", text: "Done.", at: "2026-11-25T11:57:00.000Z" },
  ],
  status,
});

const input = (
  overrides: Partial<GeneralNoteHtmlInput> = {},
): GeneralNoteHtmlInput => ({
  mode: "note",
  thread: thread(),
  unread: false,
  branch: "feat/x",
  bodiesHtml: ["<p>first</p>", "<p>second</p>"],
  nonce: "abc123",
  cspSource: "https://cdn.example",
  now,
  ...overrides,
});

const actions = (html: string): string[] =>
  [...html.matchAll(/data-action="([a-zA-Z]+)"/g)].map((match) => match[1]!);

describe("sameNotesKey", () => {
  it("treats a tag-shadowed branch as its stripped name", () => {
    expect(
      sameNotesKey(
        { repo: "/r", branch: readMarkBranch("heads/x") },
        { repo: "/r", branch: "x" },
      ),
    ).toBe(true);
  });

  it("rejects a different repo or branch", () => {
    expect(
      sameNotesKey({ repo: "/r", branch: "x" }, { repo: "/s", branch: "x" }),
    ).toBe(false);
    expect(
      sameNotesKey({ repo: "/r", branch: "x" }, { repo: "/r", branch: "y" }),
    ).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("plainTextHtml escapes and keeps line breaks", () => {
    expect(plainTextHtml("a<b\nc")).toBe("<p>a&lt;b<br>c</p>");
  });
});

describe("renderGeneralNoteHtml", () => {
  it("keeps a script in the note text inert", () => {
    const html = renderGeneralNoteHtml(
      input({ thread: thread("open", "<script>alert(1)</script>") }),
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("escapes the branch", () => {
    const html = renderGeneralNoteHtml(input({ branch: "<b>" }));
    expect(html).toContain("branch &lt;b&gt;");
  });

  it("puts the nonce in the CSP and allows no inline scripts", () => {
    const html = renderGeneralNoteHtml(input());
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
    expect(csp).toBeDefined();
    const scriptSrc = csp!
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("script-src"));
    expect(scriptSrc).toBe("script-src 'nonce-abc123'");
    expect(csp).toContain("default-src 'none'");
    expect(html).toContain('<script nonce="abc123">');
  });

  it("renders the draft with Cancel and Add Note only", () => {
    const html = renderGeneralNoteHtml(
      input({ mode: "draft", thread: undefined, bodiesHtml: [] }),
    );
    expect(actions(html)).toEqual(["cancel", "add"]);
    expect(html).toContain("New General note");
    expect(html).toContain("Not tied to a file · branch feat/x");
  });

  it("renders a note with Resolve, Delete and Reply, and its turns", () => {
    const html = renderGeneralNoteHtml(input());
    expect(actions(html)).toEqual(["resolve", "delete", "reply"]);
    expect(html).toContain("<p>first</p>");
    expect(html).toContain("<p>second</p>");
    expect(html).toContain("You");
    expect(html).toContain("Agent");
    expect(html).toContain("40 min ago");
    expect(html).toContain("3 min ago");
    expect(html).toContain("General note · branch feat/x · created ");
    expect(html).toContain("Should the base picker move?<");
    expect(html).not.toContain("More detail.");
  });

  it("offers Mark Read only when unread", () => {
    const read = renderGeneralNoteHtml(input({ thread: thread("pending") }));
    expect(actions(read)).not.toContain("markRead");
    const unread = renderGeneralNoteHtml(
      input({ thread: thread("pending"), unread: true }),
    );
    expect(actions(unread)).toContain("markRead");
    expect(unread).toContain("Pending • Unread");
    expect(unread).toContain("var(--vscode-charts-purple)");
  });

  it("offers Unresolve for a resolved thread", () => {
    const html = renderGeneralNoteHtml(input({ thread: thread("resolved") }));
    expect(actions(html)).toContain("unresolve");
    expect(actions(html)).not.toContain("resolve");
    expect(html).toContain("Resolved");
  });
});

describe("generalNoteTitle", () => {
  it("uses the first line", () => {
    expect(generalNoteTitle("Short title\nbody")).toBe("Short title");
  });

  it("truncates at 40 characters with an ellipsis", () => {
    const title = generalNoteTitle("a".repeat(60));
    expect(title).toBe(`${"a".repeat(39)}…`);
    expect(title).toHaveLength(40);
    expect(generalNoteTitle("b".repeat(40))).toBe("b".repeat(40));
  });
});

describe("formatCreated", () => {
  it("formats local time as d MMM HH:mm", () => {
    expect(formatCreated(new Date(2026, 10, 5, 9, 2).toISOString())).toBe(
      "5 Nov 09:02",
    );
  });

  it("returns an unparsable timestamp unchanged", () => {
    expect(formatCreated("nope")).toBe("nope");
  });
});

describe("formatRelative", () => {
  it("scales from just now to days", () => {
    expect(formatRelative("2026-11-25T11:59:40.000Z", now)).toBe("just now");
    expect(formatRelative("2026-11-25T09:00:00.000Z", now)).toBe("3 h ago");
    expect(formatRelative("2026-11-23T12:00:00.000Z", now)).toBe("2 d ago");
  });
});
