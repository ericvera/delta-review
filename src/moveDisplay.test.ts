import { describe, expect, it } from "vitest";
import type { MoveClassification, MoveOrigin } from "./model";
import {
  ROW_DESCRIPTION_THRESHOLD,
  buildRowDescription,
  buildTooltipOriginLine,
  type RowDescriptionInput,
} from "./moveDisplay";

const describeRow = (
  overrides: Partial<RowDescriptionInput> & { path: string },
): string | undefined =>
  buildRowDescription({
    directoryText: undefined,
    movedFrom: undefined,
    moveOrigin: undefined,
    donor: undefined,
    moveClassification: undefined,
    ...overrides,
  });

// An external move as the clusters contract declares it: the origin path is
// written relative to the repo, and the donor name is separate
const external = (
  path: string,
  from: string,
  donor: string | undefined,
  classification: MoveClassification,
  directoryText: string | undefined,
): string | undefined =>
  describeRow({
    path,
    directoryText,
    movedFrom: from,
    moveOrigin: "external" satisfies MoveOrigin,
    donor,
    moveClassification: classification,
  });

const repo = (
  path: string,
  from: string,
  classification: MoveClassification,
  directoryText: string | undefined,
): string | undefined =>
  describeRow({
    path,
    directoryText,
    movedFrom: from,
    moveOrigin: "repo" satisfies MoveOrigin,
    donor: undefined,
    moveClassification: classification,
  });

describe("buildRowDescription", () => {
  describe("the canonical rows", () => {
    it("drops the path entirely when the whole relative path is shared", () => {
      expect(
        external(
          "src/config.ts",
          "../donor-app/src/config.ts",
          "donor-app",
          "adapted",
          "src",
        ),
      ).toBe("src ← [donor-app] · adapted");
    });

    it("keeps the differing directories when only the filename is shared", () => {
      expect(
        external(
          "src/api/client.ts",
          "../donor-app/src/http/client.ts",
          "donor-app",
          "verbatim",
          "src/api",
        ),
      ).toBe("src/api ← [donor-app] src/http · verbatim");
    });

    it("shortens a long origin that shares nothing with the destination", () => {
      expect(
        external(
          "src/telemetry/telemetryReporter.ts",
          "../donor-app/src/observability/reporter.ts",
          "donor-app",
          "adapted",
          "src/telemetry",
        ),
      ).toBe("src/telemetry ← [donor-app] …/reporter.ts · adapted");
    });

    it("renders an in-repo move without brackets", () => {
      expect(
        repo("src/api/retry.ts", "src/util/backoff.ts", "adapted", "src/api"),
      ).toBe("src/api ← src/util/backoff.ts · adapted");
    });
  });

  describe("shared-suffix stripping", () => {
    it("compares whole segments, not characters", () => {
      // "reporter.ts" and "telemetryReporter.ts" share a character suffix but
      // no segment, so nothing is stripped
      expect(
        repo(
          "src/telemetryReporter.ts",
          "lib/reporter.ts",
          "adapted",
          undefined,
        ),
      ).toBe("← lib/reporter.ts · adapted");
    });

    it("strips a shared filename only", () => {
      expect(
        repo("src/api/client.ts", "src/http/client.ts", "adapted", "src/api"),
      ).toBe("src/api ← src/http · adapted");
    });

    it("strips nothing when no trailing segment matches", () => {
      expect(
        repo("src/api/retry.ts", "lib/backoff.ts", "adapted", "src/api"),
      ).toBe("src/api ← lib/backoff.ts · adapted");
    });
  });

  describe("donor-relative reduction", () => {
    it("takes the segments after the donor segment", () => {
      expect(
        external(
          "src/api/client.ts",
          "../donor-app/src/http/client.ts",
          "donor-app",
          "adapted",
          "src/api",
        ),
      ).toBe("src/api ← [donor-app] src/http · adapted");
    });

    it("uses the last donor segment when it appears twice", () => {
      expect(
        external(
          "src/config.ts",
          "../donor-app/vendor/donor-app/src/config.ts",
          "donor-app",
          "adapted",
          "src",
        ),
      ).toBe("src ← [donor-app] · adapted");
    });

    it("drops leading relative segments when the donor never appears", () => {
      expect(
        external(
          "src/config.ts",
          "../other/src/config.ts",
          "donor-app",
          "adapted",
          "src",
        ),
      ).toBe("src ← [donor-app] other · adapted");
    });

    it("drops the leading empty segment of an absolute origin", () => {
      expect(
        external(
          "src/x.ts",
          "/Users/eric/Code/sdk/src/x.ts",
          "donor-app",
          "adapted",
          "src",
        ),
      ).toBe("src ← [donor-app] Users/eric/Code/sdk · adapted");
    });
  });

  describe("brackets", () => {
    it("renders an external move without a donor unbracketed", () => {
      expect(
        external(
          "src/api/client.ts",
          "../donor-app/src/http/client.ts",
          undefined,
          "verbatim",
          "src/api",
        ),
      ).toBe("src/api ← donor-app/src/http · verbatim");
    });

    it("never brackets a repo origin, even with a donor set", () => {
      expect(
        describeRow({
          path: "src/api/retry.ts",
          directoryText: "src/api",
          movedFrom: "src/util/backoff.ts",
          moveOrigin: "repo",
          donor: "donor-app",
          moveClassification: "adapted",
        }),
      ).toBe("src/api ← src/util/backoff.ts · adapted");
    });
  });

  describe("the empty-reduction fallback", () => {
    it("falls back to the full origin for a repo move, never a bare arrow", () => {
      expect(
        repo("src/api/config.ts", "api/config.ts", "adapted", "src/api"),
      ).toBe("src/api ← api/config.ts · adapted");
    });

    it("falls back to the full origin for an external move with no donor", () => {
      expect(
        external(
          "src/config.ts",
          "./src/config.ts",
          undefined,
          "adapted",
          "src",
        ),
      ).toBe("src ← ./src/config.ts · adapted");
    });
  });

  describe("length shortening", () => {
    it("renders whole at exactly the threshold", () => {
      const description = repo(
        "src/api/retry.ts",
        "src/legacy/networkBackoff.ts",
        "adapted",
        "src/api",
      );
      expect(description).toBe(
        "src/api ← src/legacy/networkBackoff.ts · adapted",
      );
      expect(description?.length).toBe(ROW_DESCRIPTION_THRESHOLD);
    });

    it("shortens one character over the threshold", () => {
      expect(
        repo(
          "src/api/retry.ts",
          "src/legacy/networkBackoffs.ts",
          "adapted",
          "src/api",
        ),
      ).toBe("src/api ← …/networkBackoffs.ts · adapted");
    });

    it("shortens once and accepts a result still over the threshold", () => {
      const description = external(
        "src/telemetry/telemetryReporter.ts",
        "../donor-app/src/observability/instrumentation/reporter.ts",
        "donor-app",
        "adapted",
        "src/telemetry",
      );
      expect(description).toBe(
        "src/telemetry ← [donor-app] …/reporter.ts · adapted",
      );
      expect(description?.length).toBeGreaterThan(ROW_DESCRIPTION_THRESHOLD);
    });

    it("leaves a single-segment origin alone rather than lengthening it", () => {
      expect(
        repo(
          "src/deeply/nested/place/inner/newWidget.ts",
          "oldWidget.ts",
          "adapted",
          "src/deeply/nested/place/inner",
        ),
      ).toBe("src/deeply/nested/place/inner ← oldWidget.ts · adapted");
    });
  });

  describe("donor truncation", () => {
    it("keeps the donor whole when the row fits", () => {
      expect(
        external(
          "src/deeply/nested/place/config.ts",
          "../donor-app/src/deeply/nested/place/config.ts",
          "donor-app",
          "adapted",
          "src/deeply/nested/place",
        ),
      ).toBe("src/deeply/nested/place ← [donor-app] · adapted");
    });

    it("truncates the donor to the threshold when there is no path left", () => {
      const description = external(
        "src/deeply/nested/place/inner/config.ts",
        "../donor-app/src/deeply/nested/place/inner/config.ts",
        "donor-app",
        "adapted",
        "src/deeply/nested/place/inner",
      );
      expect(description).toBe(
        "src/deeply/nested/place/inner ← [don…] · adapted",
      );
      expect(description?.length).toBe(ROW_DESCRIPTION_THRESHOLD);
    });

    it("never truncates below one character plus the ellipsis", () => {
      const directory = "src/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y";
      const description = external(
        `${directory}/config.ts`,
        `../donor-app/${directory}/config.ts`,
        "donor-app",
        "adapted",
        directory,
      );
      expect(description).toBe(`${directory} ← [d…] · adapted`);
      expect(description?.length).toBeGreaterThan(ROW_DESCRIPTION_THRESHOLD);
    });

    it("leaves a short donor alone rather than lengthening it", () => {
      expect(
        external(
          "src/deeply/nested/place/inner/more/config.ts",
          "../ui/src/deeply/nested/place/inner/more/config.ts",
          "ui",
          "adapted",
          "src/deeply/nested/place/inner/more",
        ),
      ).toBe("src/deeply/nested/place/inner/more ← [ui] · adapted");
    });
  });

  describe("classification wording", () => {
    it("appends the verbatim word", () => {
      expect(
        repo("src/api/retry.ts", "src/util/backoff.ts", "verbatim", "src/api"),
      ).toBe("src/api ← src/util/backoff.ts · verbatim");
    });

    it("appends the adapted word", () => {
      expect(
        repo("src/api/retry.ts", "src/util/backoff.ts", "adapted", "src/api"),
      ).toBe("src/api ← src/util/backoff.ts · adapted");
    });

    it("renders nothing for an unknown classification", () => {
      expect(
        repo("src/api/retry.ts", "src/util/backoff.ts", "unknown", "src/api"),
      ).toBe("src/api ← src/util/backoff.ts");
    });

    it("renders nothing when there is no classification", () => {
      expect(
        describeRow({
          path: "src/api/retry.ts",
          directoryText: "src/api",
          movedFrom: "src/util/backoff.ts",
          moveOrigin: "repo",
        }),
      ).toBe("src/api ← src/util/backoff.ts");
    });
  });

  describe("tree mode, with no directory text", () => {
    it("starts the description at the arrow with no leading space", () => {
      expect(
        external(
          "src/api/client.ts",
          "../donor-app/src/http/client.ts",
          "donor-app",
          "verbatim",
          undefined,
        ),
      ).toBe("← [donor-app] src/http · verbatim");
    });

    it("shortens against the same threshold with no directory text", () => {
      expect(
        external(
          "src/telemetry/telemetryReporter.ts",
          "../donor-app/src/observability/reporter.ts",
          "donor-app",
          "adapted",
          undefined,
        ),
      ).toBe("← [donor-app] …/reporter.ts · adapted");
    });
  });

  describe("files that are not moves", () => {
    it("returns the directory text unchanged", () => {
      expect(
        describeRow({ path: "src/api/retry.ts", directoryText: "src/api" }),
      ).toBe("src/api");
    });

    it("returns undefined when there is no directory text either", () => {
      expect(describeRow({ path: "src/api/retry.ts" })).toBeUndefined();
    });
  });
});

describe("buildTooltipOriginLine", () => {
  it("names the complete origin, never the row's reduced form", () => {
    expect(
      buildTooltipOriginLine({
        movedFrom: "../donor-app/src/http/client.ts",
        donor: "donor-app",
      }),
    ).toBe("Moved from ../donor-app/src/http/client.ts");
  });

  it("names the donor separately when it is not a segment of the origin", () => {
    expect(
      buildTooltipOriginLine({
        movedFrom: "vendor/http/client.ts",
        donor: "donor-app",
      }),
    ).toBe("Moved from vendor/http/client.ts (donor: donor-app)");
  });

  it("names the donor separately when it is only a substring of a segment", () => {
    expect(
      buildTooltipOriginLine({
        movedFrom: "../donor-app-legacy/src/client.ts",
        donor: "donor-app",
      }),
    ).toBe("Moved from ../donor-app-legacy/src/client.ts (donor: donor-app)");
  });

  it("omits the donor clause when there is no donor", () => {
    expect(
      buildTooltipOriginLine({
        movedFrom: "src/old/config.ts",
        donor: undefined,
      }),
    ).toBe("Moved from src/old/config.ts");
  });

  it("omits the donor clause when the donor is an empty string", () => {
    expect(
      buildTooltipOriginLine({ movedFrom: "src/old/config.ts", donor: "" }),
    ).toBe("Moved from src/old/config.ts");
  });

  it("returns undefined when the file is not a move", () => {
    expect(
      buildTooltipOriginLine({ movedFrom: undefined, donor: "donor-app" }),
    ).toBeUndefined();
  });

  it("returns undefined for an empty origin, matching buildRowDescription", () => {
    expect(
      buildTooltipOriginLine({ movedFrom: "", donor: undefined }),
    ).toBeUndefined();
  });

  describe("contract text cannot alter the tooltip", () => {
    it("escapes markdown syntax in the origin path", () => {
      expect(
        buildTooltipOriginLine({
          movedFrom: "[click](https://evil.example)",
          donor: undefined,
        }),
      ).toBe("Moved from \\[click\\]\\(https://evil.example\\)");
    });

    it("escapes markdown syntax in the donor name", () => {
      expect(
        buildTooltipOriginLine({
          movedFrom: "vendor/client.ts",
          donor: "![img](https://evil.example/x.png)",
        }),
      ).toBe(
        "Moved from vendor/client.ts (donor: \\!\\[img\\]\\(https://evil.example/x.png\\))",
      );
    });

    it("collapses newlines so the origin cannot forge a following status line", () => {
      expect(
        buildTooltipOriginLine({
          movedFrom: "src/a.ts\n\nIdentical to the origin",
          donor: undefined,
        }),
      ).toBe("Moved from src/a.ts Identical to the origin");
    });

    it("collapses newlines in the donor name too", () => {
      expect(
        buildTooltipOriginLine({
          movedFrom: "vendor/client.ts",
          donor: "app\nDeleted from the working tree",
        }),
      ).toBe(
        "Moved from vendor/client.ts (donor: app Deleted from the working tree)",
      );
    });
  });
});
