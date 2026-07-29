import type { ReviewModel } from "./model";

// Base-document helpers. A base document's identity is the pair
// (`diffBasePath`, `diffBaseSha`) — the model resolves both, so nothing here
// re-derives the left-hand path. Kept free of `vscode` imports so it stays
// loadable under Vitest.

// The blob currently displayed as the base document a base-side note belongs
// to. Two review files can present the same base path (a declared move whose
// origin file is still in the review set), so the path alone no longer
// identifies a base document. Resolution order:
//
//   1. a file showing that path whose base blob is the note's own creation
//      blob — the note is already looking at that document, so it cannot
//      migrate onto a foreign diff;
//   2. otherwise the sole file showing that path, which is what lets a note
//      follow a base that advanced (mark-reviewed re-bases the diff); when
//      several show it, the one whose own path is the note's path wins;
//   3. otherwise undefined — the note has no current base document.
export const baseBlobForNote = (
  model: ReviewModel,
  file: string,
  contentBlob: string,
): string | undefined => {
  const showing = model.files.filter((entry) => entry.diffBasePath === file);
  const created = showing.find((entry) => entry.diffBaseSha === contentBlob);
  if (created !== undefined) {
    return created.diffBaseSha;
  }
  if (showing.length === 1) {
    return showing[0]?.diffBaseSha;
  }
  return showing.find((entry) => entry.path === file)?.diffBaseSha;
};

// The identity-carrying parts of a base-document URI: the sha travels in the
// query so the same path at two different blobs is two distinct documents,
// and a missing sha reads as the empty document.
export const reviewBaseUriParts = (
  path: string,
  sha: string | undefined,
): { path: string; query: string } => ({
  path: `/${path}`,
  query: sha ?? "empty",
});
