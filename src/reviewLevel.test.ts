import { describe, expect, it } from "vitest";
import { SKIM_TOOLTIP, withLevelTag } from "./reviewLevel";

describe("withLevelTag", () => {
  it("passes the description through for review", () => {
    expect(withLevelTag("review", "src/a")).toBe("src/a");
    expect(withLevelTag("review", undefined)).toBeUndefined();
    expect(withLevelTag("review", "")).toBe("");
  });

  it("shows skim alone when the rest is undefined or empty", () => {
    expect(withLevelTag("skim", undefined)).toBe("skim");
    expect(withLevelTag("skim", "")).toBe("skim");
  });

  it("prefixes skim to a non-empty description", () => {
    expect(withLevelTag("skim", "src/a")).toBe("skim · src/a");
  });
});

describe("SKIM_TOOLTIP", () => {
  it("states that a glance is enough", () => {
    expect(SKIM_TOOLTIP).toBe(
      "Skim — a glance is enough; the agent does not expect a line-by-line read.",
    );
  });
});
