# Progress

## 1.1 — Switched build/package to an esbuild bundle; added picomatch

- Key changes: new `esbuild.mjs` (bundles `src/extension.ts` → `out/extension.js`, cjs, node platform, `external: ['vscode']`, sourcemap, no minify, `--watch` flag); `package.json` scripts `build` → `tsc -p . && node esbuild.mjs`, `watch` → `node esbuild.mjs --watch`; deps `picomatch` + dev `esbuild`, `@types/picomatch`; `tsconfig.json` adds `noEmit: true` and `esModuleInterop: true`; `.vscodeignore` now also excludes `esbuild.mjs`, `eslint.config.mjs`, `.prettierignore`, `.claude/**`, `.mise/**`; `README.md` dev link de-linkified.
- Deviations from plan:
  - Added `esModuleInterop: true` to tsconfig (not in plan): `@types/picomatch` uses `export =`, so the default-import form (`import picomatch from "picomatch"`, needed by task 1.2) fails typecheck without it; esbuild handles the interop natively.
  - Fixed `README.md`: `yarn package` failed at baseline too — vsce errors on the relative `[DEVELOPMENT.md](DEVELOPMENT.md)` link with no repository URL. Replaced with plain-text mention so packaging passes.
  - `.vscode/tasks.json` unchanged: its build task runs `yarn build` (not tsc directly), which still typechecks + bundles as a one-shot preLaunchTask, so F5 keeps working.
- Verification: format/lint/build/test green; `yarn package` produces a vsix containing only `out/extension.js(.map)` + docs; picomatch confirmed inlined in the bundle (no bare `require("picomatch")`); headless extension-host smoke test (`@vscode/test-electron`, scratchpad harness) activated the bundled extension against a git repo with changes, all `deltaReview.*` commands registered, `deltaReview.refresh` executed cleanly (substitute for manual F5 per test exception).
- Review fix: added `PLAN.md` to `.vscodeignore` — the internal implementation brief was shipping inside the vsix. Re-verified: format/lint/build/test green; `yarn package` vsix file list no longer contains `extension/PLAN.md` (only `out/extension.js(.map)`, `package.json`, `readme.md`, `DEVELOPMENT.md`).
