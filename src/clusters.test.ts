import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClusterModel,
  ClustersContract,
  MoveDeclaration,
  ParseClustersResult,
  clusterBodyState,
  clusterBucketForKey,
  clusterContextValue,
  clusterCountDescription,
  clusterFilesForKey,
  filterByStatus,
  loadClustersContract,
  parseClustersContract,
  resolveClusterModel,
  sanitizeBranchForFilename,
} from "./clusters";
import type { Git } from "./git";
import { FileReviewStatus, ReviewFile } from "./model";
import type { Triage } from "./triage";

const file = (path: string, triage: Triage = "normal"): ReviewFile => ({
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
  moveDeclared: false,
  donor: undefined,
  moveNote: undefined,
  originLinesOutOfRange: false,
  moveClassification: undefined,
  originContentUnavailable: false,
  triage,
});

const reviewedFile = (path: string, triage: Triage = "normal"): ReviewFile => ({
  ...file(path, triage),
  status: FileReviewStatus.Reviewed,
  hasReviewSnapshot: true,
});

const contract = (
  clusters: ClustersContract["clusters"],
): ClustersContract => ({
  version: 1,
  clusters,
  moves: [],
  notes: new Map(),
});

const contractV2 = (
  clusters: ClustersContract["clusters"],
  moves: ClustersContract["moves"] = [],
): ClustersContract => ({ version: 2, clusters, moves, notes: new Map() });

const contractV3 = (
  clusters: ClustersContract["clusters"],
  moves: ClustersContract["moves"] = [],
  notes: ClustersContract["notes"] = new Map(),
): ClustersContract => ({ version: 3, clusters, moves, notes });

const move = (
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

describe("sanitizeBranchForFilename", () => {
  it("replaces slashes", () => {
    expect(sanitizeBranchForFilename("feature/foo")).toBe("feature-foo");
  });

  it("keeps letters, digits, dot, underscore, and hyphen", () => {
    expect(sanitizeBranchForFilename("release-1.2_rc")).toBe("release-1.2_rc");
  });

  it("replaces spaces and unicode characters", () => {
    expect(sanitizeBranchForFilename("wip héllo world")).toBe(
      "wip-h-llo-world",
    );
  });

  it("replaces every disallowed char independently", () => {
    expect(sanitizeBranchForFilename("a/b\\c:d*e")).toBe("a-b-c-d-e");
  });
});

describe("parseClustersContract", () => {
  const validText = JSON.stringify({
    version: 1,
    clusters: [{ label: "API", summary: "API changes", files: ["src/api.ts"] }],
  });

  it("accepts a valid version-1 contract", () => {
    const result = parseClustersContract(validText);
    expect(result).toEqual({
      ok: true,
      contract: contract([
        {
          label: "API",
          summary: "API changes",
          files: ["src/api.ts"],
          patterns: [],
        },
      ]),
    });
  });

  it("normalizes absent files/patterns to empty arrays", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [
          { label: "Tests", summary: "s", patterns: ["**/*.test.ts"] },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      contract: contract([
        { label: "Tests", summary: "s", files: [], patterns: ["**/*.test.ts"] },
      ]),
    });
  });

  it("ignores unknown extra keys", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        generatedBy: "skill",
        clusters: [
          { label: "A", summary: "s", files: ["a.ts"], priority: "high" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const result = parseClustersContract("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not valid JSON");
    }
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["string", '"hi"'],
  ])("rejects a non-object top level (%s)", (_name, text) => {
    expect(parseClustersContract(text)).toEqual({
      ok: false,
      error: "top level must be an object",
    });
  });

  it("rejects a missing version", () => {
    const result = parseClustersContract(JSON.stringify({ clusters: [] }));
    expect(result).toEqual({
      ok: false,
      error: 'missing "version" (extension supports 1, 2 and 3)',
    });
  });

  it.each([
    [0, "unsupported version 0 (extension supports 1, 2 and 3)"],
    ["1", 'unsupported version "1" (extension supports 1, 2 and 3)'],
  ])("rejects version %j", (version, error) => {
    const result = parseClustersContract(
      JSON.stringify({ version, clusters: [] }),
    );
    expect(result).toEqual({ ok: false, error });
  });

  it("rejects non-array clusters", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 1, clusters: {} }),
    );
    expect(result).toEqual({ ok: false, error: '"clusters" must be an array' });
  });

  it("rejects a non-object cluster entry", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 1, clusters: ["nope"] }),
    );
    expect(result).toEqual({ ok: false, error: "cluster 1 must be an object" });
  });

  it("rejects a cluster with a missing label", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [{ summary: "s", files: ["a"] }],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'cluster 1: "label" must be a string',
    });
  });

  it("rejects a cluster with a missing summary", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 1, clusters: [{ label: "A", files: ["a"] }] }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'cluster 1 ("A"): "summary" must be a string',
    });
  });

  it("rejects a cluster with empty files and patterns", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [
          { label: "A", summary: "s", files: ["a"] },
          { label: "B", summary: "s", files: [], patterns: [] },
        ],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error:
        'cluster 2 ("B"): needs at least one of "files" or "patterns" (non-empty)',
    });
  });

  it("rejects a cluster with neither files nor patterns", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 1, clusters: [{ label: "A", summary: "s" }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects non-array files", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [{ label: "A", summary: "s", files: "a.ts" }],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'cluster 1 ("A"): "files" must be an array of strings',
    });
  });

  it("rejects files containing non-strings", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [{ label: "A", summary: "s", files: ["a.ts", 3] }],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects non-array patterns", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [{ label: "A", summary: "s", patterns: { glob: "**" } }],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'cluster 1 ("A"): "patterns" must be an array of strings',
    });
  });

  it("accepts an empty clusters array", () => {
    expect(
      parseClustersContract(JSON.stringify({ version: 1, clusters: [] })),
    ).toEqual({ ok: true, contract: contract([]) });
  });

  it("accepts a version 3 contract with neither moves nor notes", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 3, clusters: [] }),
    );
    expect(result).toEqual({ ok: true, contract: contractV3([]) });
  });

  it("rejects version 4, naming all three supported versions", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 4, clusters: [] }),
    );
    expect(result).toEqual({
      ok: false,
      error: "unsupported version 4 (extension supports 1, 2 and 3)",
    });
  });
});

describe("parseClustersContract moves", () => {
  const parseMoves = (moves: unknown): ParseClustersResult =>
    parseClustersContract(JSON.stringify({ version: 2, clusters: [], moves }));

  it("yields an empty moves array for a version 1 contract", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 1, clusters: [] }),
    );
    expect(result).toEqual({ ok: true, contract: contract([]) });
  });

  it("ignores a moves key inside a version 1 contract", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 1,
        clusters: [],
        moves: [{ path: "", origin: "nonsense" }],
      }),
    );
    expect(result).toEqual({ ok: true, contract: contract([]) });
  });

  it("yields an empty moves array for a version 2 contract without moves", () => {
    const result = parseClustersContract(
      JSON.stringify({ version: 2, clusters: [] }),
    );
    expect(result).toEqual({ ok: true, contract: contractV2([]) });
  });

  it("accepts an empty moves array", () => {
    expect(parseMoves([])).toEqual({ ok: true, contract: contractV2([]) });
  });

  it("accepts an external declaration with every optional field", () => {
    const result = parseMoves([
      {
        path: "src/cache.ts",
        from: "lib/cache.ts",
        origin: "external",
        donor: "donor-app",
        baseBlob: "a".repeat(40),
        note: "renamed the logger import",
        unknownKey: "ignored",
      },
    ]);
    expect(result).toEqual({
      ok: true,
      contract: contractV2(
        [],
        [
          move("src/cache.ts", "lib/cache.ts", "external", {
            donor: "donor-app",
            baseBlob: "a".repeat(40),
            note: "renamed the logger import",
          }),
        ],
      ),
    });
  });

  it("accepts a 64-character baseBlob", () => {
    const result = parseMoves([
      {
        path: "a.ts",
        from: "b.ts",
        origin: "external",
        baseBlob: "0".repeat(64),
      },
    ]);
    expect(result).toEqual({
      ok: true,
      contract: contractV2(
        [],
        [move("a.ts", "b.ts", "external", { baseBlob: "0".repeat(64) })],
      ),
    });
  });

  it("accepts a repo declaration", () => {
    const result = parseMoves([
      { path: "src/new.ts", from: "src/old.ts", origin: "repo" },
    ]);
    expect(result).toEqual({
      ok: true,
      contract: contractV2([], [move("src/new.ts", "src/old.ts", "repo")]),
    });
  });

  it("rejects moves that are not an array", () => {
    expect(parseMoves({ path: "a.ts" })).toEqual({
      ok: false,
      error: '"moves" must be an array',
    });
    expect(parseMoves("a.ts")).toEqual({
      ok: false,
      error: '"moves" must be an array',
    });
  });

  it.each([
    ["a non-object entry", "nope", "move 1 must be an object"],
    ["an array entry", [], "move 1 must be an object"],
    [
      "a missing path",
      { from: "src/old.ts", origin: "repo" },
      'move 1: "path" must be a non-empty string',
    ],
    [
      "an empty path",
      { path: "", from: "src/old.ts", origin: "repo" },
      'move 1: "path" must be a non-empty string',
    ],
    [
      "a non-string path",
      { path: 3, from: "src/old.ts", origin: "repo" },
      'move 1: "path" must be a non-empty string',
    ],
    [
      "a missing from",
      { path: "src/new.ts", origin: "repo" },
      'move 1 ("src/new.ts"): "from" must be a non-empty string',
    ],
    [
      "an empty from",
      { path: "src/new.ts", from: "", origin: "repo" },
      'move 1 ("src/new.ts"): "from" must be a non-empty string',
    ],
    [
      "a missing origin",
      { path: "src/new.ts", from: "src/old.ts" },
      'move 1 ("src/new.ts"): "origin" must be "repo" or "external"',
    ],
    [
      "an unknown origin",
      { path: "src/new.ts", from: "src/old.ts", origin: "Repo" },
      'move 1 ("src/new.ts"): "origin" must be "repo" or "external"',
    ],
    [
      "an empty donor",
      {
        path: "src/new.ts",
        from: "src/old.ts",
        origin: "external",
        donor: "",
      },
      'move 1 ("src/new.ts"): "donor" must be a non-empty string',
    ],
    [
      "a non-string donor",
      {
        path: "src/new.ts",
        from: "src/old.ts",
        origin: "external",
        donor: ["donor-app"],
      },
      'move 1 ("src/new.ts"): "donor" must be a non-empty string',
    ],
    [
      "a short baseBlob",
      {
        path: "src/new.ts",
        from: "src/old.ts",
        origin: "external",
        baseBlob: "abc",
      },
      'move 1 ("src/new.ts"): "baseBlob" must be a 40- or 64-character hex object id',
    ],
    [
      "a non-hex baseBlob",
      {
        path: "src/new.ts",
        from: "src/old.ts",
        origin: "external",
        baseBlob: `-oops${"a".repeat(35)}`,
      },
      'move 1 ("src/new.ts"): "baseBlob" must be a 40- or 64-character hex object id',
    ],
    [
      "a baseBlob with trailing junk",
      {
        path: "src/new.ts",
        from: "src/old.ts",
        origin: "external",
        baseBlob: `${"a".repeat(40)} --bad`,
      },
      'move 1 ("src/new.ts"): "baseBlob" must be a 40- or 64-character hex object id',
    ],
    [
      "a non-string note",
      { path: "src/new.ts", from: "src/old.ts", origin: "repo", note: 7 },
      'move 1 ("src/new.ts"): "note" must be a string',
    ],
  ])("rejects the contract for %s", (_name, entry, error) => {
    expect(parseMoves([entry])).toEqual({ ok: false, error });
  });

  it("names the offending entry by its index", () => {
    const result = parseMoves([
      { path: "a.ts", from: "b.ts", origin: "repo" },
      { path: "c.ts", from: "d.ts", origin: "sideways" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('move 2 ("c.ts")');
    }
  });

  it("drops donor and baseBlob on a repo entry, whatever their type", () => {
    const result = parseMoves([
      {
        path: "src/new.ts",
        from: "src/old.ts",
        origin: "repo",
        donor: 42,
        baseBlob: "not-a-blob",
      },
    ]);
    expect(result).toEqual({
      ok: true,
      contract: contractV2([], [move("src/new.ts", "src/old.ts", "repo")]),
    });
  });

  it("skips a repo entry whose from equals its path", () => {
    expect(
      parseMoves([{ path: "a.ts", from: "a.ts", origin: "repo" }]),
    ).toEqual({ ok: true, contract: contractV2([]) });
  });

  it("lets a later real declaration win over a skipped self-move", () => {
    const result = parseMoves([
      { path: "a.ts", from: "a.ts", origin: "repo" },
      { path: "a.ts", from: "old/a.ts", origin: "repo" },
    ]);
    expect(result).toEqual({
      ok: true,
      contract: contractV2([], [move("a.ts", "old/a.ts", "repo")]),
    });
  });

  it("does not skip a self-move on an external entry", () => {
    const result = parseMoves([
      { path: "a.ts", from: "a.ts", origin: "external", donor: "donor-app" },
    ]);
    expect(result).toEqual({
      ok: true,
      contract: contractV2(
        [],
        [move("a.ts", "a.ts", "external", { donor: "donor-app" })],
      ),
    });
  });

  it("rejects a repo entry with neither path nor from", () => {
    expect(parseMoves([{ origin: "repo" }])).toEqual({
      ok: false,
      error: 'move 1: "path" must be a non-empty string',
    });
  });

  it("rejects a repo entry whose path and from are both null", () => {
    expect(parseMoves([{ path: null, from: null, origin: "repo" }])).toEqual({
      ok: false,
      error: 'move 1: "path" must be a non-empty string',
    });
  });

  it("keeps the first declaration for a duplicated path", () => {
    const result = parseMoves([
      { path: "a.ts", from: "first.ts", origin: "repo" },
      { path: "a.ts", from: "second.ts", origin: "external", donor: "d" },
      { path: "b.ts", from: "other.ts", origin: "repo" },
    ]);
    expect(result).toEqual({
      ok: true,
      contract: contractV2(
        [],
        [move("a.ts", "first.ts", "repo"), move("b.ts", "other.ts", "repo")],
      ),
    });
  });

  it("rejects a bad moves entry even when the clusters are valid", () => {
    const result = parseClustersContract(
      JSON.stringify({
        version: 2,
        clusters: [{ label: "A", summary: "s", files: ["a.ts"] }],
        moves: [{ path: "a.ts", from: "b.ts", origin: "repo" }, "nope"],
      }),
    );
    expect(result).toEqual({ ok: false, error: "move 2 must be an object" });
  });
});

describe("parseClustersContract version 3 moves", () => {
  const parseMovesV3 = (moves: unknown): ParseClustersResult =>
    parseClustersContract(JSON.stringify({ version: 3, clusters: [], moves }));

  const parseMovesV2 = (moves: unknown): ParseClustersResult =>
    parseClustersContract(JSON.stringify({ version: 2, clusters: [], moves }));

  it("still reads moves in a version 3 contract", () => {
    expect(
      parseMovesV3([{ path: "a.ts", from: "b.ts", origin: "repo" }]),
    ).toEqual({
      ok: true,
      contract: contractV3([], [move("a.ts", "b.ts", "repo")]),
    });
  });

  it("keeps baseBlob on a repo entry", () => {
    expect(
      parseMovesV3([
        {
          path: "src/new.ts",
          from: "src/old.ts",
          origin: "repo",
          baseBlob: "a".repeat(40),
        },
      ]),
    ).toEqual({
      ok: true,
      contract: contractV3(
        [],
        [
          move("src/new.ts", "src/old.ts", "repo", {
            baseBlob: "a".repeat(40),
          }),
        ],
      ),
    });
  });

  it("rejects a malformed baseBlob on a repo entry", () => {
    expect(
      parseMovesV3([
        {
          path: "src/new.ts",
          from: "src/old.ts",
          origin: "repo",
          baseBlob: "not-a-blob",
        },
      ]),
    ).toEqual({
      ok: false,
      error:
        'move 1 ("src/new.ts"): "baseBlob" must be a 40- or 64-character hex object id',
    });
  });

  it("still drops donor on a repo entry", () => {
    expect(
      parseMovesV3([
        { path: "a.ts", from: "b.ts", origin: "repo", donor: "donor-app" },
      ]),
    ).toEqual({
      ok: true,
      contract: contractV3([], [move("a.ts", "b.ts", "repo")]),
    });
  });

  it("accepts a single fromLines range", () => {
    expect(
      parseMovesV3([
        {
          path: "src/slice.ts",
          from: "src/big.ts",
          origin: "repo",
          fromLines: [[120, 180]],
          baseBlob: "b".repeat(40),
        },
      ]),
    ).toEqual({
      ok: true,
      contract: contractV3(
        [],
        [
          move("src/slice.ts", "src/big.ts", "repo", {
            fromLines: [[120, 180]],
            baseBlob: "b".repeat(40),
          }),
        ],
      ),
    });
  });

  it("accepts several ascending, non-overlapping fromLines ranges", () => {
    expect(
      parseMovesV3([
        {
          path: "a.ts",
          from: "b.ts",
          origin: "repo",
          fromLines: [
            [1, 4],
            [5, 5],
            [40, 90],
          ],
        },
      ]),
    ).toEqual({
      ok: true,
      contract: contractV3(
        [],
        [
          move("a.ts", "b.ts", "repo", {
            fromLines: [
              [1, 4],
              [5, 5],
              [40, 90],
            ],
          }),
        ],
      ),
    });
  });

  it.each([
    ["a non-array", "120-180"],
    ["an object", { start: 1, end: 2 }],
    ["an empty array", []],
    ["a non-array pair", [5]],
    ["a one-element pair", [[5]]],
    ["a three-element pair", [[1, 2, 3]]],
    ["a non-integer start", [[1.5, 5]]],
    ["a non-integer end", [[1, "5"]]],
    ["a zero start", [[0, 5]]],
    ["a negative start", [[-2, 5]]],
    ["an end before its start", [[5, 4]]],
    [
      "ranges sharing a line",
      [
        [1, 10],
        [10, 20],
      ],
    ],
    [
      "overlapping ranges",
      [
        [1, 10],
        [5, 20],
      ],
    ],
    [
      "descending ranges",
      [
        [10, 20],
        [1, 5],
      ],
    ],
  ])("rejects the contract for fromLines that is %s", (_name, fromLines) => {
    expect(
      parseMovesV3([
        { path: "src/new.ts", from: "src/old.ts", origin: "repo", fromLines },
      ]),
    ).toEqual({
      ok: false,
      error:
        'move 1 ("src/new.ts"): "fromLines" must be a non-empty array of ascending, non-overlapping [start, end] line pairs',
    });
  });

  it("drops fromLines on an external entry, whatever its value", () => {
    expect(
      parseMovesV3([
        {
          path: "a.ts",
          from: "lib/a.ts",
          origin: "external",
          donor: "donor-app",
          fromLines: "nonsense",
        },
      ]),
    ).toEqual({
      ok: true,
      contract: contractV3(
        [],
        [move("a.ts", "lib/a.ts", "external", { donor: "donor-app" })],
      ),
    });
  });

  it("ignores fromLines inside a version 2 contract, even when malformed", () => {
    expect(
      parseMovesV2([
        { path: "a.ts", from: "b.ts", origin: "repo", fromLines: [[0, 0]] },
      ]),
    ).toEqual({
      ok: true,
      contract: contractV2([], [move("a.ts", "b.ts", "repo")]),
    });
  });
});

describe("parseClustersContract notes", () => {
  const parseNotes = (notes: unknown): ParseClustersResult =>
    parseClustersContract(JSON.stringify({ version: 3, clusters: [], notes }));

  it("parses notes into a map", () => {
    expect(parseNotes({ "a.ts": "first", "src/b.ts": "second" })).toEqual({
      ok: true,
      contract: contractV3(
        [],
        [],
        new Map([
          ["a.ts", "first"],
          ["src/b.ts", "second"],
        ]),
      ),
    });
  });

  it("accepts an empty notes object", () => {
    expect(parseNotes({})).toEqual({ ok: true, contract: contractV3([]) });
  });

  it("drops empty-string values", () => {
    expect(parseNotes({ "a.ts": "", "b.ts": "kept" })).toEqual({
      ok: true,
      contract: contractV3([], [], new Map([["b.ts", "kept"]])),
    });
  });

  it("keeps a multi-line note verbatim", () => {
    expect(parseNotes({ "a.ts": "  one\ntwo  " })).toEqual({
      ok: true,
      contract: contractV3([], [], new Map([["a.ts", "  one\ntwo  "]])),
    });
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a string", "a remark"],
    ["a number", 7],
  ])("rejects notes that are %s", (_name, notes) => {
    expect(parseNotes(notes)).toEqual({
      ok: false,
      error: '"notes" must be an object',
    });
  });

  it("rejects a non-string value, naming its key", () => {
    expect(parseNotes({ "a.ts": "fine", "src/b.ts": 7 })).toEqual({
      ok: false,
      error: 'notes["src/b.ts"] must be a string',
    });
  });

  it("ignores notes inside a version 2 contract, even when malformed", () => {
    expect(
      parseClustersContract(
        JSON.stringify({ version: 2, clusters: [], notes: "nonsense" }),
      ),
    ).toEqual({ ok: true, contract: contractV2([]) });
  });

  it("ignores notes inside a version 1 contract, even when malformed", () => {
    expect(
      parseClustersContract(
        JSON.stringify({ version: 1, clusters: [], notes: [1] }),
      ),
    ).toEqual({ ok: true, contract: contract([]) });
  });

  it("reports a moves error before a notes error", () => {
    expect(
      parseClustersContract(
        JSON.stringify({
          version: 3,
          clusters: [],
          moves: ["nope"],
          notes: "nonsense",
        }),
      ),
    ).toEqual({ ok: false, error: "move 1 must be an object" });
  });
});

describe("resolveClusterModel", () => {
  it("assigns files by explicit listing and patterns, in contract order", () => {
    const api = file("src/api.ts");
    const apiTest = file("src/api.test.ts");
    const readme = file("README.md");
    const model = resolveClusterModel(
      contract([
        { label: "API", summary: "s", files: ["src/api.ts"], patterns: [] },
        { label: "Tests", summary: "s", files: [], patterns: ["**/*.test.ts"] },
      ]),
      [readme, api, apiTest],
    );
    expect(model.clusters[0].files).toEqual([api]);
    expect(model.clusters[1].files).toEqual([apiTest]);
    expect(model.unclustered).toEqual([readme]);
    expect(model.auto).toEqual([]);
  });

  it("lets an explicit listing beat an earlier cluster's pattern match", () => {
    const api = file("src/api.ts");
    const model = resolveClusterModel(
      contract([
        { label: "Src", summary: "s", files: [], patterns: ["src/**"] },
        { label: "API", summary: "s", files: ["src/api.ts"], patterns: [] },
      ]),
      [api],
    );
    expect(model.clusters[0].files).toEqual([]);
    expect(model.clusters[1].files).toEqual([api]);
  });

  it("gives a file explicitly listed by several clusters to the first", () => {
    const api = file("src/api.ts");
    const model = resolveClusterModel(
      contract([
        { label: "A", summary: "s", files: ["src/api.ts"], patterns: [] },
        { label: "B", summary: "s", files: ["src/api.ts"], patterns: [] },
      ]),
      [api],
    );
    expect(model.clusters[0].files).toEqual([api]);
    expect(model.clusters[1].files).toEqual([]);
  });

  it("gives a pattern-matched file to the first matching cluster", () => {
    const util = file("src/util.ts");
    const model = resolveClusterModel(
      contract([
        { label: "A", summary: "s", files: [], patterns: ["src/**"] },
        { label: "B", summary: "s", files: [], patterns: ["**/*.ts"] },
      ]),
      [util],
    );
    expect(model.clusters[0].files).toEqual([util]);
    expect(model.clusters[1].files).toEqual([]);
  });

  it("sends auto-triaged files to the auto bucket even when explicitly listed", () => {
    const lock = file("yarn.lock", "auto");
    const gen = file("gen/out.js", "auto");
    const model = resolveClusterModel(
      contract([
        {
          label: "Deps",
          summary: "s",
          files: ["yarn.lock"],
          patterns: ["gen/**"],
        },
      ]),
      [gen, lock],
    );
    expect(model.auto).toEqual([gen, lock]);
    expect(model.clusters[0].files).toEqual([]);
    expect(model.unclustered).toEqual([]);
  });

  it("sends unmatched auto files to the auto bucket, not unclustered", () => {
    const lock = file("yarn.lock", "auto");
    const model = resolveClusterModel(contract([]), [lock]);
    expect(model.auto).toEqual([lock]);
    expect(model.unclustered).toEqual([]);
  });

  it("puts everything in unclustered/auto for an empty clusters array", () => {
    const a = file("a.ts");
    const b = file("b.lock", "auto");
    const model = resolveClusterModel(contract([]), [a, b]);
    expect(model.clusters).toEqual([]);
    expect(model.unclustered).toEqual([a]);
    expect(model.auto).toEqual([b]);
  });

  it("ignores contract files absent from the review set, leaving the cluster empty", () => {
    const other = file("other.ts");
    const model = resolveClusterModel(
      contract([
        { label: "Ghost", summary: "s", files: ["gone.ts"], patterns: [] },
      ]),
      [other],
    );
    expect(model.clusters[0]).toEqual({
      label: "Ghost",
      summary: "s",
      files: [],
    });
    expect(model.unclustered).toEqual([other]);
  });

  it("preserves the review set's order within each bucket", () => {
    const files = [file("a.ts"), file("m.ts"), file("z.ts"), file("zz.md")];
    const model = resolveClusterModel(
      contract([
        { label: "TS", summary: "s", files: [], patterns: ["**/*.ts"] },
      ]),
      files,
    );
    expect(model.clusters[0].files.map((f) => f.path)).toEqual([
      "a.ts",
      "m.ts",
      "z.ts",
    ]);
    expect(model.unclustered.map((f) => f.path)).toEqual(["zz.md"]);
  });

  it("keeps ReviewFile objects by reference", () => {
    const a = file("a.ts");
    const model = resolveClusterModel(
      contract([{ label: "A", summary: "s", files: ["a.ts"], patterns: [] }]),
      [a],
    );
    expect(model.clusters[0].files[0]).toBe(a);
  });

  it("matches dotfiles and skips uncompilable patterns", () => {
    const dotfile = file(".config/settings.json");
    const model = resolveClusterModel(
      contract([
        {
          label: "Config",
          summary: "s",
          files: [],
          patterns: ["", "a".repeat(70000), ".config/**"],
        },
      ]),
      [dotfile],
    );
    expect(model.clusters[0].files).toEqual([dotfile]);
  });
});

describe("clusterFilesForKey / clusterBucketForKey", () => {
  const model: ClusterModel = {
    clusters: [
      { label: "First", summary: "one", files: [file("a.ts")] },
      { label: "Second", summary: "two", files: [file("b.ts"), file("c.ts")] },
    ],
    unclustered: [file("u.ts")],
    auto: [file("yarn.lock", "auto")],
  };

  it("resolves index-based keys to their bucket's files", () => {
    expect(clusterFilesForKey(model, "c0").map((f) => f.path)).toEqual([
      "a.ts",
    ]);
    expect(clusterFilesForKey(model, "c1").map((f) => f.path)).toEqual([
      "b.ts",
      "c.ts",
    ]);
  });

  it("resolves the synthetic unclustered and auto keys", () => {
    expect(clusterFilesForKey(model, "unclustered").map((f) => f.path)).toEqual(
      ["u.ts"],
    );
    expect(clusterFilesForKey(model, "auto").map((f) => f.path)).toEqual([
      "yarn.lock",
    ]);
  });

  it("returns empty for out-of-range and malformed keys", () => {
    expect(clusterFilesForKey(model, "c9")).toEqual([]);
    expect(clusterFilesForKey(model, "c-1")).toEqual([]);
    expect(clusterFilesForKey(model, "cx")).toEqual([]);
    expect(clusterFilesForKey(model, "")).toEqual([]);
  });

  it("returns the bucket only for real-cluster keys", () => {
    expect(clusterBucketForKey(model, "c1")?.label).toBe("Second");
    expect(clusterBucketForKey(model, "unclustered")).toBeUndefined();
    expect(clusterBucketForKey(model, "auto")).toBeUndefined();
    expect(clusterBucketForKey(model, "c9")).toBeUndefined();
  });
});

describe("filterByStatus", () => {
  it("returns only needs-review files, preserving order", () => {
    const a = file("a.ts");
    const c = file("c.ts");
    const mixed = [a, reviewedFile("b.ts"), c, reviewedFile("d.ts")];
    expect(filterByStatus(mixed, FileReviewStatus.NeedsReview)).toEqual([a, c]);
  });

  it("returns only reviewed files, preserving order", () => {
    const b = reviewedFile("b.ts");
    const d = reviewedFile("d.ts");
    const mixed = [file("a.ts"), b, file("c.ts"), d];
    expect(filterByStatus(mixed, FileReviewStatus.Reviewed)).toEqual([b, d]);
  });

  it("returns empty for empty input", () => {
    expect(filterByStatus([], FileReviewStatus.NeedsReview)).toEqual([]);
    expect(filterByStatus([], FileReviewStatus.Reviewed)).toEqual([]);
  });

  it("returns a new array keeping ReviewFile objects by reference", () => {
    const a = file("a.ts");
    const input = [a];
    const result = filterByStatus(input, FileReviewStatus.NeedsReview);
    expect(result).not.toBe(input);
    expect(result[0]).toBe(a);
  });
});

describe("clusterBodyState", () => {
  it("is no-files for an empty list", () => {
    expect(clusterBodyState([])).toBe("no-files");
  });

  it("is all-reviewed when every file is reviewed", () => {
    expect(clusterBodyState([reviewedFile("a.ts"), reviewedFile("b.ts")])).toBe(
      "all-reviewed",
    );
  });

  it("is has-needs-review for a mixed list", () => {
    expect(clusterBodyState([reviewedFile("a.ts"), file("b.ts")])).toBe(
      "has-needs-review",
    );
  });

  it("is has-needs-review when every file needs review", () => {
    expect(clusterBodyState([file("a.ts"), file("b.ts")])).toBe(
      "has-needs-review",
    );
  });
});

describe("clusterContextValue", () => {
  it("is clusterEmpty for no files", () => {
    expect(clusterContextValue([])).toBe("clusterEmpty");
  });

  it("is clusterNeedsReview when a needs-review bucket holds no snapshot", () => {
    expect(clusterContextValue([file("a.ts"), file("b.ts")])).toBe(
      "clusterNeedsReview",
    );
    expect(clusterContextValue([file("b.ts")])).toBe("clusterNeedsReview");
  });

  it("is clusterNeedsReviewSnapshot when a needs-review bucket holds one", () => {
    expect(clusterContextValue([reviewedFile("a.ts"), file("b.ts")])).toBe(
      "clusterNeedsReviewSnapshot",
    );
    expect(
      clusterContextValue([
        file("a.ts"),
        { ...file("b.ts"), hasReviewSnapshot: true },
      ]),
    ).toBe("clusterNeedsReviewSnapshot");
  });

  it("is clusterReviewed when every file is reviewed", () => {
    expect(
      clusterContextValue([reviewedFile("a.ts"), reviewedFile("b.ts")]),
    ).toBe("clusterReviewed");
  });
});

describe("clusterCountDescription", () => {
  it("always shows reviewed/total for clusters and Unclustered", () => {
    expect(clusterCountDescription([file("a.ts"), file("b.ts")], false)).toBe(
      "0/2",
    );
    expect(
      clusterCountDescription([reviewedFile("a.ts"), file("b.ts")], false),
    ).toBe("1/2");
    expect(clusterCountDescription([], false)).toBe("0/0");
  });

  it("shows a plain total for Auto until the first file is reviewed", () => {
    expect(
      clusterCountDescription(
        [file("a.lock", "auto"), file("b.lock", "auto")],
        true,
      ),
    ).toBe("2");
  });

  it("switches Auto to reviewed/total from the first reviewed file on", () => {
    expect(
      clusterCountDescription(
        [reviewedFile("a.lock", "auto"), file("b.lock", "auto")],
        true,
      ),
    ).toBe("1/2");
    expect(
      clusterCountDescription(
        [reviewedFile("a.lock", "auto"), reviewedFile("b.lock", "auto")],
        true,
      ),
    ).toBe("2/2");
  });
});

describe("loadClustersContract", () => {
  let repoRoot: string;

  const gitWithCommonDir = (commonDir: string): Git => ({
    repoRoot,
    run: (args) => {
      expect(args).toEqual(["rev-parse", "--git-common-dir"]);
      return Promise.resolve(`${commonDir}\n`);
    },
  });

  const writeContract = async (name: string, text: string): Promise<void> => {
    const dir = join(repoRoot, ".git", "delta-review");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), text);
  };

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "delta-review-clusters-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("returns missing when no contract file exists", async () => {
    expect(
      await loadClustersContract(gitWithCommonDir(".git"), "main"),
    ).toEqual({ state: "missing" });
  });

  it("loads a valid contract, resolving a relative common dir against repoRoot", async () => {
    await writeContract(
      "clusters-feature-x.json",
      JSON.stringify({
        version: 1,
        clusters: [{ label: "A", summary: "s", files: ["a.ts"] }],
      }),
    );
    const result = await loadClustersContract(
      gitWithCommonDir(".git"),
      "feature/x",
    );
    expect(result).toEqual({
      state: "ok",
      contract: contract([
        { label: "A", summary: "s", files: ["a.ts"], patterns: [] },
      ]),
    });
  });

  it("uses an absolute common dir as-is (linked worktree)", async () => {
    await writeContract(
      "clusters-main.json",
      JSON.stringify({ version: 1, clusters: [] }),
    );
    const result = await loadClustersContract(
      gitWithCommonDir(join(repoRoot, ".git")),
      "main",
    );
    expect(result).toEqual({ state: "ok", contract: contract([]) });
  });

  it("returns invalid with the parse error for a bad contract", async () => {
    await writeContract(
      "clusters-main.json",
      JSON.stringify({ version: 4, clusters: [] }),
    );
    const result = await loadClustersContract(gitWithCommonDir(".git"), "main");
    expect(result).toEqual({
      state: "invalid",
      error: "unsupported version 4 (extension supports 1, 2 and 3)",
    });
  });

  it("returns invalid for a non-ENOENT read error", async () => {
    // Make the contract path a directory so readFile fails with EISDIR
    await mkdir(join(repoRoot, ".git", "delta-review", "clusters-main.json"), {
      recursive: true,
    });
    const result = await loadClustersContract(gitWithCommonDir(".git"), "main");
    expect(result.state).toBe("invalid");
  });
});
