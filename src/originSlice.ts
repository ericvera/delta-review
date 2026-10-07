import type { LineRange } from "./clusters";
import { readBlobBytes, writeBlobBytes, type Git } from "./git";

export type { LineRange };

const NEWLINE = 0x0a;

// Byte bounds [start, endExclusive) of every line, each line keeping its own
// terminator. Line counting matches `sed -n`: a trailing newline ends the
// last line rather than starting an empty one, and a final run of bytes
// without a terminator is still a line.
const lineBounds = (bytes: Buffer): [number, number][] => {
  const bounds: [number, number][] = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);
    const end = newline === -1 ? bytes.length : newline + 1;
    bounds.push([start, end]);
    start = end;
  }
  return bounds;
};

const countNewlinesBefore = (bytes: Buffer, end: number): number => {
  let count = 0;
  let index = bytes.indexOf(NEWLINE);
  while (index !== -1 && index < end) {
    count += 1;
    index = bytes.indexOf(NEWLINE, index + 1);
  }
  return count;
};

// Concatenates the given 1-based inclusive line spans in declared order,
// byte for byte. Any span reaching past the last line makes the whole
// declaration out of range (`undefined`): a partial slice would silently
// stand in for content the writer never declared.
export const sliceLines = (
  bytes: Buffer,
  ranges: readonly LineRange[],
): Buffer | undefined => {
  const bounds = lineBounds(bytes);
  const parts: Buffer[] = [];
  for (const [start, end] of ranges) {
    if (start < 1 || end > bounds.length) {
      return undefined;
    }
    parts.push(bytes.subarray(bounds[start - 1][0], bounds[end - 1][1]));
  }
  return Buffer.concat(parts);
};

// Finds where `needle` sits in `origin` as whole lines and returns the 1-based
// inclusive span it covers. The match is byte-exact and must begin at a line
// start; it must also end at a line end, which for a needle without its own
// trailing newline only happens at the very end of the origin. An empty needle
// spans no lines and never matches.
export const findLineAlignedMatch = (
  origin: Buffer,
  needle: Buffer,
): LineRange | undefined => {
  if (needle.length === 0) {
    return undefined;
  }
  const terminated = needle[needle.length - 1] === NEWLINE;
  let from = 0;
  for (;;) {
    const at = origin.indexOf(needle, from);
    if (at === -1) {
      return undefined;
    }
    const startsLine = at === 0 || origin[at - 1] === NEWLINE;
    const endsLine = terminated || at + needle.length === origin.length;
    if (startsLine && endsLine) {
      const startLine = countNewlinesBefore(origin, at) + 1;
      const inner = countNewlinesBefore(needle, needle.length);
      // A trailing newline terminates the needle's last line instead of
      // opening another one
      return [startLine, startLine + inner - (terminated ? 1 : 0)];
    }
    from = at + 1;
  }
};

// Renders line spans for one of the three places they appear. `row` has no
// space for a list, so it shows the first span and an ellipsis standing for
// the rest.
export const formatLineRanges = (
  ranges: readonly LineRange[],
  style: "row" | "title" | "prose",
): string => {
  const parts = ranges.map(([start, end]) =>
    start === end ? `${start}` : `${start}-${end}`,
  );
  if (style === "row") {
    return parts.length > 1 ? `${parts[0]}…` : parts.join("");
  }
  return parts.join(style === "title" ? "," : ", ");
};

// Keyed by the origin's blob sha rather than its path, so a rebase that moves
// the origin's content invalidates the entry on its own.
export const sliceCacheKey = (
  originSha: string,
  ranges: readonly LineRange[],
): string => `${originSha}:${formatLineRanges(ranges, "title")}`;

// The origin-side content a move's diff is taken against.
export interface OriginBase {
  sha: string;
  // Origin lines this base covers, for display; undefined when none resolved
  lines: LineRange[] | undefined;
  // Set when the declared lines did not fit the origin and the whole origin
  // file stood in for them
  linesOutOfRange: boolean;
}

// The object-database access the resolution needs, injected so the resolution
// itself stays testable without a repository.
export interface SliceIo {
  readBlob: (sha: string) => Promise<Buffer>;
  writeBlob: (bytes: Buffer) => Promise<string>;
  blobExists: (sha: string) => Promise<boolean>;
}

export const createSliceIo = (git: Git): SliceIo => ({
  readBlob: (sha) => readBlobBytes(git.repoRoot, sha),
  writeBlob: (bytes) => writeBlobBytes(git.repoRoot, bytes),
  blobExists: async (sha) => {
    try {
      // A 40-hex name can also be a tree or a commit; only a blob is content
      return (await git.run(["cat-file", "-t", sha])).trim() === "blob";
    } catch {
      return false;
    }
  },
});

// The move fields the resolution reads. Declared structurally so this module
// never imports the review model, which imports this one.
export interface DeclaredMove {
  from: string;
  origin: "repo" | "external";
  baseBlob: string | undefined;
  fromLines: readonly LineRange[] | undefined;
}

const resolveMove = async (
  io: SliceIo,
  move: DeclaredMove,
  mergeBaseBlobs: ReadonlyMap<string, string>,
  cache: Map<string, string>,
  sliceShas: string[],
): Promise<OriginBase | undefined> => {
  // A declared blob git cannot read as a blob counts as undeclared throughout
  const declaredBlob =
    move.baseBlob !== undefined && (await io.blobExists(move.baseBlob))
      ? move.baseBlob
      : undefined;
  // Nothing to slice: an external origin has no merge-base content to slice
  // from, and a repo origin without declared lines came from the whole file.
  // A blob is then the entire base — it also rescues a repo move whose origin
  // is gone — and without one the model falls back to the origin's own
  // merge-base blob.
  if (move.origin === "external" || move.fromLines === undefined) {
    return declaredBlob === undefined
      ? undefined
      : { sha: declaredBlob, lines: undefined, linesOutOfRange: false };
  }

  const originSha = mergeBaseBlobs.get(move.from);
  let originBytes: Buffer | undefined;
  let sliceSha: string | undefined;
  if (originSha !== undefined) {
    const key = sliceCacheKey(originSha, move.fromLines);
    sliceSha = cache.get(key);
    if (sliceSha === undefined) {
      originBytes = await io.readBlob(originSha);
      const slice = sliceLines(originBytes, move.fromLines);
      if (slice !== undefined) {
        sliceSha = await io.writeBlob(slice);
        cache.set(key, sliceSha);
      }
    }
    if (sliceSha !== undefined) {
      sliceShas.push(sliceSha);
    }
  }

  if (
    sliceSha !== undefined &&
    (declaredBlob === undefined || sliceSha === declaredBlob)
  ) {
    return {
      sha: sliceSha,
      lines: [...move.fromLines],
      linesOutOfRange: false,
    };
  }
  if (declaredBlob !== undefined) {
    // The declared content no longer sits where the contract says: it is
    // still the base, and the origin is searched for where it moved to
    if (originBytes === undefined && originSha !== undefined) {
      originBytes = await io.readBlob(originSha);
    }
    const needle = await io.readBlob(declaredBlob);
    const match =
      originBytes === undefined
        ? undefined
        : findLineAlignedMatch(originBytes, needle);
    return {
      sha: declaredBlob,
      lines: match === undefined ? undefined : [match],
      linesOutOfRange: false,
    };
  }
  // Lines out of range with nothing declared to fall back on: the whole origin
  // file stands in when it exists
  return originSha === undefined
    ? undefined
    : { sha: originSha, lines: undefined, linesOutOfRange: true };
};

// Resolves the origin base of every declared move, plus the slice object ids
// produced or reused along the way (the caller anchors those so gc keeps
// them). A move whose objects cannot be read is left out rather than failing
// the whole refresh.
export const resolveDeclaredOriginBases = async (
  io: SliceIo,
  movesByPath: ReadonlyMap<string, DeclaredMove>,
  mergeBaseBlobs: ReadonlyMap<string, string>,
  cache: Map<string, string>,
): Promise<{ bases: Map<string, OriginBase>; sliceShas: string[] }> => {
  const bases = new Map<string, OriginBase>();
  const sliceShas: string[] = [];
  for (const [path, move] of movesByPath) {
    try {
      const base = await resolveMove(
        io,
        move,
        mergeBaseBlobs,
        cache,
        sliceShas,
      );
      if (base !== undefined) {
        bases.set(path, base);
      }
    } catch {
      // Unreadable or garbage-collected object — this file degrades to no
      // origin base
    }
  }
  return { bases, sliceShas };
};
