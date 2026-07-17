import { execFile } from "node:child_process";

export interface Git {
  repoRoot: string;
  run: (
    args: string[],
    options?: { stdin?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<string>;
}

// Runs git with the given arguments in the repo root and resolves with stdout.
// Rejections carry git's stderr in the error message.
export const createGit = (repoRoot: string): Git => ({
  repoRoot,
  run: (args, options) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        args,
        {
          cwd: repoRoot,
          maxBuffer: 256 * 1024 * 1024,
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
    }),
});

export const splitNulTerminated = (output: string): string[] =>
  output.split("\0").filter((entry) => entry !== "");

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
