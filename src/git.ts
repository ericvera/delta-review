import { execFile } from "node:child_process";

export interface Git {
  repoRoot: string;
  run: (
    args: string[],
    options?: { stdin?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<string>;
}

// Runs git in `cwd` and resolves with raw stdout. Buffer mode is the shared
// primitive because blob content has no encoding of its own: `run` decodes to
// UTF-8 itself, while the blob helpers must keep every byte. Rejections carry
// git's stderr in the error message.
const runGit = (
  cwd: string,
  args: string[],
  options?: { stdin?: string | Buffer; env?: NodeJS.ProcessEnv },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: 256 * 1024 * 1024,
        encoding: "buffer",
        env: { ...process.env, ...options?.env },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
    if (child.stdin) {
      if (options?.stdin !== undefined) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    }
  });

export const createGit = (repoRoot: string): Git => ({
  repoRoot,
  run: async (args, options) =>
    (await runGit(repoRoot, args, options)).toString("utf8"),
});

// Reads a blob's content as bytes. Callers slice and re-hash this content and
// the resulting object ids must match git's own, which a UTF-8 round-trip
// through a string would not survive.
export const readBlobBytes = (repoRoot: string, sha: string): Promise<Buffer> =>
  runGit(repoRoot, ["cat-file", "blob", sha]);

// Writes bytes into the object database as a loose blob and resolves its id.
export const writeBlobBytes = async (
  repoRoot: string,
  bytes: Buffer,
): Promise<string> =>
  (await runGit(repoRoot, ["hash-object", "-w", "--stdin"], { stdin: bytes }))
    .toString("utf8")
    .trim();

export const splitNulTerminated = (output: string): string[] =>
  output.split("\0").filter((entry) => entry !== "");

// Parses `git diff --name-status --find-renames -z` output. Record formats:
// - Single-path: <STATUS> NUL <path> NUL, where STATUS is one letter
//   (A, M, D, T, U, ...)
// - Two-path: <STATUS><score> NUL <sourcePath> NUL <destinationPath> NUL,
//   where STATUS is R (rename) or C (copy) and score is a 0-padded
//   similarity like 100 or 087
// Returns every path that should appear in the review set (single-path
// record paths plus rename/copy destinations; rename sources are excluded)
// and a destination -> source map for renames only. Copy destinations are
// not treated as moves because the source file still exists.
export const parseNameStatusOutput = (
  output: string,
): { paths: string[]; movedFrom: Map<string, string> } => {
  const fields = splitNulTerminated(output);
  const paths: string[] = [];
  const movedFrom = new Map<string, string>();
  let index = 0;
  while (index < fields.length) {
    const status = fields[index][0];
    if (status === "R" || status === "C") {
      const source = fields[index + 1];
      const destination = fields[index + 2];
      if (source === undefined || destination === undefined) {
        break;
      }
      paths.push(destination);
      if (status === "R") {
        movedFrom.set(destination, source);
      }
      index += 3;
    } else {
      const path = fields[index + 1];
      if (path === undefined) {
        break;
      }
      paths.push(path);
      index += 2;
    }
  }
  return { paths, movedFrom };
};

// Parses `git ls-tree -r -z` output into a map of path -> blob sha
export const parseLsTreeOutput = (output: string): Map<string, string> => {
  const blobs = new Map<string, string>();
  for (const entry of splitNulTerminated(output)) {
    const tabIndex = entry.indexOf("\t");
    if (tabIndex === -1) {
      continue;
    }
    // Entry format: <mode> SP <type> SP <sha> TAB <path>
    const sha = entry.slice(0, tabIndex).split(" ")[2];
    const path = entry.slice(tabIndex + 1);
    if (sha !== undefined) {
      blobs.set(path, sha);
    }
  }
  return blobs;
};
