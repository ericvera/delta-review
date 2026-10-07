import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LineRange } from "./clusters";
import {
  DeclaredMove,
  findLineAlignedMatch,
  formatLineRanges,
  resolveDeclaredOriginBases,
  sliceCacheKey,
  SliceIo,
  sliceLines,
} from "./originSlice";

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");

const sliceText = (
  content: string,
  ranges: readonly LineRange[],
): string | undefined => sliceLines(bytes(content), ranges)?.toString("utf8");

describe("sliceLines", () => {
  it("returns one range with its terminators intact", () => {
    expect(sliceText("a\nb\nc\nd\n", [[2, 3]])).toBe("b\nc\n");
  });

  it("concatenates several ranges in declared order", () => {
    expect(
      sliceText("a\nb\nc\nd\ne\n", [
        [1, 1],
        [4, 5],
      ]),
    ).toBe("a\nd\ne\n");
  });

  it("preserves CRLF terminators", () => {
    expect(sliceText("a\r\nb\r\nc\r\n", [[1, 2]])).toBe("a\r\nb\r\n");
  });

  it("preserves a final line that has no newline", () => {
    expect(sliceText("a\nb\nc", [[2, 3]])).toBe("b\nc");
  });

  it("takes a range ending exactly on the last line", () => {
    expect(sliceText("a\nb\nc\n", [[1, 3]])).toBe("a\nb\nc\n");
  });

  it("reports a range reaching past the last line as out of range", () => {
    expect(sliceText("a\nb\nc\n", [[2, 4]])).toBeUndefined();
  });

  it("does not count the empty segment after a trailing newline as a line", () => {
    expect(sliceText("a\nb\n", [[3, 3]])).toBeUndefined();
  });

  it("rejects the whole declaration when a later range is out of range", () => {
    expect(
      sliceText("a\nb\nc\n", [
        [1, 1],
        [3, 5],
      ]),
    ).toBeUndefined();
  });

  it("rejects a range starting below the first line", () => {
    expect(sliceText("a\nb\n", [[0, 1]])).toBeUndefined();
  });

  it("treats every range over empty content as out of range", () => {
    expect(sliceText("", [[1, 1]])).toBeUndefined();
  });
});

describe("findLineAlignedMatch", () => {
  const origin = "alpha\nbeta\ngamma\nbeta\ndelta";

  const match = (needle: string): LineRange | undefined =>
    findLineAlignedMatch(bytes(origin), bytes(needle));

  it("never matches an empty needle", () => {
    expect(match("")).toBeUndefined();
  });

  it("matches at the start of the content", () => {
    expect(match("alpha\n")).toEqual([1, 1]);
  });

  it("matches whole lines in the middle", () => {
    expect(match("beta\ngamma\n")).toEqual([2, 3]);
  });

  it("returns the first of two matches", () => {
    expect(match("beta\n")).toEqual([2, 2]);
  });

  it("matches an unterminated needle only at the end of the content", () => {
    expect(match("delta")).toEqual([5, 5]);
    expect(match("beta")).toBeUndefined();
  });

  it("rejects a match that starts mid-line", () => {
    expect(match("mma\n")).toBeUndefined();
  });

  it("keeps searching past a hit that starts mid-line", () => {
    expect(
      findLineAlignedMatch(bytes("xbeta\nbeta\n"), bytes("beta\n")),
    ).toEqual([2, 2]);
  });

  it("keeps searching past an unterminated hit short of the end", () => {
    expect(findLineAlignedMatch(bytes("beta\nbeta"), bytes("beta"))).toEqual([
      2, 2,
    ]);
  });

  it("returns undefined when the needle is absent", () => {
    expect(match("omega\n")).toBeUndefined();
  });

  it("spans to the last line when the needle runs to the end unterminated", () => {
    expect(match("beta\ndelta")).toEqual([4, 5]);
  });
});

describe("formatLineRanges", () => {
  const ranges: LineRange[] = [
    [12, 40],
    [55, 55],
  ];

  it("prints a single-line range as one number", () => {
    expect(formatLineRanges([[7, 7]], "prose")).toBe("7");
  });

  it("shows only the first range with an ellipsis in a row", () => {
    expect(formatLineRanges(ranges, "row")).toBe("12-40…");
  });

  it("shows a lone range in a row without an ellipsis", () => {
    expect(formatLineRanges([[12, 40]], "row")).toBe("12-40");
  });

  it("packs ranges for a title", () => {
    expect(formatLineRanges(ranges, "title")).toBe("12-40,55");
  });

  it("spaces ranges for prose", () => {
    expect(formatLineRanges(ranges, "prose")).toBe("12-40, 55");
  });
});

describe("sliceCacheKey", () => {
  it("combines the origin blob sha with the declared ranges", () => {
    expect(
      sliceCacheKey("abc123", [
        [1, 2],
        [9, 9],
      ]),
    ).toBe("abc123:1-2,9");
  });

  it("differs when the origin blob changes", () => {
    const ranges: LineRange[] = [[1, 2]];
    expect(sliceCacheKey("abc123", ranges)).not.toBe(
      sliceCacheKey("def456", ranges),
    );
  });
});

// The fake stands in for the object database: a content-addressed store whose
// ids are sha-1 of the bytes, like git's without the header.
const fakeSha = (content: Buffer): string =>
  createHash("sha1").update(content).digest("hex");

interface FakeIo extends SliceIo {
  reads: string[];
  writes: Buffer[];
}

const createFakeIo = (store: Map<string, Buffer>): FakeIo => {
  const reads: string[] = [];
  const writes: Buffer[] = [];
  return {
    reads,
    writes,
    readBlob: (sha) => {
      reads.push(sha);
      const content = store.get(sha);
      return content === undefined
        ? Promise.reject(new Error(`missing object ${sha}`))
        : Promise.resolve(content);
    },
    writeBlob: (content) => {
      writes.push(content);
      const sha = fakeSha(content);
      store.set(sha, content);
      return Promise.resolve(sha);
    },
    blobExists: (sha) => Promise.resolve(store.has(sha)),
  };
};

const put = (store: Map<string, Buffer>, text: string): string => {
  const content = bytes(text);
  const sha = fakeSha(content);
  store.set(sha, content);
  return sha;
};

const repoMove = (fields: Partial<DeclaredMove> = {}): DeclaredMove => ({
  from: "src/old.ts",
  origin: "repo",
  baseBlob: undefined,
  fromLines: undefined,
  ...fields,
});

describe("resolveDeclaredOriginBases", () => {
  const originText = "a\nb\nc\nd\n";
  const UNKNOWN_SHA = "0".repeat(40);

  // One origin file at the merge base, plus everything a test needs to name
  // its content by sha
  const setup = (): {
    store: Map<string, Buffer>;
    io: FakeIo;
    mergeBaseBlobs: Map<string, string>;
    originSha: string;
  } => {
    const store = new Map<string, Buffer>();
    const originSha = put(store, originText);
    return {
      store,
      io: createFakeIo(store),
      mergeBaseBlobs: new Map([["src/old.ts", originSha]]),
      originSha,
    };
  };

  const resolve = (
    io: SliceIo,
    move: DeclaredMove,
    mergeBaseBlobs: ReadonlyMap<string, string>,
    cache = new Map<string, string>(),
  ) =>
    resolveDeclaredOriginBases(
      io,
      new Map([["src/new.ts", move]]),
      mergeBaseBlobs,
      cache,
    );

  it("uses the slice when no base blob is declared", async () => {
    const { io, mergeBaseBlobs } = setup();
    const { bases, sliceShas } = await resolve(
      io,
      repoMove({ fromLines: [[2, 3]] }),
      mergeBaseBlobs,
    );
    const sliceSha = fakeSha(bytes("b\nc\n"));
    expect(bases.get("src/new.ts")).toEqual({
      sha: sliceSha,
      lines: [[2, 3]],
      linesOutOfRange: false,
    });
    expect(sliceShas).toEqual([sliceSha]);
  });

  it("uses the slice when it equals the declared base blob", async () => {
    const { store, io, mergeBaseBlobs } = setup();
    const baseBlob = put(store, "b\nc\n");
    const { bases } = await resolve(
      io,
      repoMove({ fromLines: [[2, 3]], baseBlob }),
      mergeBaseBlobs,
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: baseBlob,
      lines: [[2, 3]],
      linesOutOfRange: false,
    });
  });

  it("relocates to where a differing base blob now sits in the origin", async () => {
    const { store, io, mergeBaseBlobs } = setup();
    const baseBlob = put(store, "c\nd\n");
    const { bases, sliceShas } = await resolve(
      io,
      repoMove({ fromLines: [[1, 2]], baseBlob }),
      mergeBaseBlobs,
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: baseBlob,
      lines: [[3, 4]],
      linesOutOfRange: false,
    });
    expect(sliceShas).toEqual([fakeSha(bytes("a\nb\n"))]);
  });

  it("keeps the declared lines when the declared block repeats earlier in the origin", async () => {
    const store = new Map<string, Buffer>();
    const originSha = put(store, "x\ny\nz\nx\ny\n");
    const baseBlob = put(store, "x\ny\n");
    const io = createFakeIo(store);
    const { bases } = await resolve(
      io,
      repoMove({
        fromLines: [[4, 5]],
        baseBlob,
      }),
      new Map([["src/old.ts", originSha]]),
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: baseBlob,
      lines: [[4, 5]],
      linesOutOfRange: false,
    });
    expect(io.reads).toEqual([originSha]);
  });

  it("reads the origin to relocate a differing blob after a cache hit", async () => {
    const { store, io, mergeBaseBlobs, originSha } = setup();
    const baseBlob = put(store, "c\nd\n");
    const cached = "cached-slice-sha";
    const cache = new Map([[sliceCacheKey(originSha, [[1, 2]]), cached]]);
    const { bases, sliceShas } = await resolve(
      io,
      repoMove({ fromLines: [[1, 2]], baseBlob }),
      mergeBaseBlobs,
      cache,
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: baseBlob,
      lines: [[3, 4]],
      linesOutOfRange: false,
    });
    expect(sliceShas).toEqual([cached]);
    expect(io.reads).toEqual([originSha, baseBlob]);
    expect(io.writes).toEqual([]);
  });

  it("keeps a differing base blob with no lines when the origin lost it", async () => {
    const { store, io, mergeBaseBlobs } = setup();
    const baseBlob = put(store, "gone\n");
    const { bases } = await resolve(
      io,
      repoMove({ fromLines: [[1, 2]], baseBlob }),
      mergeBaseBlobs,
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: baseBlob,
      lines: undefined,
      linesOutOfRange: false,
    });
  });

  it("treats an unreadable base blob as undeclared", async () => {
    const { io, mergeBaseBlobs } = setup();
    const { bases } = await resolve(
      io,
      repoMove({ fromLines: [[2, 3]], baseBlob: UNKNOWN_SHA }),
      mergeBaseBlobs,
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: fakeSha(bytes("b\nc\n")),
      lines: [[2, 3]],
      linesOutOfRange: false,
    });
  });

  it("relocates out-of-range lines through a readable base blob", async () => {
    const { store, io, mergeBaseBlobs } = setup();
    const baseBlob = put(store, "c\nd\n");
    const { bases, sliceShas } = await resolve(
      io,
      repoMove({ fromLines: [[9, 10]], baseBlob }),
      mergeBaseBlobs,
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: baseBlob,
      lines: [[3, 4]],
      linesOutOfRange: false,
    });
    expect(sliceShas).toEqual([]);
  });

  it("falls back to the whole origin when lines are out of range with no blob", async () => {
    const { io, mergeBaseBlobs, originSha } = setup();
    const { bases } = await resolve(
      io,
      repoMove({ fromLines: [[9, 10]] }),
      mergeBaseBlobs,
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: originSha,
      lines: undefined,
      linesOutOfRange: true,
    });
  });

  it("uses the base blob alone when the origin is absent at the merge base", async () => {
    const { store, io } = setup();
    const baseBlob = put(store, "c\nd\n");
    const { bases } = await resolve(
      io,
      repoMove({ fromLines: [[1, 2]], baseBlob }),
      new Map(),
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: baseBlob,
      lines: undefined,
      linesOutOfRange: false,
    });
  });

  it("resolves nothing when the origin is absent and no blob is declared", async () => {
    const { io } = setup();
    const { bases } = await resolve(
      io,
      repoMove({ fromLines: [[1, 2]] }),
      new Map(),
    );
    expect(bases.has("src/new.ts")).toBe(false);
  });

  it("uses a base blob declared without lines whether or not the origin exists", async () => {
    const { store, io, mergeBaseBlobs } = setup();
    const baseBlob = put(store, "whatever\n");
    const expected = {
      sha: baseBlob,
      lines: undefined,
      linesOutOfRange: false,
    };
    const present = await resolve(io, repoMove({ baseBlob }), mergeBaseBlobs);
    expect(present.bases.get("src/new.ts")).toEqual(expected);
    const absent = await resolve(io, repoMove({ baseBlob }), new Map());
    expect(absent.bases.get("src/new.ts")).toEqual(expected);
  });

  it("resolves nothing for a repo move with neither lines nor a blob", async () => {
    const { io, mergeBaseBlobs } = setup();
    const { bases } = await resolve(io, repoMove(), mergeBaseBlobs);
    expect(bases.has("src/new.ts")).toBe(false);
  });

  it("resolves an external move to its readable base blob", async () => {
    const { store, io } = setup();
    const baseBlob = put(store, "donor\n");
    const { bases } = await resolve(
      io,
      repoMove({ origin: "external", from: "../donor/x.ts", baseBlob }),
      new Map(),
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: baseBlob,
      lines: undefined,
      linesOutOfRange: false,
    });
  });

  it("drops an external move whose base blob is unreadable", async () => {
    const { io } = setup();
    const { bases } = await resolve(
      io,
      repoMove({
        origin: "external",
        from: "../donor/x.ts",
        baseBlob: UNKNOWN_SHA,
      }),
      new Map(),
    );
    expect(bases.has("src/new.ts")).toBe(false);
  });

  it("populates the cache on a miss and writes the slice once", async () => {
    const { io, mergeBaseBlobs, originSha } = setup();
    const cache = new Map<string, string>();
    await resolve(io, repoMove({ fromLines: [[2, 3]] }), mergeBaseBlobs, cache);
    expect(io.writes).toHaveLength(1);
    expect(cache.get(sliceCacheKey(originSha, [[2, 3]]))).toBe(
      fakeSha(bytes("b\nc\n")),
    );
  });

  it("reuses a cached slice without reading or hashing the origin", async () => {
    const { io, mergeBaseBlobs, originSha } = setup();
    const cached = "cached-slice-sha";
    const cache = new Map([[sliceCacheKey(originSha, [[2, 3]]), cached]]);
    const { bases, sliceShas } = await resolve(
      io,
      repoMove({ fromLines: [[2, 3]] }),
      mergeBaseBlobs,
      cache,
    );
    expect(bases.get("src/new.ts")).toEqual({
      sha: cached,
      lines: [[2, 3]],
      linesOutOfRange: false,
    });
    expect(sliceShas).toEqual([cached]);
    expect(io.reads).toEqual([]);
    expect(io.writes).toEqual([]);
  });

  it("lists reused and newly written slices together", async () => {
    const store = new Map<string, Buffer>();
    const firstOrigin = put(store, originText);
    const secondOrigin = put(store, "x\ny\nz\n");
    const io = createFakeIo(store);
    const cached = "cached-slice-sha";
    const cache = new Map([[sliceCacheKey(firstOrigin, [[2, 3]]), cached]]);
    const { sliceShas } = await resolveDeclaredOriginBases(
      io,
      new Map([
        ["src/new.ts", repoMove({ fromLines: [[2, 3]] })],
        [
          "src/other.ts",
          repoMove({ from: "src/second.ts", fromLines: [[1, 2]] }),
        ],
      ]),
      new Map([
        ["src/old.ts", firstOrigin],
        ["src/second.ts", secondOrigin],
      ]),
      cache,
    );
    expect(sliceShas).toEqual([cached, fakeSha(bytes("x\ny\n"))]);
  });

  it("leaves other moves resolved when one move's objects are unreadable", async () => {
    const { io, originSha } = setup();
    const { bases } = await resolveDeclaredOriginBases(
      io,
      new Map([
        [
          "src/broken.ts",
          repoMove({ from: "src/pruned.ts", fromLines: [[1, 1]] }),
        ],
        ["src/new.ts", repoMove({ fromLines: [[2, 3]] })],
      ]),
      new Map([
        ["src/pruned.ts", UNKNOWN_SHA],
        ["src/old.ts", originSha],
      ]),
      new Map(),
    );
    expect(bases.has("src/broken.ts")).toBe(false);
    expect(bases.get("src/new.ts")?.sha).toBe(fakeSha(bytes("b\nc\n")));
  });
});
