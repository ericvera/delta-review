import { describe, expect, it } from "vitest";
import type { BaseResolution } from "./diffBase";
import { baseStatusPresentation, mergeBaseErrorMessage } from "./diffBaseUi";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const resolution = (overrides: Partial<BaseResolution>): BaseResolution => ({
  branch: "feat/b",
  base: "main",
  source: "fallback",
  fallback: "main",
  missing: false,
  stale: false,
  suggestions: { fallback: "main" },
  ...overrides,
});

describe("baseStatusPresentation", () => {
  it("names an explicit base as set for the branch", () => {
    expect(
      baseStatusPresentation(
        resolution({ source: "explicit", base: "feat/a" }),
        SHA,
      ),
    ).toEqual({
      text: "$(git-compare) ← feat/a",
      tooltip: [
        "Delta Review base: feat/a",
        "Set for branch feat/b (all worktrees on this branch).",
        "Merge-base a1b2c3d",
        "Click to change the base.",
      ].join("\n"),
      tint: "none",
    });
  });

  it("names a detected fork point", () => {
    expect(
      baseStatusPresentation(
        resolution({
          source: "detected",
          detectedVia: "forkPoint",
          base: "feat/a",
        }),
        SHA,
      ),
    ).toEqual({
      text: "$(git-compare) ← feat/a",
      tooltip: [
        "Delta Review base: feat/a (auto-detected)",
        "Closest local branch this branch forked from.",
        "Merge-base a1b2c3d",
        "Click to pin a base for this branch.",
      ].join("\n"),
      tint: "none",
    });
  });

  it("names a detected upstream", () => {
    expect(
      baseStatusPresentation(
        resolution({
          source: "detected",
          detectedVia: "upstream",
          base: "origin/main",
        }),
        SHA,
      ).tooltip,
    ).toBe(
      [
        "Delta Review base: origin/main (auto-detected)",
        "Upstream of this branch (origin/main).",
        "Merge-base a1b2c3d",
        "Click to pin a base for this branch.",
      ].join("\n"),
    );
  });

  it("names the fallback setting", () => {
    expect(baseStatusPresentation(resolution({}), SHA)).toEqual({
      text: "$(git-compare) ← main",
      tooltip: [
        "Delta Review base: main (default)",
        "From setting deltaReview.baseBranch.",
        "Merge-base a1b2c3d",
        "Click to pin a base for this branch.",
      ].join("\n"),
      tint: "none",
    });
  });

  it("omits the merge-base line when none is known", () => {
    expect(baseStatusPresentation(resolution({}), undefined).tooltip).toBe(
      [
        "Delta Review base: main (default)",
        "From setting deltaReview.baseBranch.",
        "Click to pin a base for this branch.",
      ].join("\n"),
    );
  });

  it("shows a missing base as an error", () => {
    expect(
      baseStatusPresentation(
        resolution({ source: "explicit", base: "nope", missing: true }),
        undefined,
      ),
    ).toEqual({
      text: "$(warning) ← nope",
      tooltip: "Base nope not found. Click to choose a base.",
      tint: "error",
    });
  });

  it("shows a failed merge-base as an error", () => {
    expect(
      baseStatusPresentation(
        resolution({ source: "explicit", base: "lonely" }),
        undefined,
        { mergeBaseFailed: true },
      ),
    ).toEqual({
      text: "$(warning) ← lonely",
      tooltip: "No merge-base between lonely and HEAD. Click to choose a base.",
      tint: "error",
    });
  });

  it("appends an ignored base file's error", () => {
    expect(
      baseStatusPresentation(
        resolution({ fileError: "version must be 1" }),
        SHA,
      ).tooltip,
    ).toBe(
      [
        "Delta Review base: main (default)",
        "From setting deltaReview.baseBranch.",
        "Merge-base a1b2c3d",
        "Click to pin a base for this branch.",
        "Base file ignored: version must be 1",
      ].join("\n"),
    );
  });
});

describe("mergeBaseErrorMessage", () => {
  it("points a fallback base at the setting", () => {
    const message = mergeBaseErrorMessage(resolution({}));
    expect(message).toBe(
      '⚠ Cannot compute merge-base with "main". Check the deltaReview.baseBranch setting or click the base in the status bar to choose one.',
    );
  });

  it.each(["explicit", "detected"] as const)(
    "points a %s base only at the status bar",
    (source) => {
      const message = mergeBaseErrorMessage(
        resolution({ source, base: "feat/a" }),
      );
      expect(message).toBe(
        '⚠ Cannot compute merge-base with "feat/a". Click the base in the status bar to choose another.',
      );
      expect(message).not.toContain("deltaReview.baseBranch");
    },
  );
});
