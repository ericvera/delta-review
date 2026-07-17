# Task 1.1: Switch build/package to an esbuild bundle; add picomatch

## Goal

`out/extension.js` becomes a single esbuild bundle that includes runtime dependencies, so the extension can ship picomatch (and future deps) even though `vsce package` runs with `--no-dependencies`. Typechecking stays via tsc.

## Requirements addressed

Enabler for REQ-AUTO-1 and REQ-CLUS-3 (both need picomatch at runtime); implements goals-gate decision 3 (esbuild + picomatch).

## Background

Delta Review is a VS Code extension (repo root = extension root). Today `package.json` has **no runtime `dependencies`**, `main: "./out/extension.js"`, and scripts: `build` = `tsc -p .` (emits `out/` from `src/`), `watch` = `tsc -w -p .`, `package` = `vsce package -o delta-review.vsix --allow-missing-repository --no-dependencies`, plus `format`/`lint`/`test` (prettier / eslint / vitest, recently added). `--no-dependencies` means vsce never packs `node_modules`, so any runtime dep must be bundled into `out/extension.js`. tsconfig: ES2022, commonjs, `rootDir: src`, `outDir: out`, strict. Yarn 3.3.1 with `nodeLinker: node-modules`. The extension entry is `src/extension.ts` (exports `activate`); all other `src/*.ts` files are reached from it. `.vscode/launch.json` and `tasks.json` exist for F5 debugging (check what the preLaunch task runs and keep it working).

## Files to modify/create

- `package.json` — add `dependencies: { picomatch }`; add devDependencies `esbuild`, `@types/picomatch`; rework scripts (see below).
- `esbuild.mjs` (new) — build script with a `--watch` flag, following the standard VS Code extension esbuild recipe.
- `tsconfig.json` — add `"noEmit": true` (tsc becomes typecheck-only; esbuild emits).
- `.vscode/tasks.json` — if the build task invokes `tsc`, point it at the new watch script so F5 still works.
- `.vscodeignore` — ensure `esbuild.mjs`, `src/`, and config files are excluded from the vsix (check current contents first).
- `.claude/mise-config.md` — update the Check slot if needed so `yarn build` semantics stay "typecheck happens in CI-equivalent flow" (see Implementation details step 4).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. `yarn add picomatch && yarn add -D esbuild @types/picomatch`.
2. Create `esbuild.mjs`: bundle `src/extension.ts` → `out/extension.js`, `platform: 'node'`, `format: 'cjs'`, `external: ['vscode']`, `sourcemap: true`, `minify: false` (keep it debuggable); support `node esbuild.mjs --watch`.
3. Scripts: `build` → `tsc -p . && node esbuild.mjs` (typecheck then bundle — keeps the mise Check slot `yarn lint` + `yarn build` meaningful); `watch` → `node esbuild.mjs --watch` (developers can run `tsc -w` separately if they want live typechecking); `vscode:prepublish` already runs `yarn build`.
4. With `noEmit` in tsconfig, `tsc -p .` typechecks only. Vitest is unaffected (it transpiles TS itself).
5. Run `yarn build` and confirm `out/extension.js` exists and starts with the bundled header; run `yarn package` and confirm the vsix builds.
6. Sanity-check picomatch bundles: temporarily `import picomatch from "picomatch"` in `src/extension.ts`, build, confirm no runtime resolution of `node_modules` is needed (grep the bundle for `require("picomatch")` — should be absent/inlined), then remove the temp import. (Task 1.2 adds the real import.)

## Testing suggestions

- `yarn build`, `yarn lint`, `yarn test` all green.
- F5 in VS Code → Extension Development Host loads; Delta Review panel works against a repo with changes (per DEVELOPMENT.md manual test script steps 1–3).
- Test exception applies (no e2e infrastructure): verify with the manual F5 check above.

## Gotchas

- `external: ['vscode']` is mandatory — the `vscode` module is provided by the host, bundling it fails.
- Keep `--no-dependencies` on vsce: with Yarn 3 + node-modules linker vsce's dependency walk is unreliable; bundling makes it unnecessary anyway.
- `tsc -w` and esbuild watch both writing `out/` would conflict — with `noEmit` only esbuild writes, which is the point.
- Don't minify: stack traces from users should stay readable; bundle size is irrelevant here.

## Verification checklist

- [ ] `yarn build` produces a bundled `out/extension.js`; `yarn package` produces the vsix
- [ ] `yarn lint` and `yarn test` pass
- [ ] F5 dev host loads the extension and the panel populates (Test exception: manual verification in lieu of e2e)
- [ ] picomatch import bundles correctly (step 6)
