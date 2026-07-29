import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MoveDeclaration } from "./clusters";
import type { Git } from "./git";
import {
  adjustReviewSetForMoves,
  computeReviewModel,
  FileReviewStatus,
  parseCheckAttrOutput,
  ResolvedMove,
  resolveBranch,
  resolveFileBase,
} from "./model";

// Builds `git check-attr -z` output: <path NUL attr NUL value NUL> per entry
const checkAttrOutput = (entries: [path: string, value: string][]): string =>
  entries
    .map(([path, value]) => `${path}\0linguist-generated\0${value}\0`)
    .join("");

describe("parseCheckAttrOutput", () => {
  it("collects paths whose value is set or true", () => {
    const output = checkAttrOutput([
      ["gen/a.ts", "set"],
      ["gen/b.ts", "true"],
      ["src/c.ts", "unspecified"],
      ["src/d.ts", "false"],
      ["src/e.ts", "unset"],
    ]);
    expect(parseCheckAttrOutput(output)).toEqual(
      new Set(["gen/a.ts", "gen/b.ts"]),
    );
  });

  it("keeps triplets aligned across an empty attribute value", () => {
    // `path linguist-generated=` in .gitattributes yields an empty value
    // field (`path NUL attr NUL NUL`); it must not shift later triplets
    const output = checkAttrOutput([
      ["gen/empty.ts", ""],
      ["gen/real.ts", "set"],
      ["src/other.ts", "unspecified"],
    ]);
    expect(parseCheckAttrOutput(output)).toEqual(new Set(["gen/real.ts"]));
  });

  it("returns an empty set for empty output", () => {
    expect(parseCheckAttrOutput("")).toEqual(new Set());
  });
});

const declaration = (
  path: string,
  from: string,
  origin: MoveDeclaration["origin"],
  optional: Partial<MoveDeclaration> = {},
): MoveDeclaration => ({
  path,
  from,
  origin,
  donor: undefined,
  baseBlob: undefined,
  note: undefined,
  ...optional,
});

const repoMove = (from: string): ResolvedMove => ({
  from,
  origin: "repo",
  donor: undefined,
  baseBlob: undefined,
  note: undefined,
});

const adjust = (input: {
  paths: string[];
  movedFrom?: [destination: string, source: string][];
  moves?: MoveDeclaration[];
  mergeBasePaths?: string[];
  // Paths that still exist in the working tree; everything else is deleted
  onDisk?: string[];
}) =>
  adjustReviewSetForMoves({
    paths: input.paths,
    movedFromByPath: new Map(input.movedFrom ?? []),
    moves: input.moves ?? [],
    mergeBasePaths: new Set(input.mergeBasePaths ?? []),
    isDeletedFromWorkingTree: (path) => !(input.onDisk ?? []).includes(path),
  });

describe("adjustReviewSetForMoves", () => {
  it("turns every git-detected rename into a repo-origin move", () => {
    expect(
      adjust({
        paths: ["src/new.ts"],
        movedFrom: [["src/new.ts", "src/old.ts"]],
      }),
    ).toEqual({
      paths: ["src/new.ts"],
      movesByPath: new Map([["src/new.ts", repoMove("src/old.ts")]]),
    });
  });

  it("lets a declaration override git's detected origin for the same path", () => {
    const result = adjust({
      paths: ["src/new.ts"],
      movedFrom: [["src/new.ts", "src/old.ts"]],
      moves: [
        declaration("src/new.ts", "../donor/src/new.ts", "external", {
          donor: "donor",
          baseBlob: "a".repeat(40),
          note: "renamed on the way in",
        }),
      ],
    });
    expect(result.movesByPath.get("src/new.ts")).toEqual({
      from: "../donor/src/new.ts",
      origin: "external",
      donor: "donor",
      baseBlob: "a".repeat(40),
      note: "renamed on the way in",
    });
  });

  it("produces the same result as detection alone when a declaration agrees with it", () => {
    const detected = adjust({
      paths: ["src/new.ts"],
      movedFrom: [["src/new.ts", "src/old.ts"]],
    });
    const declared = adjust({
      paths: ["src/new.ts"],
      movedFrom: [["src/new.ts", "src/old.ts"]],
      moves: [declaration("src/new.ts", "src/old.ts", "repo")],
    });
    expect(declared).toEqual(detected);
  });

  it("re-inserts a displaced rename source as a deleted file", () => {
    const result = adjust({
      paths: ["src/new.ts"],
      movedFrom: [["src/new.ts", "src/old.ts"]],
      moves: [
        declaration("src/new.ts", "../donor/src/new.ts", "external", {
          donor: "donor",
        }),
      ],
      mergeBasePaths: ["src/old.ts"],
    });
    expect(result.paths).toEqual(["src/new.ts", "src/old.ts"]);
    expect(result.movesByPath.has("src/old.ts")).toBe(false);
  });

  it("does not re-insert the rename source when the declaration names it", () => {
    const result = adjust({
      paths: ["src/new.ts"],
      movedFrom: [["src/new.ts", "src/old.ts"]],
      moves: [declaration("src/new.ts", "src/old.ts", "repo")],
      mergeBasePaths: ["src/old.ts"],
    });
    expect(result.paths).toEqual(["src/new.ts"]);
  });

  it("keeps the adjusted paths sorted after a re-insertion", () => {
    const result = adjust({
      paths: ["src/a.ts", "src/z.ts"],
      movedFrom: [["src/z.ts", "src/m.ts"]],
      moves: [declaration("src/z.ts", "../donor/z.ts", "external")],
    });
    expect(result.paths).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("removes a repo origin that is in the review set as a deleted file", () => {
    const result = adjust({
      paths: ["src/new.ts", "src/old.ts"],
      moves: [declaration("src/new.ts", "src/old.ts", "repo")],
      mergeBasePaths: ["src/old.ts"],
      onDisk: ["src/new.ts"],
    });
    expect(result.paths).toEqual(["src/new.ts"]);
    expect(result.movesByPath).toEqual(
      new Map([["src/new.ts", repoMove("src/old.ts")]]),
    );
  });

  it("keeps the repo origin's deleted row when the destination existed at the merge base", () => {
    const result = adjust({
      paths: ["src/new.ts", "src/old.ts"],
      moves: [declaration("src/new.ts", "src/old.ts", "repo")],
      mergeBasePaths: ["src/new.ts", "src/old.ts"],
      onDisk: ["src/new.ts"],
    });
    expect(result.paths).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("keeps a repo origin that still exists in the working tree", () => {
    const result = adjust({
      paths: ["src/new.ts", "src/old.ts"],
      moves: [declaration("src/new.ts", "src/old.ts", "repo")],
      mergeBasePaths: ["src/old.ts"],
      onDisk: ["src/new.ts", "src/old.ts"],
    });
    expect(result.paths).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("suppresses nothing for an external origin", () => {
    const result = adjust({
      paths: ["src/new.ts", "src/old.ts"],
      moves: [declaration("src/new.ts", "src/old.ts", "external")],
      mergeBasePaths: ["src/old.ts"],
      onDisk: ["src/new.ts"],
    });
    expect(result.paths).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("suppresses a path that both re-entered and is another declaration's origin", () => {
    const result = adjust({
      paths: ["src/a.ts", "src/b.ts"],
      movedFrom: [["src/a.ts", "src/old.ts"]],
      moves: [
        declaration("src/a.ts", "../donor/a.ts", "external"),
        declaration("src/b.ts", "src/old.ts", "repo"),
      ],
      mergeBasePaths: ["src/old.ts"],
      onDisk: ["src/a.ts", "src/b.ts"],
    });
    expect(result.paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("ignores a declaration whose path is outside the review set", () => {
    const result = adjust({
      paths: ["src/a.ts"],
      moves: [declaration("src/absent.ts", "src/a.ts", "repo")],
      mergeBasePaths: ["src/a.ts"],
    });
    expect(result).toEqual({ paths: ["src/a.ts"], movesByPath: new Map() });
  });
});

const ORIGIN_SHA = "1".repeat(40);
const PATH_SHA = "2".repeat(40);
const WORKING_SHA = "3".repeat(40);
const REVIEWED_SHA = "4".repeat(40);
const EXTERNAL_SHA = "5".repeat(40);

const resolve = (input: {
  path?: string;
  move?: ResolvedMove;
  deleted?: boolean;
  workingSha?: string;
  reviewedSha?: string;
  useSnapshotBase?: boolean;
  mergeBaseBlobs?: [path: string, sha: string][];
  externalBaseShaByPath?: [path: string, sha: string][];
}) =>
  resolveFileBase({
    path: input.path ?? "src/new.ts",
    move: input.move,
    deleted: input.deleted ?? false,
    workingSha:
      input.deleted === true ? undefined : (input.workingSha ?? WORKING_SHA),
    reviewedSha: input.reviewedSha,
    useSnapshotBase: input.useSnapshotBase ?? false,
    mergeBaseBlobs: new Map(input.mergeBaseBlobs ?? []),
    externalBaseShaByPath: new Map(input.externalBaseShaByPath ?? []),
  });

describe("resolveFileBase", () => {
  it("gives a plain modified file the merge-base blob at its own path", () => {
    expect(resolve({ mergeBaseBlobs: [["src/new.ts", PATH_SHA]] })).toEqual({
      diffBaseSha: PATH_SHA,
      diffBasePath: "src/new.ts",
      moveClassification: undefined,
      originContentUnavailable: false,
    });
  });

  it("gives an added file no diff base", () => {
    expect(resolve({})).toEqual({
      diffBaseSha: undefined,
      diffBasePath: "src/new.ts",
      moveClassification: undefined,
      originContentUnavailable: false,
    });
  });

  it("diffs a repo move against the origin's merge-base blob", () => {
    expect(
      resolve({
        move: repoMove("src/old.ts"),
        mergeBaseBlobs: [["src/old.ts", ORIGIN_SHA]],
      }),
    ).toEqual({
      diffBaseSha: ORIGIN_SHA,
      diffBasePath: "src/old.ts",
      moveClassification: "adapted",
      originContentUnavailable: false,
    });
  });

  it("classifies a repo move whose content matches its origin as verbatim", () => {
    expect(
      resolve({
        move: repoMove("src/old.ts"),
        workingSha: ORIGIN_SHA,
        mergeBaseBlobs: [["src/old.ts", ORIGIN_SHA]],
      }).moveClassification,
    ).toBe("verbatim");
  });

  it("prefers the merge-base blob at the path when a move overwrites an existing file", () => {
    expect(
      resolve({
        move: repoMove("src/old.ts"),
        mergeBaseBlobs: [
          ["src/old.ts", ORIGIN_SHA],
          ["src/new.ts", PATH_SHA],
        ],
      }),
    ).toEqual({
      diffBaseSha: PATH_SHA,
      diffBasePath: "src/new.ts",
      moveClassification: "adapted",
      originContentUnavailable: false,
    });
  });

  it("keeps the reviewed snapshot as the base ahead of every move rule", () => {
    expect(
      resolve({
        move: repoMove("src/old.ts"),
        useSnapshotBase: true,
        reviewedSha: REVIEWED_SHA,
        mergeBaseBlobs: [
          ["src/old.ts", ORIGIN_SHA],
          ["src/new.ts", PATH_SHA],
        ],
      }),
    ).toEqual({
      diffBaseSha: REVIEWED_SHA,
      diffBasePath: "src/new.ts",
      moveClassification: "adapted",
      originContentUnavailable: false,
    });
  });

  it("classifies against the origin base while the diff shows a reviewed snapshot", () => {
    expect(
      resolve({
        move: repoMove("src/old.ts"),
        workingSha: ORIGIN_SHA,
        useSnapshotBase: true,
        reviewedSha: REVIEWED_SHA,
        mergeBaseBlobs: [["src/old.ts", ORIGIN_SHA]],
      }),
    ).toEqual({
      diffBaseSha: REVIEWED_SHA,
      diffBasePath: "src/new.ts",
      moveClassification: "verbatim",
      originContentUnavailable: false,
    });
  });

  it("names the file's own path for an external origin's blob", () => {
    expect(
      resolve({
        move: {
          from: "../donor/src/thing.ts",
          origin: "external",
          donor: "donor",
          baseBlob: EXTERNAL_SHA,
          note: undefined,
        },
        externalBaseShaByPath: [["src/new.ts", EXTERNAL_SHA]],
      }),
    ).toEqual({
      diffBaseSha: EXTERNAL_SHA,
      diffBasePath: "src/new.ts",
      moveClassification: "adapted",
      originContentUnavailable: false,
    });
  });

  it("degrades an unusable external base blob to unknown with no base", () => {
    expect(
      resolve({
        move: {
          from: "../donor/src/thing.ts",
          origin: "external",
          donor: "donor",
          baseBlob: EXTERNAL_SHA,
          note: undefined,
        },
      }),
    ).toEqual({
      diffBaseSha: undefined,
      diffBasePath: "src/new.ts",
      moveClassification: "unknown",
      originContentUnavailable: true,
    });
  });

  it("degrades a repo origin missing from the merge base to unknown with no base", () => {
    expect(resolve({ move: repoMove("src/old.ts") })).toEqual({
      diffBaseSha: undefined,
      diffBasePath: "src/new.ts",
      moveClassification: "unknown",
      originContentUnavailable: true,
    });
  });

  it("classifies a deleted move as unknown even with an origin base", () => {
    expect(
      resolve({
        move: repoMove("src/old.ts"),
        deleted: true,
        mergeBaseBlobs: [["src/old.ts", ORIGIN_SHA]],
      }),
    ).toEqual({
      diffBaseSha: ORIGIN_SHA,
      diffBasePath: "src/old.ts",
      moveClassification: "unknown",
      originContentUnavailable: false,
    });
  });

  it("reports origin content available when another rule supplies a base", () => {
    const overwritten = resolve({
      move: repoMove("src/old.ts"),
      mergeBaseBlobs: [["src/new.ts", PATH_SHA]],
    });
    expect(overwritten.originContentUnavailable).toBe(false);
    expect(overwritten.moveClassification).toBe("unknown");
    const snapshotted = resolve({
      move: repoMove("src/old.ts"),
      useSnapshotBase: true,
      reviewedSha: REVIEWED_SHA,
    });
    expect(snapshotted.originContentUnavailable).toBe(false);
  });
});

// A Git stub over a temp directory: no repository is created, the working
// tree is whatever files the test writes, and every git read is canned.
interface FakeRepo {
  branch: string;
  // `git diff --name-status --find-renames -z` records
  changes: (
    [status: string, path: string] | [status: string, from: string, to: string]
  )[];
  untracked: string[];
  baseBlobs: Record<string, string>;
  reviewState: Record<string, string>;
  // Working-tree content shas; each path is also written to disk
  workingShas: Record<string, string>;
  objectTypes: Record<string, string>;
}

const MERGE_BASE = "abcdef0";
const SENTINEL_SHA = "9".repeat(40);

const lsTreeOutput = (blobs: Record<string, string>): string =>
  Object.entries(blobs)
    .map(([path, sha]) => `100644 blob ${sha}\t${path}\0`)
    .join("");

describe("resolveBranch", () => {
  it("returns the trimmed short name of HEAD", async () => {
    const git: Git = {
      repoRoot: "/repo",
      run: async (args) => {
        expect(args).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
        return "feat/moves\n";
      },
    };
    expect(await resolveBranch(git)).toBe("feat/moves");
  });
});

describe("computeReviewModel", () => {
  let repoRoot: string;
  let checkAttrStdin: string[];
  let gitCalls: string[][];

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "delta-review-model-"));
    checkAttrStdin = [];
    gitCalls = [];
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const setUp = async (repo: Partial<FakeRepo>): Promise<Git> => {
    const full: FakeRepo = {
      branch: "feat/moves",
      changes: [],
      untracked: [],
      baseBlobs: {},
      reviewState: {},
      workingShas: {},
      objectTypes: {},
      ...repo,
    };
    for (const path of Object.keys(full.workingShas)) {
      const absolute = join(repoRoot, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, path);
    }
    const diffOutput = full.changes
      .map((record) => record.join("\0") + "\0")
      .join("");
    return {
      repoRoot,
      run: async (args, options) => {
        gitCalls.push([...args]);
        if (args[0] === "rev-parse") {
          return `${full.branch}\n`;
        }
        if (args[0] === "merge-base") {
          return `${MERGE_BASE}\n`;
        }
        if (args[0] === "diff") {
          return diffOutput;
        }
        if (args[0] === "ls-files") {
          return full.untracked.map((path) => `${path}\0`).join("");
        }
        if (args[0] === "ls-tree") {
          if (args[3] === MERGE_BASE) {
            return lsTreeOutput(full.baseBlobs);
          }
          if (Object.keys(full.reviewState).length === 0) {
            throw new Error("fatal: not a valid object name");
          }
          return lsTreeOutput(full.reviewState);
        }
        if (args[0] === "check-attr") {
          checkAttrStdin.push(options?.stdin ?? "");
          return "";
        }
        if (args[0] === "cat-file") {
          const type = full.objectTypes[args[2]];
          if (type === undefined) {
            throw new Error(`fatal: Not a valid object name ${args[2]}`);
          }
          return `${type}\n`;
        }
        if (args[0] === "hash-object" && args[1] === "--stdin") {
          return `${SENTINEL_SHA}\n`;
        }
        if (args[0] === "hash-object") {
          return (
            (options?.stdin ?? "")
              .trim()
              .split("\n")
              .map((path) => full.workingShas[path])
              .join("\n") + "\n"
          );
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      },
    };
  };

  it("keeps today's diff bases when no moves are declared", async () => {
    const git = await setUp({
      changes: [
        ["M", "src/edited.ts"],
        ["A", "src/added.ts"],
        ["R100", "src/old.ts", "src/renamed.ts"],
      ],
      baseBlobs: { "src/edited.ts": PATH_SHA, "src/old.ts": ORIGIN_SHA },
      workingShas: {
        "src/edited.ts": WORKING_SHA,
        "src/added.ts": WORKING_SHA,
        "src/renamed.ts": ORIGIN_SHA,
      },
    });
    const model = await computeReviewModel(git, "main");
    expect(model.branch).toBe("feat/moves");
    expect(model.mergeBase).toBe(MERGE_BASE);
    expect(model.files.map((file) => file.path)).toEqual([
      "src/added.ts",
      "src/edited.ts",
      "src/renamed.ts",
    ]);
    expect(
      model.files.map((file) => [file.diffBaseSha, file.diffBasePath]),
    ).toEqual([
      [undefined, "src/added.ts"],
      [PATH_SHA, "src/edited.ts"],
      [ORIGIN_SHA, "src/old.ts"],
    ]);
    const renamed = model.files[2];
    expect(renamed.movedFrom).toBe("src/old.ts");
    expect(renamed.moveOrigin).toBe("repo");
    expect(renamed.moveClassification).toBe("verbatim");
    expect(renamed.originContentUnavailable).toBe(false);
  });

  it("asks git for HEAD only when no branch is supplied", async () => {
    const repo = {
      changes: [["M", "src/edited.ts"]] as FakeRepo["changes"],
      baseBlobs: { "src/edited.ts": PATH_SHA },
      workingShas: { "src/edited.ts": WORKING_SHA },
    };
    const resolved = await computeReviewModel(await setUp(repo), "main");
    expect(resolved.branch).toBe("feat/moves");
    expect(gitCalls).toContainEqual(["rev-parse", "--abbrev-ref", "HEAD"]);

    gitCalls = [];
    const supplied = await computeReviewModel(await setUp(repo), "main", {
      branch: "feat/supplied",
    });
    expect(supplied.branch).toBe("feat/supplied");
    expect(gitCalls.some((args) => args[0] === "rev-parse")).toBe(false);
    // The supplied branch is what the rest of the computation runs against
    expect(gitCalls).toContainEqual([
      "ls-tree",
      "-r",
      "-z",
      "refs/review/feat/supplied",
    ]);
  });

  it("feeds the move-adjusted path list to triage and the generated lookup", async () => {
    const git = await setUp({
      changes: [
        ["R100", "src/old.ts", "src/moved.ts"],
        ["D", "src/donated.ts"],
      ],
      baseBlobs: {
        "src/old.ts": ORIGIN_SHA,
        "src/donated.ts": PATH_SHA,
      },
      workingShas: { "src/moved.ts": WORKING_SHA },
    });
    const model = await computeReviewModel(git, "main", {
      autoReviewGlobs: ["src/old.ts"],
      moves: [
        declaration("src/moved.ts", "src/donated.ts", "repo"),
        // Ignored: not in the review set git computed
        declaration("src/absent.ts", "src/old.ts", "repo"),
      ],
    });
    // src/old.ts re-entered as a deleted file; src/donated.ts was suppressed
    expect(model.files.map((file) => file.path)).toEqual([
      "src/moved.ts",
      "src/old.ts",
    ]);
    expect(checkAttrStdin).toEqual(["src/moved.ts\0src/old.ts"]);
    expect(model.files[1].triage).toBe("auto");
    expect(model.files[1].deleted).toBe(true);
    expect(model.files[1].movedFrom).toBeUndefined();
    expect(model.files[0].movedFrom).toBe("src/donated.ts");
    expect(model.files[0].diffBaseSha).toBe(PATH_SHA);
  });

  it("leaves status and triage untouched by a declaration", async () => {
    const repo = {
      changes: [["M", "src/edited.ts"]] as FakeRepo["changes"],
      baseBlobs: { "src/edited.ts": PATH_SHA, "src/origin.ts": ORIGIN_SHA },
      reviewState: { "src/edited.ts": WORKING_SHA },
      workingShas: { "src/edited.ts": WORKING_SHA },
    };
    const plain = await computeReviewModel(await setUp(repo), "main");
    const declared = await computeReviewModel(await setUp(repo), "main", {
      moves: [declaration("src/edited.ts", "src/origin.ts", "repo")],
    });
    expect(plain.files[0].status).toBe(FileReviewStatus.Reviewed);
    expect(declared.files[0].status).toBe(plain.files[0].status);
    expect(declared.files[0].triage).toBe(plain.files[0].triage);
    // The declaration changes only the move facet
    expect(declared.files[0].moveOrigin).toBe("repo");
    expect(declared.files[0].moveClassification).toBe("adapted");
  });

  it("uses a readable external base blob and carries the declaration through", async () => {
    const git = await setUp({
      changes: [["A", "src/copied.ts"]],
      workingShas: { "src/copied.ts": EXTERNAL_SHA },
      objectTypes: { [EXTERNAL_SHA]: "blob" },
    });
    const model = await computeReviewModel(git, "main", {
      moves: [
        declaration("src/copied.ts", "../donor/src/copied.ts", "external", {
          donor: "donor-app",
          baseBlob: EXTERNAL_SHA,
          note: "lifted wholesale",
        }),
      ],
    });
    expect(model.files[0]).toMatchObject({
      path: "src/copied.ts",
      diffBaseSha: EXTERNAL_SHA,
      diffBasePath: "src/copied.ts",
      movedFrom: "../donor/src/copied.ts",
      moveOrigin: "external",
      donor: "donor-app",
      moveNote: "lifted wholesale",
      moveClassification: "verbatim",
      originContentUnavailable: false,
    });
  });

  it("degrades an unreadable or non-blob external base blob without throwing", async () => {
    const missing = await setUp({
      changes: [["A", "src/copied.ts"]],
      workingShas: { "src/copied.ts": WORKING_SHA },
    });
    const tree = await setUp({
      changes: [["A", "src/copied.ts"]],
      workingShas: { "src/copied.ts": WORKING_SHA },
      objectTypes: { [EXTERNAL_SHA]: "tree" },
    });
    const moves = [
      declaration("src/copied.ts", "../donor/src/copied.ts", "external", {
        donor: "donor-app",
        baseBlob: EXTERNAL_SHA,
      }),
    ];
    for (const git of [missing, tree]) {
      const model = await computeReviewModel(git, "main", { moves });
      expect(model.files[0]).toMatchObject({
        diffBaseSha: undefined,
        diffBasePath: "src/copied.ts",
        moveOrigin: "external",
        moveClassification: "unknown",
        originContentUnavailable: true,
      });
    }
  });
});
