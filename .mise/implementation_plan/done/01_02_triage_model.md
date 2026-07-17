# Task 1.2: Triage classification (`auto`/`normal`) on ReviewFile

## Goal

Every file in the review set gets `triage: 'auto' | 'normal'`, computed from the `deltaReview.autoReview.globs` setting and the `linguist-generated` gitattribute. Pure logic in a new `src/triage.ts` with Vitest coverage. No UI change yet.

## Requirements addressed

REQ-AUTO-1, REQ-AUTO-2, REQ-AUTO-8 (settings declared; config-change refresh already exists).

## Background

Delta Review computes its review set in `computeReviewModel(git, baseBranch)` (`src/model.ts:35`): it derives `branch`, `mergeBase`, a sorted `paths` list (tracked diff vs merge base + untracked), then maps each path to a `ReviewFile { path, status, deleted, existsInMergeBase, diffBaseIsReviewedSnapshot, diffBaseSha }`. `Git` (`src/git.ts`) is a thin `execFile` wrapper: `git.run(args, {stdin?})` → stdout, rejects with stderr. Task 1.1 switched the build to an esbuild bundle and added picomatch as a runtime dependency — import it normally.

Feature 2 (glob auto-review) classifies files as mechanical using exactly two inputs — a user setting with glob patterns, and the `linguist-generated` attribute from `.gitattributes` — with **no diff-content analysis of any kind**. `linguist-generated` counts even when the globs setting is empty.

Vitest cannot import the `vscode` module, so classification logic must live in a vscode-free module. `src/model.ts` is already vscode-free; keep it that way. The vscode-specific part (reading configuration) happens in `src/extension.ts`, which already re-runs `refresh()` on any `deltaReview.*` configuration change (`src/extension.ts:394-398`) — REQ-AUTO-8 needs no new wiring.

## Files to modify/create

- `src/triage.ts` (new) — pure classification: `computeTriage(paths, globs, generatedPaths) → Map<string, 'auto' | 'normal'>` (or equivalent shape), using picomatch for glob matching against repo-relative `/`-separated paths.
- `src/triage.test.ts` (new) — Vitest unit tests, colocated per the project convention.
- `src/model.ts` — add `triage: 'auto' | 'normal'` to `ReviewFile`; extend `computeReviewModel` to accept the globs (new parameter, e.g. an options arg) and to fetch `linguist-generated` attributes via git, then set `triage` per file.
- `src/extension.ts` — read `deltaReview.autoReview.globs` from configuration in `refresh()` (next to the existing `baseBranch` read at `src/extension.ts:125-128`) and pass it to `computeReviewModel`.
- `package.json` — declare the settings under `contributes.configuration.properties`: `deltaReview.autoReview.globs` (`array` of `string`, default `[]`, description naming examples like `**/*.lock`, `dist/**`) and `deltaReview.autoReview.markAutomatically` (`boolean`, default `false`) — declare both now so Task 2.2 only implements behavior.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. **Attribute lookup** (in `model.ts`, since it owns git access): run `git check-attr --stdin -z linguist-generated` with the review-set paths NUL-joined on stdin (only when there are paths). `-z` output is NUL-separated flat triplets `path, attr, value`; a path is generated when value is `set` or `true`. Wrap in try/catch → empty set on failure (never break the model over attributes).
2. **Matching** (`src/triage.ts`): compile the globs once per call with picomatch (default options, `dot: true` so dotfiles match — lockfiles like `.pnp.cjs` matter); `auto` = matches any glob OR in the generated set; everything else `normal`.
3. Deleted files still get classified (their path matches globs the same way).
4. Thread globs through `computeReviewModel`: keep the signature change minimal, e.g. `computeReviewModel(git, baseBranch, options?: { autoReviewGlobs?: string[] })`.
5. Unit tests (`src/triage.test.ts`): glob hit, `**` recursion, no-glob + generated hit, both inputs empty → all normal, dotfile matching, case sensitivity, deleted-path classification (plain path string — triage doesn't know about deletion), pattern list order irrelevant.

## Testing suggestions

- `yarn test` — the new triage tests.
- Manual: in the F5 dev host, set `deltaReview.autoReview.globs: ["**/*.lock"]` in a test repo's settings; nothing visible changes yet (UI lands in Task 2.1) — verify no errors in the extension host log and the model still renders.
- Test exception applies (no e2e infrastructure): unit tests + the manual smoke above.

## Gotchas

- `git check-attr -z` output is a flat NUL-separated sequence, **not** newline records — reuse `splitNulTerminated` (`src/git.ts:42`) and walk it in steps of 3.
- Paths with special characters: always use `--stdin` (never argv) for the path list, same as `hash-object --stdin-paths` at `src/model.ts:85`.
- Don't call picomatch per file per pattern — precompile matchers once (500 files × N patterns matters).
- `deltaReview.autoReview.globs` config read: `getConfiguration("deltaReview").get<string[]>("autoReview.globs") ?? []` — the section/key split matters.

## Verification checklist

- [ ] `ReviewFile.triage` populated for every file; `yarn build`/`lint`/`test` green
- [ ] Unit tests cover globs, linguist-generated, combination, and empty-input cases
- [ ] Settings appear in the VS Code Settings UI with descriptions and defaults (`[]`, `false`)
- [ ] End-to-end: Test exception (no e2e infra) — unit tests + F5 smoke check, no extension-host errors
