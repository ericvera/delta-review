# CLAUDE.md

- Agent-facing skill docs (`plugin/skills/*/SKILL.md`): structure as a binding **Contract** section plus a separate, overridable **Default workflow** that references it; the audience is a model — keep it terse, every line normative or behavior-changing, no motivational prose. State each rule exactly once, in the Contract; a workflow step references the Contract section by name instead of restating it. `DEVELOPMENT.md` gets the same treatment.
- Never open a pull request for, or merge into another branch, any branch whose tree contains `.mise/` — that work is still in flight; run `/mise:next` on that branch to finish acceptance and cleanup first.
- Tests: Vitest, colocated `*.test.ts` beside the source in `src/`; every new source file gets one, and changed behavior gets a test that fails without the change.
- Unit tests cover pure logic only: `vscode` cannot be imported under Vitest, so keep testable logic free of VS Code API imports.
- Extension-host behavior: verify with unit tests plus a scripted `@vscode/test-electron` check (`DEVELOPMENT.md`, "Scripted extension-host checks"); interactive F5 is eyeball-only polish, never the primary verification.
- Purely visual changes (icons, labels, spacing): verify manually in the dev host; no test required.
- UI mocks imitate the VS Code SCM sidebar tree: dark theme, codicon-style icons, compact rows with inline hover actions.
- No `REQ-*` identifiers in code, comments, tests, or strings.
- Comments explain why or a non-obvious what; never restate the code.
