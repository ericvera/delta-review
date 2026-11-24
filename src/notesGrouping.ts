import { clusterSlug } from "./documents";
import type { NoteDocument } from "./notes";
import type { NoteThread } from "./noteThreads";

export interface NoteGroup {
  document?: NoteDocument;
  // Repo-relative path for a code group; file name inside the cluster notes
  // dir for a document group
  file: string;
  threads: NoteThread[];
}

// Keyed by (document, file) so a repo file sharing a document's name never
// merges with it; document groups first, then code groups, each by file.
export const groupNoteThreads = (threads: NoteThread[]): NoteGroup[] => {
  const groups = new Map<string, NoteGroup>();
  for (const thread of threads) {
    const { document, file } = thread.note;
    const key = `${document ?? ""}\0${file}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        ...(document === undefined ? {} : { document }),
        file,
        threads: [thread],
      });
    } else {
      group.threads.push(thread);
    }
  }
  return [...groups.values()]
    .sort((a, b) => {
      const aDocument = a.document === undefined ? 1 : 0;
      const bDocument = b.document === undefined ? 1 : 0;
      if (aDocument !== bDocument) {
        return aDocument - bDocument;
      }
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
    })
    .map((group) => ({
      ...group,
      threads: [...group.threads].sort(
        (a, b) => a.note.currentStartLine - b.note.currentStartLine,
      ),
    }));
};

export const clusterNotesDocumentLabel = (
  file: string,
  clusterLabels: readonly string[],
): string => {
  const label = clusterLabels.find((candidate) => {
    const slug = clusterSlug(candidate);
    return slug !== "" && `${slug}.md` === file;
  });
  return label === undefined ? file : `${label} — notes`;
};

// Collapse keys share the main view's persisted set; the `notes:` namespace
// can never collide with its status/cluster/folder keys.
export const notesGroupCollapseKey = (group: {
  document?: NoteDocument;
  file: string;
}): string =>
  group.document === undefined
    ? `notes:${group.file}`
    : `notes:${group.document}:${group.file}`;
