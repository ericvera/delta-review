import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { sanitizeBranchForFilename } from "./clusters";
import { Git } from "./git";

export interface ClusterNotesDocument {
  path: string;
  fileName: string;
}

export interface ReviewDocuments {
  clusterNotesDir: string;
  branchDocument?: string;
  clusterNotes: Map<number, ClusterNotesDocument>;
}

export const CLUSTER_NOTES_FILE_PATTERN = /^[a-z0-9-]+\.md$/;

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
  const branchPath = join(dir, branchDocumentFileName(branch));
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
  return { clusterNotesDir, branchDocument, clusterNotes };
};
