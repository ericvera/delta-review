import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  branchDocumentFileName,
  CLUSTER_NOTES_FILE_PATTERN,
  clusterNotesDirName,
  clusterSlug,
  deltaReviewDirFor,
  loadReviewDocuments,
  notesDocumentSummary,
} from "./documents";
import { Git } from "./git";

describe("clusterSlug", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(clusterSlug("Clusters contract v4")).toBe("clusters-contract-v4");
  });

  it("collapses a punctuation run into one hyphen", () => {
    expect(clusterSlug("Rename fetchUser → getUser")).toBe(
      "rename-fetchuser-getuser",
    );
    expect(clusterSlug("a, b & c")).toBe("a-b-c");
  });

  it("keeps leading and trailing symbols as hyphens", () => {
    expect(clusterSlug("(Fix) bug!")).toBe("-fix-bug-");
  });

  it("maps an all-symbol label to a single hyphen", () => {
    expect(clusterSlug("!!! ???")).toBe("-");
  });

  it("returns empty for an empty label", () => {
    expect(clusterSlug("")).toBe("");
  });
});

describe("document names", () => {
  it("sanitizes a slash in the branch", () => {
    expect(branchDocumentFileName("feat/x")).toBe("branch-feat-x.md");
    expect(clusterNotesDirName("feat/x")).toBe("cluster-notes-feat-x");
  });
});

describe("CLUSTER_NOTES_FILE_PATTERN", () => {
  it("accepts slug file names", () => {
    expect(CLUSTER_NOTES_FILE_PATTERN.test("clusters-contract-v4.md")).toBe(
      true,
    );
    expect(CLUSTER_NOTES_FILE_PATTERN.test("-fix-bug-.md")).toBe(true);
  });

  it("rejects traversal, nested and uppercase names", () => {
    expect(CLUSTER_NOTES_FILE_PATTERN.test("../x.md")).toBe(false);
    expect(CLUSTER_NOTES_FILE_PATTERN.test("a/b.md")).toBe(false);
    expect(CLUSTER_NOTES_FILE_PATTERN.test("A.md")).toBe(false);
  });
});

const MOCK_DOCUMENT = `# Clusters contract v4

Bumps the contract and adds review levels.

## Reading order

1. src/clusters.ts
2. src/clusters.test.ts

## Check

- Does version 3 still parse?
* Are levels ungated?
  3. Is the skill doc in sync?
`;

describe("notesDocumentSummary", () => {
  it("summarizes intro, sections and questions", () => {
    expect(notesDocumentSummary(MOCK_DOCUMENT)).toBe(
      "intro · reading order · 3 questions",
    );
  });

  it("omits intro when only a title precedes the first section", () => {
    expect(notesDocumentSummary("# Title\n\n## Reading order\n1. a\n")).toBe(
      "reading order",
    );
  });

  it("uses the singular for one question", () => {
    expect(notesDocumentSummary("## Check\n- Why?\n")).toBe("1 question");
  });

  it("falls back to the heading when Check has no items", () => {
    expect(notesDocumentSummary("## Check\nNothing to ask.\n")).toBe("check");
  });

  it("returns empty for empty text", () => {
    expect(notesDocumentSummary("")).toBe("");
  });
});

describe("deltaReviewDirFor", () => {
  it("resolves a relative common dir against the repo root", async () => {
    const git: Git = { repoRoot: "/repo", run: async () => ".git\n" };
    expect(await deltaReviewDirFor(git)).toBe(
      join("/repo", ".git", "delta-review"),
    );
  });

  it("keeps an absolute common dir", async () => {
    const git: Git = { repoRoot: "/wt", run: async () => "/main/.git\n" };
    expect(await deltaReviewDirFor(git)).toBe(
      join("/main/.git", "delta-review"),
    );
  });
});

describe("loadReviewDocuments", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "documents-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the branch document and present notes files only", async () => {
    await writeFile(join(dir, "branch-feat-x.md"), "# Overview\n");
    const notesDir = join(dir, "cluster-notes-feat-x");
    await mkdir(notesDir);
    await writeFile(join(notesDir, "present-one.md"), MOCK_DOCUMENT);

    const documents = await loadReviewDocuments(dir, "feat/x", [
      "Absent one",
      "Present one",
      "???",
      "",
    ]);

    expect(documents.clusterNotesDir).toBe(notesDir);
    expect(documents.branchDocument).toBe(join(dir, "branch-feat-x.md"));
    expect([...documents.clusterNotes.keys()]).toEqual([1]);
    expect(documents.clusterNotes.get(1)).toEqual({
      path: join(notesDir, "present-one.md"),
      fileName: "present-one.md",
      summary: "intro · reading order · 3 questions",
    });
  });

  it("reports nothing when the directory is missing", async () => {
    const missing = join(dir, "missing");
    const documents = await loadReviewDocuments(missing, "main", ["A"]);
    expect(documents.clusterNotesDir).toBe(join(missing, "cluster-notes-main"));
    expect(documents.branchDocument).toBeUndefined();
    expect(documents.clusterNotes.size).toBe(0);
  });
});
