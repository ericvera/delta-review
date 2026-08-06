import { describe, expect, it } from "vitest";
import { escapeMarkdownText } from "./markdown";

describe("escapeMarkdownText", () => {
  it("keeps single spaces between words so the note can wrap", () => {
    const result = escapeMarkdownText("a long review note sentence");
    expect(result).not.toContain("&nbsp;");
    expect(result).toBe("a long review note sentence");
  });

  it("keeps a single interior space as a plain space", () => {
    expect(escapeMarkdownText("a b")).toBe("a b");
  });

  it("escapes markdown syntax tokens", () => {
    expect(escapeMarkdownText("`x`")).toBe("\\`x\\`");
    expect(escapeMarkdownText("a*b_c")).toBe("a\\*b\\_c");
    expect(escapeMarkdownText("[link](url)")).toBe("\\[link\\]\\(url\\)");
    expect(escapeMarkdownText("#+!~{}\\")).toBe("\\#\\+\\!\\~\\{\\}\\\\");
  });

  it("escapes a line-leading dash", () => {
    expect(escapeMarkdownText("-item")).toBe("\\-item");
    expect(escapeMarkdownText("a-b")).toBe("a-b");
  });

  it("escapes blockquote markers", () => {
    expect(escapeMarkdownText(">quoted")).toBe("\\>quoted");
  });

  it("turns newlines into markdown hard line breaks", () => {
    expect(escapeMarkdownText("line1\nline2")).toBe("line1  \nline2");
  });

  it("keeps a blank line separating paragraphs", () => {
    expect(escapeMarkdownText("para1\n\npara2")).toBe("para1  \n  \npara2");
  });

  it("escapes a line-leading equals so it cannot become a setext heading", () => {
    expect(escapeMarkdownText("Title\n=====")).toBe("Title  \n\\=====");
    expect(escapeMarkdownText("a=b")).toBe("a=b");
  });

  it("escapes pipes so note lines cannot form a table", () => {
    expect(escapeMarkdownText("| a | b |\n|---|---|")).toBe(
      "\\| a \\| b \\|  \n\\|---\\|---\\|",
    );
    expect(escapeMarkdownText("a | b")).toBe("a \\| b");
  });

  it("escapes angle brackets so note lines cannot start an HTML block", () => {
    expect(escapeMarkdownText("<div>\nstill visible")).toBe(
      "\\<div\\>  \nstill visible",
    );
    expect(escapeMarkdownText("a < b")).toBe("a \\< b");
  });

  it("preserves leading indentation as &nbsp; without making a code block", () => {
    expect(escapeMarkdownText("    x")).toBe("&nbsp;&nbsp;&nbsp;&nbsp;x");
  });

  it("preserves interior alignment runs of 2+ spaces as &nbsp;", () => {
    expect(escapeMarkdownText("a  b")).toBe("a&nbsp;&nbsp;b");
  });

  it("preserves runs containing tabs as &nbsp; per character", () => {
    expect(escapeMarkdownText("a\tb")).toBe("a&nbsp;b");
    expect(escapeMarkdownText("a \tb")).toBe("a&nbsp;&nbsp;b");
  });
});
