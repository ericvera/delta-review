import { describe, expect, it } from "vitest";
import { fileNoteAvailability } from "./newNoteChoice";

const repoRoot = "/repo";
const files = [
  { path: "src/a.ts", deleted: false },
  { path: "src/gone.ts", deleted: true },
];
const base = "delta-review-base";

const fileUri = (fsPath: string) => ({ scheme: "file", fsPath, path: fsPath });

describe("fileNoteAvailability", () => {
  it("offers a changed working-tree file by its repo-relative path", () => {
    expect(
      fileNoteAvailability(fileUri("/repo/src/a.ts"), repoRoot, files, base),
    ).toEqual({ path: "src/a.ts" });
  });

  it("maps a base-scheme document to its path", () => {
    expect(
      fileNoteAvailability(
        { scheme: base, fsPath: "/src/a.ts", path: "/src/a.ts" },
        repoRoot,
        files,
        base,
      ),
    ).toEqual({ path: "src/a.ts" });
  });

  it("explains when no file is open", () => {
    expect(fileNoteAvailability(undefined, repoRoot, files, base)).toEqual({
      reason: "No file is open in the editor",
    });
  });

  it("rejects other schemes", () => {
    expect(
      fileNoteAvailability(
        { scheme: "untitled", fsPath: "Untitled-1", path: "Untitled-1" },
        repoRoot,
        files,
        base,
      ),
    ).toEqual({ reason: "Open a file from the Delta Review diff" });
  });

  it("rejects a file outside the repository", () => {
    expect(
      fileNoteAvailability(fileUri("/elsewhere/a.ts"), repoRoot, files, base),
    ).toEqual({ reason: "Open a file from the Delta Review diff" });
    expect(
      fileNoteAvailability(fileUri("/repo-other/a.ts"), repoRoot, files, base),
    ).toEqual({ reason: "Open a file from the Delta Review diff" });
  });

  it("explains an unchanged file", () => {
    expect(
      fileNoteAvailability(fileUri("/repo/src/b.ts"), repoRoot, files, base),
    ).toEqual({ reason: "src/b.ts is not changed on this branch" });
  });

  it("explains a deleted file", () => {
    expect(
      fileNoteAvailability(
        { scheme: base, fsPath: "/src/gone.ts", path: "/src/gone.ts" },
        repoRoot,
        files,
        base,
      ),
    ).toEqual({ reason: "src/gone.ts is deleted on this branch" });
  });
});
