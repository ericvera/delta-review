import { basename } from "node:path";
import * as vscode from "vscode";
import { renderFullNote } from "./noteBody";
import { NoteThread } from "./noteThreads";

export const NOTE_DOCUMENT_SCHEME = "delta-review-note";

// The whole thread as a read-only virtual document: it scrolls natively, so
// it is where the diff widget's clipped body sends the reviewer. Wiring only —
// the text comes from src/noteBody.ts.

// The note id travels in the query so each note is a distinct document; the
// path carries a readable `.md` name so the tab is meaningful and the editor
// picks markdown.
export const createNoteDocumentUri = (
  noteId: string,
  file: string,
): vscode.Uri =>
  vscode.Uri.from({
    scheme: NOTE_DOCUMENT_SCHEME,
    path: `/${basename(file)}.md`,
    query: noteId,
  });

export const createNoteContentProvider = (
  getThreads: () => NoteThread[],
): {
  provider: vscode.TextDocumentContentProvider;
  // Fired by the extension when the thread set changes, so an open note tab
  // picks up a new agent reply
  onDidChangeEmitter: vscode.EventEmitter<vscode.Uri>;
} => {
  const onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  return {
    onDidChangeEmitter,
    provider: {
      onDidChange: onDidChangeEmitter.event,
      provideTextDocumentContent: (uri) => {
        const thread = getThreads().find(
          (candidate) => candidate.note.id === uri.query,
        );
        return thread === undefined
          ? "This note no longer exists.\n"
          : renderFullNote(thread);
      },
    },
  };
};
