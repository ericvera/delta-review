import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MoveDeclaration } from "./clusters";
import type { Git } from "./git";
import type { HashCacheEntry } from "./hashCache";
import {
  adjustReviewSetForMoves,
  computeReviewModel,
  FileReviewStatus,
  hasAnyReviewSnapshot,
  parseCheckAttrOutput,
  pathsWithReviewSnapshot,
  ResolvedMove,
  resolveBranch,
  resolveFileBase,
  ReviewFile,
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
  // stdin of each `hash-object --stdin-paths` batch, in call order
  let hashPathsStdin: string[];

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "delta-review-model-"));
    checkAttrStdin = [];
    gitCalls = [];
    hashPathsStdin = [];
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
            const separator = args.indexOf("--");
            if (separator === -1) {
              return lsTreeOutput(full.baseBlobs);
            }
            // git reports only the entries the pathspecs name, so the stub
            // does too: a path missing from them really does lose its blob
            const wanted = new Set(
              args
                .slice(separator + 1)
                .map((pathspec) => pathspec.replace(":(literal)", "")),
            );
            return lsTreeOutput(
              Object.fromEntries(
                Object.entries(full.baseBlobs).filter(([path]) =>
                  wanted.has(path),
                ),
              ),
            );
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
          hashPathsStdin.push(options?.stdin ?? "");
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

  it("scopes the merge-base lookup to the review set and its move origins", async () => {
    const git = await setUp({
      changes: [
        ["M", "src/edited.ts"],
        ["R100", "src/renamed-from.ts", "src/renamed.ts"],
      ],
      untracked: ["src/copied.ts"],
      baseBlobs: {
        "src/edited.ts": PATH_SHA,
        "src/renamed-from.ts": ORIGIN_SHA,
        "src/declared-from.ts": ORIGIN_SHA,
      },
      workingShas: {
        "src/edited.ts": WORKING_SHA,
        "src/renamed.ts": ORIGIN_SHA,
        "src/copied.ts": WORKING_SHA,
      },
    });
    await computeReviewModel(git, "main", {
      moves: [
        declaration("src/edited.ts", "src/declared-from.ts", "repo"),
        declaration("src/copied.ts", "../donor/src/copied.ts", "external", {
          donor: "donor-app",
        }),
        // Outside the review set: ignored by the adjustment, so it must not
        // reach the pathspecs either
        declaration("src/absent.ts", "src/never-asked.ts", "repo"),
      ],
    });
    const lsTree = gitCalls.find(
      (args) => args[0] === "ls-tree" && args[3] === MERGE_BASE,
    );
    expect(lsTree?.slice(0, 5)).toEqual([
      "ls-tree",
      "-r",
      "-z",
      MERGE_BASE,
      "--",
    ]);
    // Literal magic on every pathspec, and the external origin's donor path —
    // which escapes the repository — is never one of them
    expect(new Set(lsTree?.slice(5))).toEqual(
      new Set([
        ":(literal)src/edited.ts",
        ":(literal)src/renamed.ts",
        ":(literal)src/renamed-from.ts",
        ":(literal)src/copied.ts",
        ":(literal)src/declared-from.ts",
      ]),
    );
  });

  it("splits a large pathspec list into batches and merges the results", async () => {
    const paths = Array.from(
      { length: 601 },
      (_, index) => `src/f${String(index).padStart(4, "0")}.ts`,
    );
    const git = await setUp({
      changes: paths.map((path) => ["M", path] as [string, string]),
      baseBlobs: Object.fromEntries(paths.map((path) => [path, PATH_SHA])),
      workingShas: Object.fromEntries(paths.map((path) => [path, WORKING_SHA])),
    });
    const model = await computeReviewModel(git, "main");
    const lsTreeCalls = gitCalls.filter(
      (args) => args[0] === "ls-tree" && args[3] === MERGE_BASE,
    );
    expect(lsTreeCalls.map((args) => args.length - 5)).toEqual([500, 101]);
    // Every batch's blobs survive the merge
    expect(model.files.length).toBe(601);
    expect(model.files.every((file) => file.diffBaseSha === PATH_SHA)).toBe(
      true,
    );
    expect(model.files.every((file) => file.existsInMergeBase)).toBe(true);
  });

  it("reuses cached working-tree hashes and re-hashes only what changed", async () => {
    const git = await setUp({
      changes: [
        ["M", "src/a.ts"],
        ["M", "src/b.ts"],
      ],
      baseBlobs: { "src/a.ts": PATH_SHA, "src/b.ts": PATH_SHA },
      workingShas: { "src/a.ts": WORKING_SHA, "src/b.ts": ORIGIN_SHA },
    });
    const hashCache = new Map<string, HashCacheEntry>();
    const cold = await computeReviewModel(git, "main", { hashCache });
    expect(hashPathsStdin).toEqual(["src/a.ts\nsrc/b.ts\n"]);

    hashPathsStdin = [];
    const warm = await computeReviewModel(git, "main", { hashCache });
    expect(hashPathsStdin).toEqual([]);
    expect(warm).toEqual(cold);

    // Rewriting one file changes its size, so exactly that path is re-hashed
    await writeFile(join(repoRoot, "src/b.ts"), "content that is not the path");
    hashPathsStdin = [];
    const touched = await computeReviewModel(git, "main", { hashCache });
    expect(hashPathsStdin).toEqual(["src/b.ts\n"]);
    expect(touched).toEqual(cold);
  });

  it("keeps a file that left the working tree out of the hash batch and the cache", async () => {
    const git = await setUp({
      changes: [
        ["M", "src/a.ts"],
        ["M", "src/gone.ts"],
      ],
      baseBlobs: { "src/a.ts": PATH_SHA, "src/gone.ts": PATH_SHA },
      workingShas: { "src/a.ts": WORKING_SHA, "src/gone.ts": WORKING_SHA },
    });
    const hashCache = new Map<string, HashCacheEntry>();
    await computeReviewModel(git, "main", { hashCache });
    expect(hashCache.has("src/gone.ts")).toBe(true);

    await rm(join(repoRoot, "src/gone.ts"));
    hashPathsStdin = [];
    const model = await computeReviewModel(git, "main", { hashCache });
    // A missing path in a `hash-object --stdin-paths` batch fails the whole
    // batch, so it must never be sent — it reads as deleted instead
    expect(hashPathsStdin).toEqual([]);
    expect(model.files.map((file) => [file.path, file.deleted])).toEqual([
      ["src/a.ts", false],
      ["src/gone.ts", true],
    ]);
  });

  it("computes the same model with and without a hash cache", async () => {
    const repo: Partial<FakeRepo> = {
      changes: [
        ["R100", "src/old.ts", "src/moved.ts"],
        ["M", "src/edited.ts"],
        ["D", "src/removed.ts"],
      ],
      untracked: ["src/added.ts"],
      baseBlobs: {
        "src/old.ts": ORIGIN_SHA,
        "src/edited.ts": PATH_SHA,
        "src/removed.ts": PATH_SHA,
      },
      reviewState: { "src/edited.ts": REVIEWED_SHA },
      workingShas: {
        "src/moved.ts": ORIGIN_SHA,
        "src/edited.ts": WORKING_SHA,
        "src/added.ts": WORKING_SHA,
      },
    };
    const plain = await computeReviewModel(await setUp(repo), "main");
    const cachedFirst = await computeReviewModel(await setUp(repo), "main", {
      hashCache: new Map(),
    });
    expect(cachedFirst).toEqual(plain);
  });

  it("asks git for the deleted-file sentinel sha once per repository", async () => {
    const repo: Partial<FakeRepo> = {
      changes: [["D", "src/removed.ts"]],
      baseBlobs: { "src/removed.ts": PATH_SHA },
    };
    const git = await setUp(repo);
    await computeReviewModel(git, "main");
    await computeReviewModel(git, "main");
    expect(
      gitCalls.filter(
        (args) => args[0] === "hash-object" && args[1] === "--stdin",
      ).length,
    ).toBe(1);
  });

  it("keeps the snapshot of a file whose content diverged from it", async () => {
    const git = await setUp({
      changes: [["M", "src/edited.ts"]],
      baseBlobs: { "src/edited.ts": PATH_SHA },
      // Marked reviewed at REVIEWED_SHA, then rebased or edited to WORKING_SHA
      reviewState: { "src/edited.ts": REVIEWED_SHA },
      workingShas: { "src/edited.ts": WORKING_SHA },
    });
    const model = await computeReviewModel(git, "main");
    expect(model.files[0]).toMatchObject({
      path: "src/edited.ts",
      status: FileReviewStatus.NeedsReview,
      diffBaseIsReviewedSnapshot: true,
      hasReviewSnapshot: true,
      diffBaseSha: REVIEWED_SHA,
    });
    // The status filter this replaced skipped exactly this file
    expect(pathsWithReviewSnapshot(model.files)).toEqual(["src/edited.ts"]);
  });

  it("reports a snapshot on a recreated file whose snapshot is the deleted sentinel", async () => {
    const git = await setUp({
      changes: [["M", "src/recreated.ts"]],
      baseBlobs: { "src/recreated.ts": PATH_SHA },
      reviewState: { "src/recreated.ts": SENTINEL_SHA },
      workingShas: { "src/recreated.ts": WORKING_SHA },
    });
    const model = await computeReviewModel(git, "main");
    // The sentinel is no usable diff base, so the merge base wins — but the
    // ref entry is there and an unmark has to drop it
    expect(model.files[0]).toMatchObject({
      path: "src/recreated.ts",
      status: FileReviewStatus.NeedsReview,
      diffBaseIsReviewedSnapshot: false,
      hasReviewSnapshot: true,
      diffBaseSha: PATH_SHA,
    });
    expect(pathsWithReviewSnapshot(model.files)).toEqual(["src/recreated.ts"]);
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

const reviewFile = (
  path: string,
  overrides: Partial<ReviewFile> = {},
): ReviewFile => ({
  path,
  status: FileReviewStatus.NeedsReview,
  deleted: false,
  existsInMergeBase: true,
  diffBaseIsReviewedSnapshot: false,
  hasReviewSnapshot: false,
  diffBaseSha: undefined,
  diffBasePath: path,
  movedFrom: undefined,
  moveOrigin: undefined,
  donor: undefined,
  moveNote: undefined,
  moveClassification: undefined,
  originContentUnavailable: false,
  triage: "normal",
  ...overrides,
});

const mixedScope: ReviewFile[] = [
  reviewFile("src/reviewed.ts", {
    status: FileReviewStatus.Reviewed,
    hasReviewSnapshot: true,
  }),
  reviewFile("src/never-reviewed.ts"),
  // Diverged from its snapshot: needs review, still diffing against it
  reviewFile("src/diverged.ts", {
    diffBaseIsReviewedSnapshot: true,
    hasReviewSnapshot: true,
  }),
  // Reviewed while deleted, then recreated: the sentinel snapshot is no
  // diff base, but it is still an entry in the ref
  reviewFile("src/recreated.ts", { hasReviewSnapshot: true }),
];

describe("pathsWithReviewSnapshot", () => {
  it("takes every file holding a snapshot, whatever its status, in order", () => {
    expect(pathsWithReviewSnapshot(mixedScope)).toEqual([
      "src/reviewed.ts",
      "src/diverged.ts",
      "src/recreated.ts",
    ]);
  });

  it("is empty when nothing in the scope holds a snapshot", () => {
    expect(pathsWithReviewSnapshot([reviewFile("src/a.ts")])).toEqual([]);
    expect(pathsWithReviewSnapshot([])).toEqual([]);
  });
});

describe("hasAnyReviewSnapshot", () => {
  it("is true as soon as one file holds a snapshot", () => {
    expect(hasAnyReviewSnapshot(mixedScope)).toBe(true);
    expect(
      hasAnyReviewSnapshot([
        reviewFile("src/recreated.ts", { hasReviewSnapshot: true }),
      ]),
    ).toBe(true);
  });

  it("is false for a scope with no snapshots", () => {
    expect(hasAnyReviewSnapshot([reviewFile("src/a.ts")])).toBe(false);
    expect(hasAnyReviewSnapshot([])).toBe(false);
  });
});
