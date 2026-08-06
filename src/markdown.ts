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
// Newlines become markdown hard line breaks (two trailing spaces), not
// paragraph breaks: one <p> per note instead of one per line keeps the
// rendered height close to the text's, which matters because VS Code clips a
// comment thread's zone widget with no scrollbar. A source blank line becomes
// a spaces-only line, still blank in CommonMark, so real paragraph breaks
// survive. Joining lines into one paragraph is also what puts multi-line block
// constructs within reach of note text — a setext heading (`=` under a line), a
// GFM table (a `|` row under a `|` row, whose delimiter row is consumed and
// disappears) and an HTML block (a `<` tag swallowing every line up to a blank
// one, then dropped whole because comment bodies are rendered without HTML
// support) — hence the `=`, `|` and `<` escapes.
// The newline rule must stay last, or the two spaces it inserts would be
// rewritten as &nbsp; by the interior-run rule.
export const escapeMarkdownText = (text: string): string =>
  text
    .replace(/[\\`*_{}[\]()#+!~<|]/g, "\\$&")
    .replace(/^([ \t]*)-/gm, "$1\\-")
    .replace(/^([ \t]*)=/gm, "$1\\=")
    .replace(/^[ \t]+/gm, (run) => "&nbsp;".repeat(run.length))
    .replace(/[ \t]+/g, (run) =>
      run === " " ? run : "&nbsp;".repeat(run.length),
    )
    .replace(/>/gm, "\\>")
    .replace(/\n/g, "  \n");
