import picomatch from "picomatch";

export type Triage = "auto" | "normal";

// Classifies review-set paths as "auto" (mechanical, e.g. lockfiles or build
// output) or "normal" from exactly two inputs: user-configured glob patterns
// and the set of paths marked linguist-generated in .gitattributes. Paths are
// repo-relative with "/" separators; matching is case-sensitive.
export const computeTriage = (
  paths: string[],
  globs: string[],
  generatedPaths: ReadonlySet<string>,
): Map<string, Triage> => {
  // Precompile matchers once — this runs per refresh over the whole review set
  const matchers = globs.map((glob) => picomatch(glob, { dot: true }));
  const triage = new Map<string, Triage>();
  for (const path of paths) {
    const isAuto =
      generatedPaths.has(path) || matchers.some((matches) => matches(path));
    triage.set(path, isAuto ? "auto" : "normal");
  }
  return triage;
};
