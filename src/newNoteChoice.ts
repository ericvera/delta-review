import { isAbsolute, relative } from "node:path";

const OPEN_FROM_DIFF = "Open a file from the Delta Review diff";

// Whether the "+ > File note" choice can target the active editor's file:
// the repo-relative path when it can, else the reason shown in the picker.
// `baseScheme` is a parameter because the module defining it imports vscode.
export const fileNoteAvailability = (
  active: { scheme: string; fsPath: string; path: string } | undefined,
  repoRoot: string,
  files: readonly { path: string; deleted: boolean }[],
  baseScheme: string,
): { path: string } | { reason: string } => {
  if (active === undefined) {
    return { reason: "No file is open in the editor" };
  }
  let path: string;
  if (active.scheme === "file") {
    const relativePath = relative(repoRoot, active.fsPath);
    if (
      relativePath === "" ||
      relativePath.split(/[\\/]/)[0] === ".." ||
      isAbsolute(relativePath)
    ) {
      return { reason: OPEN_FROM_DIFF };
    }
    path = relativePath.replace(/\\/g, "/");
  } else if (active.scheme === baseScheme) {
    path = active.path.slice(1);
  } else {
    return { reason: OPEN_FROM_DIFF };
  }
  const file = files.find((entry) => entry.path === path);
  if (file === undefined) {
    return { reason: `${path} is not changed on this branch` };
  }
  if (file.deleted) {
    return { reason: `${path} is deleted on this branch` };
  }
  return { path };
};
