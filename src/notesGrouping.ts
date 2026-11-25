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

const groupRank = (group: NoteGroup): number =>
  group.document === "branch" ? 0 : group.document === "clusterNotes" ? 1 : 2;

// Keyed by (document, file) so a repo file sharing a document's name never
// merges with it; Branch overview groups first, then cluster notes groups,
// then code groups, each by file.
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
      const rankDifference = groupRank(a) - groupRank(b);
      if (rankDifference !== 0) {
        return rankDifference;
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

export const documentNoteGroupLabel = (
  document: NoteDocument,
  file: string,
  clusterLabels: readonly string[],
): string => {
  if (document === "branch") {
    return "Branch overview";
  }
  const label = clusterLabels.find((candidate) => {
    const slug = clusterSlug(candidate);
    return slug !== "" && `${slug}.md` === file;
  });
  return label === undefined ? file : `${label} — notes`;
};

export const documentNoteGroupDescription = (
  document: NoteDocument,
  count: number,
): string =>
  document === "branch"
    ? `branch overview · ${count}`
    : `cluster notes · ${count}`;

// Collapse keys share the main view's persisted set; the `notes:` namespace
// can never collide with its status/cluster/folder keys.
export const notesGroupCollapseKey = (group: {
  document?: NoteDocument;
  file: string;
}): string =>
  group.document === undefined
    ? `notes:${group.file}`
    : `notes:${group.document}:${group.file}`;
