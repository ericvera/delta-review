import { describe, expect, it } from "vitest";
import { computeTriage } from "./triage";

const noGenerated = new Set<string>();

describe("computeTriage", () => {
  it("marks glob matches auto and everything else normal", () => {
    const triage = computeTriage(
      ["yarn.lock", "src/index.ts"],
      ["**/*.lock"],
      noGenerated,
    );
    expect(triage.get("yarn.lock")).toBe("auto");
    expect(triage.get("src/index.ts")).toBe("normal");
  });

  it("matches ** recursively, including nested and top-level paths", () => {
    const triage = computeTriage(
      ["dist/app.js", "dist/deep/nested/chunk.js", "src/dist.ts"],
      ["dist/**"],
      noGenerated,
    );
    expect(triage.get("dist/app.js")).toBe("auto");
    expect(triage.get("dist/deep/nested/chunk.js")).toBe("auto");
    expect(triage.get("src/dist.ts")).toBe("normal");
  });

  it("marks linguist-generated paths auto even with no globs configured", () => {
    const triage = computeTriage(
      ["gen/api.ts", "src/api.ts"],
      [],
      new Set(["gen/api.ts"]),
    );
    expect(triage.get("gen/api.ts")).toBe("auto");
    expect(triage.get("src/api.ts")).toBe("normal");
  });

  it("classifies every path normal when both inputs are empty", () => {
    const triage = computeTriage(
      ["a.ts", "b/c.lock", ".pnp.cjs"],
      [],
      noGenerated,
    );
    expect([...triage.values()]).toEqual(["normal", "normal", "normal"]);
  });

  it("combines globs and generated paths", () => {
    const triage = computeTriage(
      ["yarn.lock", "gen/api.ts", "src/main.ts"],
      ["**/*.lock"],
      new Set(["gen/api.ts"]),
    );
    expect(triage.get("yarn.lock")).toBe("auto");
    expect(triage.get("gen/api.ts")).toBe("auto");
    expect(triage.get("src/main.ts")).toBe("normal");
  });

  it("matches dotfiles", () => {
    const triage = computeTriage(
      [".pnp.cjs", ".yarn/cache/pkg.zip"],
      ["**/*.cjs", ".yarn/**"],
      noGenerated,
    );
    expect(triage.get(".pnp.cjs")).toBe("auto");
    expect(triage.get(".yarn/cache/pkg.zip")).toBe("auto");
  });

  it("matches case-sensitively", () => {
    const triage = computeTriage(
      ["yarn.lock", "YARN.LOCK"],
      ["**/*.lock"],
      noGenerated,
    );
    expect(triage.get("yarn.lock")).toBe("auto");
    expect(triage.get("YARN.LOCK")).toBe("normal");
  });

  it("classifies deleted paths like any other path string", () => {
    // Triage has no notion of deletion — a deleted lockfile's path still matches
    const triage = computeTriage(
      ["package-lock.json"],
      ["**/*.json"],
      noGenerated,
    );
    expect(triage.get("package-lock.json")).toBe("auto");
  });

  it("is independent of pattern list order", () => {
    const paths = ["yarn.lock", "dist/app.js", "src/main.ts"];
    const forward = computeTriage(paths, ["**/*.lock", "dist/**"], noGenerated);
    const reversed = computeTriage(
      paths,
      ["dist/**", "**/*.lock"],
      noGenerated,
    );
    expect([...forward.entries()]).toEqual([...reversed.entries()]);
  });

  it("returns an entry for every input path", () => {
    const paths = ["a", "b", "c"];
    const triage = computeTriage(paths, ["b"], noGenerated);
    expect([...triage.keys()]).toEqual(paths);
  });

  it("ignores empty-string globs without throwing", () => {
    // A mid-edit settings value like [""] must not blank the review model
    const triage = computeTriage(
      ["yarn.lock", "src/main.ts"],
      ["", "**/*.lock"],
      noGenerated,
    );
    expect(triage.get("yarn.lock")).toBe("auto");
    expect(triage.get("src/main.ts")).toBe("normal");
  });

  it("ignores non-string glob entries without throwing", () => {
    // Settings are user-typed JSON — entries may not be strings at runtime
    const triage = computeTriage(
      ["yarn.lock", "src/main.ts"],
      [null, 42, { glob: "**" }, "**/*.lock"],
      noGenerated,
    );
    expect(triage.get("yarn.lock")).toBe("auto");
    expect(triage.get("src/main.ts")).toBe("normal");
  });

  it("skips a glob picomatch cannot compile and keeps the rest working", () => {
    // picomatch throws on patterns longer than its 65536-char limit
    const throwingGlob = "a".repeat(70000);
    const triage = computeTriage(
      ["yarn.lock", "src/main.ts"],
      [throwingGlob, "**/*.lock"],
      noGenerated,
    );
    expect(triage.get("yarn.lock")).toBe("auto");
    expect(triage.get("src/main.ts")).toBe("normal");
  });
});
