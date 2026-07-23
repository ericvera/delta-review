# Mise Configuration

Mise directory: .mise/

Branch convention: feat/<slug> for features, fix/<slug> for bug fixes

## Quality commands

- Format: yarn format
- Check:
  - yarn lint
  - yarn build
- Unit tests: yarn test

## Mock conditions

- Anything changing the extension's UI (tree view structure, new view modes, panel layout, new commands/buttons)

## Mock guidance

Product: Delta Review, a VS Code extension (SCM sidebar panel). UI code root: `src/treeProvider.ts` plus `contributes` in `package.json`. Mocks should imitate the VS Code SCM sidebar tree: dark theme, codicon-style icons, compact rows with inline hover actions.

## Test conventions

Vitest; colocate `*.test.ts` next to the source in `src/`. Unit tests cover pure logic only — the `vscode` module cannot be imported under Vitest, so keep testable logic free of VS Code API imports.

## Test exceptions

- Anything that would need an extension-host e2e test — verify with unit tests plus a scripted `@vscode/test-electron` check (recipe: DEVELOPMENT.md, "Scripted extension-host checks"); interactive F5 is usually unavailable to agent runs, so treat it as eyeball-only polish, not the primary verification
- Purely visual changes (icons, labels, spacing) — verify manually in the dev host

## Skills & guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
