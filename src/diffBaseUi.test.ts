import { describe, expect, it } from "vitest";
import type { BaseResolution } from "./diffBase";
import {
  basePickerEntries,
  baseStatusPresentation,
  mergeBaseErrorMessage,
} from "./diffBaseUi";

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

describe("basePickerEntries", () => {
  const refs = (entries: ReturnType<typeof basePickerEntries>): string[] =>
    entries.flatMap((entry) => (entry.kind === "ref" ? [entry.ref] : []));

  it("lists each ref once, in its first section", () => {
    const entries = basePickerEntries(
      resolution({
        source: "detected",
        base: "feat/a",
        suggestions: {
          forkPoint: "feat/a",
          upstream: "main",
          fallback: "main",
        },
      }),
      ["main", "feat/a", "develop"],
    );
    expect(entries).toEqual([
      { kind: "separator", label: "suggested" },
      {
        kind: "ref",
        ref: "feat/a",
        label: "$(check) $(git-compare) feat/a",
        description: "auto-detected · forked from current",
        current: true,
      },
      {
        kind: "ref",
        ref: "main",
        label: "$(cloud) main",
        description: "upstream",
        current: false,
      },
      { kind: "separator", label: "local branches" },
      {
        kind: "ref",
        ref: "develop",
        label: "$(git-branch) develop",
        description: undefined,
        current: false,
      },
      { kind: "separator", label: "" },
      { kind: "enterRef" },
    ]);
  });

  it("checks only the current base", () => {
    const entries = basePickerEntries(
      resolution({ source: "explicit", base: "develop" }),
      ["develop", "other"],
    );
    expect(
      entries.flatMap((entry) =>
        entry.kind === "ref" && entry.current ? [entry.label] : [],
      ),
    ).toEqual(["$(check) $(git-branch) develop"]);
  });

  it("offers automatic detection only for an explicit base", () => {
    const automatic = (source: BaseResolution["source"]): boolean =>
      basePickerEntries(resolution({ source }), []).some(
        (entry) => entry.kind === "automatic",
      );
    expect(automatic("explicit")).toBe(true);
    expect(automatic("detected")).toBe(false);
    expect(automatic("fallback")).toBe(false);
  });

  it("moves preferFirst to the top of suggested", () => {
    const entries = basePickerEntries(
      resolution({
        suggestions: {
          forkPoint: "feat/a",
          upstream: "origin/x",
          fallback: "main",
        },
      }),
      [],
      { preferFirst: "main" },
    );
    expect(entries[0]).toEqual({ kind: "separator", label: "suggested" });
    expect(refs(entries)).toEqual(["main", "feat/a", "origin/x"]);
  });

  it("excludes the current branch from local branches", () => {
    expect(
      refs(basePickerEntries(resolution({}), ["feat/b", "main", "develop"])),
    ).toEqual(["main", "develop"]);
  });
});
