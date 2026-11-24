import { describe, expect, it } from "vitest";
import { SKIM_TOOLTIP, withLevelLabel } from "./reviewLevel";

describe("withLevelLabel", () => {
  it("leaves the name unchanged for review", () => {
    expect(withLevelLabel("review", "a.ts")).toBe("a.ts");
  });

  it("appends the skim tag to the name", () => {
    expect(withLevelLabel("skim", "a.ts")).toBe("a.ts · skim");
  });
});

describe("SKIM_TOOLTIP", () => {
  it("states that a glance is enough", () => {
    expect(SKIM_TOOLTIP).toBe(
      "Skim — a glance is enough; the agent does not expect a line-by-line read.",
    );
  });
});
