import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { sanitizeBranchForFilename } from "./clusters";
import { Git } from "./git";

export interface ClusterNotesDocument {
  path: string;
  fileName: string;
  summary: string;
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

const LIST_ITEM = /^\s*(?:[-*] |\d+\. )/;
const HEADING = /^#{1,6}(?:\s|$)/;

export const notesDocumentSummary = (text: string): string => {
  const parts: string[] = [];
  let hasIntro = false;
  let inSections = false;
  let heading = "";
  let listItems = 0;
  const closeSection = (): void => {
    if (!inSections) {
      return;
    }
    if (heading.trim().toLowerCase() === "check" && listItems > 0) {
      parts.push(`${listItems} ${listItems === 1 ? "question" : "questions"}`);
    } else {
      parts.push(heading.trim().toLowerCase());
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      closeSection();
      inSections = true;
      heading = line.slice(3);
      listItems = 0;
    } else if (inSections) {
      if (LIST_ITEM.test(line)) {
        listItems += 1;
      }
    } else if (line.trim() !== "" && !HEADING.test(line)) {
      hasIntro = true;
    }
  }
  closeSection();
  return [...(hasIntro ? ["intro"] : []), ...parts]
    .filter((part) => part !== "")
    .join(" · ");
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
      const text = await readText(path);
      if (text !== undefined) {
        clusterNotes.set(index, {
          path,
          fileName,
          summary: notesDocumentSummary(text),
        });
      }
    }),
  );
  return { clusterNotesDir, branchDocument, clusterNotes };
};
