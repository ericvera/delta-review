# 01_01 — delta:cluster runs with user or calling-skill guidance

## Goal

Let the `delta:cluster` skill run under guidance from the user or a calling skill: keep only file-integrity rules binding in its Contract, move every overridable rule (grouping, `files` order, review levels, wait flags, label length, no-junk-drawer, notes content, notes document shape) into the Default workflow as defaults that guidance replaces, and bump the plugin version. Doc-only; no `src/` change.

## Files to modify/create

- `plugin/skills/cluster/SKILL.md`
- `plugin/.claude-plugin/plugin.json`

## Background

- The repo is a VS Code extension (Delta Review) plus a Claude Code plugin (`plugin/`) shipping two agent-facing skills. `plugin/skills/cluster/SKILL.md` tells an agent how to write the clusters contract JSON the extension renders. The extension parses only the JSON contract and finds markdown documents by path/slug; it parses no document content (nothing reads `## Reading order`; `src/documents.test.ts:62-75` uses it only as fixture text — leave it).
- Project rule (`CLAUDE.md:3`): skill docs = a binding **Contract** section plus a separate, overridable **Default workflow** that references it; terse, every line normative, no motivational prose; each rule stated exactly once, in its one home; workflow steps reference sections by name instead of restating them.
- Precedent to mirror: `plugin/skills/review-notes/SKILL.md:151` — the Default workflow intro reads "The default when the user asks to address their review notes; other skills or instructions may drive different behavior on the same contract (...) — the Contract still governs all file access."
- Current `plugin/skills/cluster/SKILL.md` layout:
  - Frontmatter `description` `:3-13`.
  - "Two situations" `:20-23`.
  - `## Contract` intro `:27` "Binding for every consumer of this file, whatever workflow is driving."
  - Schema bullets `:95-96` say "See **Wait**"; `:106` says "See **Review levels**".
  - `:132` preserved-exceptions sentence (leave as is; it states what may survive across runs, not that it must).
  - `### Notes` `:158-168`, `### Review levels` `:170-174`, `### Wait` `:176-181`, `### Documents` `:183-190` (shape line `:189`).
  - `### Membership resolution` `:203-207` (a fact about how the extension orders list mode — stays).
  - `## Default workflow: clustering the branch` `:213`; step 3 `:233-241` (preservation bullet `:239` references **Notes**, **Review levels**, **Wait**); step 5 `:247-249`; step 6 `:251-261`; step 7 `:263-265`; step 8 `:267-269`.

Design decisions (approved in goals):

- Guidance sources: `/delta:cluster` arguments, the user's message, or a calling skill's instructions. Precedence: user > calling skill > Default workflow.
- Guidance may replace anything in the Default workflow. Always binding regardless of guidance (stays in the Contract): file location, schema and validation, atomic write, move/extraction evidence and preservation, ranged-note re-anchoring and the `version` rule, document location/slug, never committing, rename/delete rules and the reply-before-rename/delete duty.
- Under guidance, a cluster notes document is `# <label>` followed only by the sections the guidance asks for; `## Reading order` and `## Check` appear only if requested. Planner choice for the edge case: guidance that asks for no document sections means no notes document is written or refreshed for that cluster; an existing one is left unchanged, and the Contract's rename/delete rules still apply to renamed or dropped clusters.
- The final report step still applies under guidance unless the guidance says otherwise.

## Guides

- plugin/skills/cluster/SKILL.md (doc): the clusters contract file — read before changing cluster generation or its file format

## Implementation details

`plugin/skills/cluster/SKILL.md`:

1. Frontmatter `description`: add a trigger clause, e.g. "…, or when the user or a calling skill supplies its own rules for grouping, file order, review levels, notes or notes documents (`/delta:cluster <guidance>`)." Keep it one folded `>-` block.
2. `## Contract` intro `:27`: "Binding for every consumer of this file, whatever workflow or guidance is driving."
3. `### Notes`: keep in the Contract only the format/integrity lines — separation from a move's `note`; the file-level vs ranged encoding rule ("A remark about specific lines is a ranged item…; keep a value with no ranged item a single string"); drop an entry whose path left the review set; ranged-item re-anchoring on every re-run; last-ranged-item collapse plus the `version` rule. Move out to the workflow (step 5): "Write an entry for a file that warrants a one-line remark", "On a cold re-run, preserve existing file-level strings and ranged items' `text` unchanged", "At the end of a task, the entry of a file that task touched may be rewritten".
4. `### Review levels`: keep "Omit `review`; it is the default" and "drop an entry whose path has left the review set". Move to workflow step 5: the `skim` criteria (tests mirroring code, mechanical edits, docs) and "on a cold re-run, preserve existing entries".
5. `### Wait`: move the whole section into workflow step 6 (as a sub-list or a `#### Wait` under step 6). Update the schema bullets `:95-96` "See **Wait**" to point at its new home (e.g. "See workflow step 6").
6. `### Documents`: remove the `Shape:` line `:189`; everything else stays. Put the default shape in workflow step 7: `# <label>`; an intro paragraph; `## Reading order`, a numbered list of the cluster's files in its `files` order; `## Check`, a list of questions for the reviewer. Step 7 also states the guided shape per the design decision above (or the workflow intro does — once only).
7. `## Default workflow` intro (new, directly under the heading, before step 1), modeled on review-notes `:151`: this workflow is the default; guidance from `/delta:cluster` arguments, the user's message, or a calling skill's instructions replaces any step or rule here it addresses, user over calling skill over workflow; where guidance is silent the workflow applies; the Contract binds regardless.
8. Step 3 preservation bullet `:239`: re-point references so notes/levels preservation cites step 5 and wait/waitPaths cites step 6; moves still cite **Declaring a move** (Contract).
9. Step 5: change "per the Contract's **Notes** section and `levels` per **Review levels**" so it holds the moved default rules and references the Contract sections for the binding mechanics.
10. Step 6: keep grouping/narrative, no-junk-drawer, reading-order and label-length lines as defaults (they already live here); replace "per **Wait**" with the moved Wait rules.
11. Step 8: append that the report applies under guidance unless the guidance says otherwise.

`plugin/.claude-plugin/plugin.json`: `"version": "0.11.0"` → `"0.12.0"`. Do not touch root `package.json` (extension stays 0.17.0).

## Gotchas

- State each rule once. After moving a rule, delete it from its old place; don't leave a paraphrase in both Contract and workflow.
- Do not weaken the binding rules: move/extraction evidence, preservation of `moves`, re-run relocation, ranged-note re-anchoring, the `version` rule, atomic write, location, slug, never-commit, and the reply-before-rename/delete duty must stay in the Contract verbatim in substance.
- Fix every cross-reference to a moved section (`**Wait**`, `**Notes**`, `**Review levels**`, `**Documents**` shape). `grep -n '\*\*Wait\*\*\|\*\*Review levels\*\*\|\*\*Notes\*\*' plugin/skills/cluster/SKILL.md` and check each hit still points at text that exists.
- No `REQ-*` identifiers; no motivational prose.
- `.mise/` and `.claude/` are in `.prettierignore`; don't run `yarn format` on them. Running `npx prettier --check plugin/skills/cluster/SKILL.md` is fine.
- No mock: no extension UI change.

## Verification

No Vitest test applies (no `src/` change; doc-only). Run:

- `yarn lint`, `yarn build`, `yarn test` — all stay green (unchanged).
- `npx prettier --check plugin/skills/cluster/SKILL.md plugin/.claude-plugin/plugin.json`.
- Substitute checks on `plugin/skills/cluster/SKILL.md`:
  - `grep -n "Reading order" plugin/skills/cluster/SKILL.md` — hits only inside the Default workflow.
  - `grep -n "Wait" plugin/skills/cluster/SKILL.md` — no `### Wait` under `## Contract`; schema bullets reference the workflow location.
  - The `## Default workflow` intro names all three guidance sources and the precedence user > calling skill > workflow, and says the Contract binds regardless.
  - Read the Contract top to bottom: it contains no grouping, ordering, skim-criteria, wait, label-length, or document-shape rule; it still contains location, schema/validation, evidence, relocation, re-anchoring, `version`, write, slug, rename/delete and reply rules.
  - `node -e 'console.log(require("/Users/eric/Code/delta-review/plugin/.claude-plugin/plugin.json").version)'` prints `0.12.0`.
