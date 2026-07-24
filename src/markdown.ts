// Escapes plain text for rendering as markdown in review note bodies.
// Based on VS Code's MarkdownString.appendText pipeline, but with its
// blanket space -> &nbsp; substitution narrowed so ordinary interior
// single spaces stay plain and the rendered text can wrap:
// - a line-leading whitespace run becomes &nbsp; per character (keeps
//   indentation without triggering markdown's 4-space code block)
// - an interior/trailing run of 2+ characters, or any run containing a
//   tab, becomes &nbsp; per character (keeps deliberate alignment; a
//   trailing 2+ run also avoids an accidental markdown hard line break)
// - an interior single space stays a plain space — the wrap point
export const escapeMarkdownText = (text: string): string =>
  text
    .replace(/[\\`*_{}[\]()#+!~]/g, "\\$&")
    .replace(/^([ \t]*)-/gm, "$1\\-")
    .replace(/^[ \t]+/gm, (run) => "&nbsp;".repeat(run.length))
    .replace(/[ \t]+/g, (run) =>
      run === " " ? run : "&nbsp;".repeat(run.length),
    )
    .replace(/>/gm, "\\>")
    .replace(/\n/g, "\n\n");
