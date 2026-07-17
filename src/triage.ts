import picomatch from "picomatch";

export type Triage = "auto" | "normal";

// Classifies review-set paths as "auto" (mechanical, e.g. lockfiles or build
// output) or "normal" from exactly two inputs: user-configured glob patterns
// and the set of paths marked linguist-generated in .gitattributes. Paths are
// repo-relative with "/" separators; matching is case-sensitive.
export const computeTriage = (
  paths: string[],
  globs: readonly unknown[],
  generatedPaths: ReadonlySet<string>,
): Map<string, Triage> => {
  // Precompile matchers once — this runs per refresh over the whole review
  // set. The globs come from a user-typed setting, so entries may be empty,
  // non-strings, or patterns picomatch rejects (it throws on all three);
  // skip bad entries so one never breaks classification for the whole set.
  const matchers: ((path: string) => boolean)[] = [];
  for (const glob of globs) {
    if (typeof glob !== "string" || glob === "") {
      continue;
    }
    try {
      matchers.push(picomatch(glob, { dot: true }));
    } catch {
      // Invalid pattern (e.g. mid-edit in settings) — ignore it
    }
  }
  const triage = new Map<string, Triage>();
  for (const path of paths) {
    const isAuto =
      generatedPaths.has(path) || matchers.some((matches) => matches(path));
    triage.set(path, isAuto ? "auto" : "normal");
  }
  return triage;
};
