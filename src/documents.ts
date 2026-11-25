import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { sanitizeBranchForFilename } from "./clusters";
import { Git } from "./git";
import type { NoteDocument } from "./notes";

export interface ClusterNotesDocument {
  path: string;
  fileName: string;
}

export interface ReviewDocuments {
  deltaReviewDir: string;
  clusterNotesDir: string;
  branchDocumentFileName: string;
  branchDocument?: string;
  clusterNotes: Map<number, ClusterNotesDocument>;
}

export const CLUSTER_NOTES_FILE_PATTERN = /^[a-z0-9-]+\.md$/;

export const BRANCH_DOCUMENT_FILE_PATTERN = /^branch-[A-Za-z0-9._-]+\.md$/;

export const isDocumentNoteFileName = (
  document: NoteDocument,
  file: string,
): boolean =>
  document === "clusterNotes"
    ? CLUSTER_NOTES_FILE_PATTERN.test(file)
    : BRANCH_DOCUMENT_FILE_PATTERN.test(file);

export type DocumentNoteLocations = Pick<
  ReviewDocuments,
  "deltaReviewDir" | "clusterNotesDir" | "branchDocumentFileName"
>;

export const documentNotePath = (
  locations: DocumentNoteLocations,
  document: NoteDocument,
  file: string,
): string =>
  document === "clusterNotes"
    ? join(locations.clusterNotesDir, file)
    : join(locations.deltaReviewDir, file);

// Resolves symlinks so two spellings of one directory compare equal.
export const canonicalDir = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

// normalizeDir is injected so the caller can add vscode's drive-letter
// normalization on top of canonicalDir while this module stays vscode-free.
export const documentNoteRefFor = (
  fsPath: string,
  locations: DocumentNoteLocations,
  normalizeDir: (path: string) => string,
): { document: NoteDocument; file: string } | undefined => {
  const name = basename(fsPath);
  const leaf = basename(dirname(fsPath));
  const clusterCandidate =
    CLUSTER_NOTES_FILE_PATTERN.test(name) &&
    leaf === basename(locations.clusterNotesDir);
  const branchCandidate =
    name === locations.branchDocumentFileName &&
    leaf === basename(locations.deltaReviewDir);
  // The caller's normalizer makes sync realpath calls and runs for every open
  // file, and the name pattern alone admits any lowercase .md (readme.md), so
  // cheap leaf-name checks gate it.
  if (!clusterCandidate && !branchCandidate) {
    return undefined;
  }
  const dir = normalizeDir(dirname(fsPath));
  if (clusterCandidate && dir === normalizeDir(locations.clusterNotesDir)) {
    return { document: "clusterNotes", file: name };
  }
  if (branchCandidate && dir === normalizeDir(locations.deltaReviewDir)) {
    return { document: "branch", file: name };
  }
  return undefined;
};

export const clusterSlug = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export const branchDocumentFileName = (branch: string): string =>
  `branch-${sanitizeBranchForFilename(branch)}.md`;

export const clusterNotesDirName = (branch: string): string =>
  `cluster-notes-${sanitizeBranchForFilename(branch)}`;

// `--git-common-dir` is relative (".git") from the main worktree.
export const deltaReviewDirFor = async (git: Git): Promise<string> => {
  const commonDirOutput = (
    await git.run(["rev-parse", "--git-common-dir"])
  ).trim();
  const commonDir = isAbsolute(commonDirOutput)
    ? commonDirOutput
    : join(git.repoRoot, commonDirOutput);
  return join(commonDir, "delta-review");
};

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
};

export const loadReviewDocuments = async (
  dir: string,
  branch: string,
  labels: readonly string[],
): Promise<ReviewDocuments> => {
  const clusterNotesDir = join(dir, clusterNotesDirName(branch));
  const branchFileName = branchDocumentFileName(branch);
  const branchPath = join(dir, branchFileName);
  const branchDocument =
    (await readText(branchPath)) === undefined ? undefined : branchPath;
  const clusterNotes = new Map<number, ClusterNotesDocument>();
  await Promise.all(
    labels.map(async (label, index) => {
      const slug = clusterSlug(label);
      if (slug === "") {
        return;
      }
      const fileName = `${slug}.md`;
      const path = join(clusterNotesDir, fileName);
      if ((await readText(path)) !== undefined) {
        clusterNotes.set(index, { path, fileName });
      }
    }),
  );
  return {
    deltaReviewDir: dir,
    clusterNotesDir,
    branchDocumentFileName: branchFileName,
    branchDocument,
    clusterNotes,
  };
};
