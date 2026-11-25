import { clusterSlug } from "./documents";
import { isGeneralNote, isLineNote, type NoteDocument } from "./notes";
import { type AnyNoteThread, isFileThread } from "./noteThreads";

export type NoteGroup =
  | { kind: "general"; threads: AnyNoteThread[] }
  | {
      kind: "file";
      document?: NoteDocument;
      // Repo-relative path for a code group; file name inside the cluster
      // notes dir for a document group
      file: string;
      threads: AnyNoteThread[];
    };

type FileNoteGroup = Extract<NoteGroup, { kind: "file" }>;

const groupRank = (group: FileNoteGroup): number =>
  group.document === "branch" ? 0 : group.document === "clusterNotes" ? 1 : 2;

const byCreatedAt = (a: AnyNoteThread, b: AnyNoteThread): number =>
  a.note.createdAt < b.note.createdAt
    ? -1
    : a.note.createdAt > b.note.createdAt
      ? 1
      : 0;

// File notes sit at the top of their file's diff, so they lead the group
const compareInFileGroup = (a: AnyNoteThread, b: AnyNoteThread): number => {
  const aIsFile = isFileThread(a);
  const bIsFile = isFileThread(b);
  if (aIsFile && bIsFile) {
    return byCreatedAt(a, b);
  }
  if (aIsFile || bIsFile) {
    return aIsFile ? -1 : 1;
  }
  const aLine = isLineNote(a.note) ? a.note.currentStartLine : 0;
  const bLine = isLineNote(b.note) ? b.note.currentStartLine : 0;
  return aLine - bLine;
};

// Keyed by (document, file) so a repo file sharing a document's name never
// merges with it; the general group leads when non-empty, then Branch
// overview groups, then cluster notes groups, then code groups, each by file.
export const groupNoteThreads = (threads: AnyNoteThread[]): NoteGroup[] => {
  const general: AnyNoteThread[] = [];
  const groups = new Map<string, FileNoteGroup>();
  for (const thread of threads) {
    const { note } = thread;
    if (isGeneralNote(note)) {
      general.push(thread);
      continue;
    }
    const { file } = note;
    const document = isLineNote(note) ? note.document : undefined;
    const key = `${document ?? ""}\0${file}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        kind: "file",
        ...(document === undefined ? {} : { document }),
        file,
        threads: [thread],
      });
    } else {
      group.threads.push(thread);
    }
  }
  const fileGroups = [...groups.values()]
    .sort((a, b) => {
      const rankDifference = groupRank(a) - groupRank(b);
      if (rankDifference !== 0) {
        return rankDifference;
      }
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
    })
    .map((group) => ({
      ...group,
      threads: [...group.threads].sort(compareInFileGroup),
    }));
  return general.length === 0
    ? fileGroups
    : [
        { kind: "general", threads: [...general].sort(byCreatedAt) },
        ...fileGroups,
      ];
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
// can never collide with its status/cluster/folder keys, and the general key
// sits outside it so no file path can produce it.
export const notesGroupCollapseKey = (
  group:
    | { kind: "general" }
    | { kind: "file"; document?: NoteDocument; file: string },
): string =>
  group.kind === "general"
    ? "notesGeneral"
    : group.document === undefined
      ? `notes:${group.file}`
      : `notes:${group.document}:${group.file}`;
