# 01_03 Skim tag on file rows

## Goal

A file whose review level is `skim` shows `skim` at the start of its row description and a skim line in its tooltip, in every tree mode. `review` (the default) shows nothing.

## Files to modify/create

- `src/reviewLevel.ts` (new)
- `src/treeProvider.ts`
- `DEVELOPMENT.md`

## Background

- Task 01_02 added `ReviewFile.reviewLevel: "review" | "skim"` (`src/model.ts`) and `export type ReviewLevel` in `src/clusters.ts`.
- File row rendering: `ReviewTreeProvider.getTreeItem` file branch (`src/treeProvider.ts:510-605`). Description comes from `buildRowDescription` (`src/moveDisplay.ts:137`, returns `string | undefined`; `directoryText` is the directory in list mode and flat buckets, else undefined). Tooltip lines are collected in `notes` and joined (`src/treeProvider.ts:555-598`).
- Design decisions: description = `skim` when the rest is empty/undefined, else `skim · <rest>`; tooltip line `Skim — a glance is enough; the agent does not expect a line-by-line read.` placed after the file note and before the status line. The tag shows on reviewed rows and in ungrouped mode too.
- `vscode` cannot be imported under Vitest, so the tag/tooltip text lives in a vscode-free module.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `src/reviewLevel.ts`: `export const SKIM_TOOLTIP = "Skim — a glance is enough; the agent does not expect a line-by-line read."`; `export const withLevelTag = (level: ReviewLevel, description: string | undefined): string | undefined`.
2. `src/treeProvider.ts`: wrap the `buildRowDescription` result with `withLevelTag(file.reviewLevel, …)`; push `SKIM_TOOLTIP` into the tooltip lines when `file.reviewLevel === "skim"`.
3. `DEVELOPMENT.md`: add a `levels` manual step under "Clusters" (skim tag in list and tree mode, grouped and ungrouped, tooltip line; `review` untagged).

## Gotchas

- `ROW_DESCRIPTION_THRESHOLD` abbreviation in `src/moveDisplay.ts` is computed without the tag; leave it so.
- `deltaReview.__inspect`'s `rows` map (built in `src/extension.ts`) intentionally bypasses `getTreeItem`; do not change it.

## Verification

- Run `yarn lint`, `yarn build`, `yarn test`.
- Write `src/reviewLevel.test.ts`: `review` passes the description through (including undefined); `skim` with undefined, empty and non-empty descriptions.
- Row text is a visual label: verify manually in the dev host per the new DEVELOPMENT.md step (no extension-host script needed).
