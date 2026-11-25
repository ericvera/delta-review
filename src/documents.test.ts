import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_DOCUMENT_FILE_PATTERN,
  branchDocumentFileName,
  canonicalDir,
  CLUSTER_NOTES_FILE_PATTERN,
  clusterNotesDirName,
  clusterSlug,
  deltaReviewDirFor,
  DocumentNoteLocations,
  documentNotePath,
  documentNoteRefFor,
  isDocumentNoteFileName,
  loadReviewDocuments,
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

describe("BRANCH_DOCUMENT_FILE_PATTERN", () => {
  it.each(["branch-feat-x.md", "branch-Release_1.2.md"])(
    "accepts %j",
    (name) => {
      expect(BRANCH_DOCUMENT_FILE_PATTERN.test(name)).toBe(true);
    },
  );

  it.each(["branch-.md", "branch-a/b.md", "branch-x.txt"])(
    "rejects %j",
    (name) => {
      expect(BRANCH_DOCUMENT_FILE_PATTERN.test(name)).toBe(false);
    },
  );
});

describe("isDocumentNoteFileName", () => {
  it("uses the cluster notes pattern for clusterNotes", () => {
    expect(isDocumentNoteFileName("clusterNotes", "auth-flow.md")).toBe(true);
    expect(isDocumentNoteFileName("clusterNotes", "Branch-X.md")).toBe(false);
  });

  it("uses the branch document pattern for branch", () => {
    expect(isDocumentNoteFileName("branch", "branch-Feat_X.md")).toBe(true);
    expect(isDocumentNoteFileName("branch", "auth-flow.md")).toBe(false);
  });
});

const LOCATIONS: DocumentNoteLocations = {
  deltaReviewDir: "/c/delta-review",
  clusterNotesDir: "/c/delta-review/cluster-notes-feat-x",
  branchDocumentFileName: "branch-feat-x.md",
};

const identity = (path: string): string => path;

describe("documentNotePath", () => {
  it("joins a cluster notes file onto the cluster notes dir", () => {
    expect(documentNotePath(LOCATIONS, "clusterNotes", "api.md")).toBe(
      join("/c/delta-review/cluster-notes-feat-x", "api.md"),
    );
  });

  it("joins a branch document onto the delta-review dir", () => {
    expect(documentNotePath(LOCATIONS, "branch", "branch-feat-x.md")).toBe(
      join("/c/delta-review", "branch-feat-x.md"),
    );
  });
});

describe("documentNoteRefFor", () => {
  it("returns the cluster notes ref", () => {
    expect(
      documentNoteRefFor(
        "/c/delta-review/cluster-notes-feat-x/api.md",
        LOCATIONS,
        identity,
      ),
    ).toEqual({ document: "clusterNotes", file: "api.md" });
  });

  it("returns the branch ref", () => {
    expect(
      documentNoteRefFor(
        "/c/delta-review/branch-feat-x.md",
        LOCATIONS,
        identity,
      ),
    ).toEqual({ document: "branch", file: "branch-feat-x.md" });
  });

  it("ignores another branch's document", () => {
    expect(
      documentNoteRefFor("/c/delta-review/branch-main.md", LOCATIONS, identity),
    ).toBeUndefined();
  });

  it("ignores a cluster-pattern file directly in the delta-review dir", () => {
    expect(
      documentNoteRefFor("/c/delta-review/api.md", LOCATIONS, identity),
    ).toBeUndefined();
  });

  it.each(["/repo/docs/readme.md", "/repo/docs/changelog.md"])(
    "ignores %j without normalizing",
    (path) => {
      const normalize = vi.fn(identity);
      expect(documentNoteRefFor(path, LOCATIONS, normalize)).toBeUndefined();
      expect(normalize).not.toHaveBeenCalled();
    },
  );

  it("ignores a cluster-pattern file under another leaf without normalizing", () => {
    const normalize = vi.fn(identity);
    expect(
      documentNoteRefFor(
        "/c/delta-review/cluster-notes-main/api.md",
        LOCATIONS,
        normalize,
      ),
    ).toBeUndefined();
    expect(normalize).not.toHaveBeenCalled();
  });

  it("compares directories through normalizeDir", () => {
    const lower = (path: string): string => path.toLowerCase();
    expect(
      documentNoteRefFor(
        "/C/delta-review/cluster-notes-feat-x/api.md",
        LOCATIONS,
        lower,
      ),
    ).toEqual({ document: "clusterNotes", file: "api.md" });
    expect(
      documentNoteRefFor("/C/delta-review/branch-feat-x.md", LOCATIONS, lower),
    ).toEqual({ document: "branch", file: "branch-feat-x.md" });
    expect(
      documentNoteRefFor(
        "/C/delta-review/cluster-notes-feat-x/api.md",
        LOCATIONS,
        identity,
      ),
    ).toBeUndefined();
  });
});

describe("canonicalDir and symlinked spellings", () => {
  let root: string;
  let realDir: string;
  let aliasDir: string;

  const locationsUnder = (base: string): DocumentNoteLocations => ({
    deltaReviewDir: join(base, "delta-review"),
    clusterNotesDir: join(base, "delta-review", "cluster-notes-feat-x"),
    branchDocumentFileName: "branch-feat-x.md",
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "canonical-"));
    realDir = join(root, "real");
    mkdirSync(join(realDir, "delta-review", "cluster-notes-feat-x"), {
      recursive: true,
    });
    aliasDir = join(root, "alias");
    symlinkSync(realDir, aliasDir, "dir");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a symlinked dir to its real path", () => {
    expect(canonicalDir(aliasDir)).toBe(realpathSync.native(realDir));
  });

  it("returns a missing path unchanged", () => {
    const missing = join(root, "missing", "deeper");
    expect(canonicalDir(missing)).toBe(missing);
  });

  it("matches documents opened through an alias of a parent dir", () => {
    const locations = locationsUnder(realDir);
    expect(
      documentNoteRefFor(
        join(aliasDir, "delta-review", "cluster-notes-feat-x", "api.md"),
        locations,
        canonicalDir,
      ),
    ).toEqual({ document: "clusterNotes", file: "api.md" });
    expect(
      documentNoteRefFor(
        join(aliasDir, "delta-review", "branch-feat-x.md"),
        locations,
        canonicalDir,
      ),
    ).toEqual({ document: "branch", file: "branch-feat-x.md" });
  });

  it("matches when the locations use the alias and the path the real dir", () => {
    const locations = locationsUnder(aliasDir);
    expect(
      documentNoteRefFor(
        join(realDir, "delta-review", "cluster-notes-feat-x", "api.md"),
        locations,
        canonicalDir,
      ),
    ).toEqual({ document: "clusterNotes", file: "api.md" });
    expect(
      documentNoteRefFor(
        join(realDir, "delta-review", "branch-feat-x.md"),
        locations,
        canonicalDir,
      ),
    ).toEqual({ document: "branch", file: "branch-feat-x.md" });
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
    expect(documents.deltaReviewDir).toBe(dir);
    expect(documents.branchDocumentFileName).toBe("branch-feat-x.md");
    expect(documents.branchDocument).toBe(join(dir, "branch-feat-x.md"));
    expect([...documents.clusterNotes.keys()]).toEqual([1]);
    expect(documents.clusterNotes.get(1)).toEqual({
      path: join(notesDir, "present-one.md"),
      fileName: "present-one.md",
    });
  });

  it("reports nothing when the directory is missing", async () => {
    const missing = join(dir, "missing");
    const documents = await loadReviewDocuments(missing, "main", ["A"]);
    expect(documents.clusterNotesDir).toBe(join(missing, "cluster-notes-main"));
    expect(documents.branchDocument).toBeUndefined();
    expect(documents.deltaReviewDir).toBe(missing);
    expect(documents.branchDocumentFileName).toBe("branch-main.md");
    expect(documents.clusterNotes.size).toBe(0);
  });
});
