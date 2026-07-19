# Task 5.1: review-notes skill, docs, full manual pass

## Goal

Ship the agent-facing `review-notes` skill documenting the contract end-to-end, update README and
DEVELOPMENT.md, and run the full manual verification pass for the feature.

## Requirements addressed

REQ-AGENT-4, REQ-AGENT-7, REQ-PRESERVE-3

## Background

The feature: inline review notes; the storage is the agent contract. Everything extension-side
exists after Phase 4. The contract (implemented in `src/notes.ts`, Task 1.1; written by
`src/notesStore.ts`, Task 2.1):

- Notes (extension-owned, read-only for agents):
  `<git-common-dir>/delta-review/notes-<sanitized-branch>.json` — `{ version: 1, notes: [{ id,
  file, side: "base"|"working", startLine, endLine, snapshot: string[], contentBlob, turns:
  [{text, at}], status: "open"|"addressed"|"resolved", outdated, currentStartLine, currentEndLine,
  createdAt }] }`.
- Responses (agent-owned): `<git-common-dir>/delta-review/responses-<sanitized-branch>.json` —
  `{ version: 1, responses: [{ noteId, status: "addressed", response, at, anchor?: { file, line,
  snapshot } }] }`; entries append; multiple per noteId accumulate as turns.
- Sanitization: `branch.replace(/[^A-Za-z0-9._-]/g, "-")` (`src/clusters.ts:137-138`).

The existing skill to mirror: `plugin/skills/cluster-review/SKILL.md` — frontmatter (name,
description with trigger phrases), contract schema section with parser-rejection rules vs
conventions, numbered Steps resolving repo root / base branch, and a version-bump rule. The plugin
manifest `plugin/.claude-plugin/plugin.json` — check whether skills are listed explicitly or
directory-discovered; update if listed.

## Files to modify/create

- `plugin/skills/review-notes/SKILL.md` — new skill.
- `plugin/.claude-plugin/plugin.json` — only if skills are enumerated there.
- `README.md` — new "Review notes" usage section (creation, lifecycle, agent loop, REVIEW NOTES
  view) + skill install note next to the existing cluster instructions (README.md:36-56).
- `DEVELOPMENT.md` — internals section (files, ref `refs/review-notes/<branch>`, anchoring model,
  derived-field refresh) + new manual-test-script scenarios (numbered, extending the existing
  Basics/Moves/Auto-review/Clusters groups with a "Notes" group).

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script

## Implementation details

1. SKILL.md frontmatter description triggers: "address my review notes", "review notes", "handle my
   diff comments" — plus "use when the user asks to act on Delta Review notes".
2. Skill body (REQ-AGENT-7), numbered steps:
   1. Resolve repo root (`git rev-parse --show-toplevel`), branch (`--abbrev-ref HEAD`), common dir
      (`--git-common-dir`, join if relative — same JSONC/relative-path cautions as cluster-review).
   2. Read the notes file; if missing/empty → report "no notes" and stop.
   3. **Compute the effective work set (REQ-AGENT-4)**: parse the responses file too; a note is
      actionable iff its newest turn across both files is a reviewer turn and `status` ≠ resolved —
      never trust `status` alone (the extension may not be running) and never re-address a note the
      agent already responded to.
   4. For each actionable note: read the whole thread (turns + prior responses, oldest→newest); the
      newest reviewer turn is the instruction. Locate the target by `snapshot` content — treat
      `currentStartLine` as a hint only. `side: "base"` notes describe removed/old code (`snapshot`
      is the authoritative text); outdated notes include what the line was.
   5. Act on the code. Then append a response entry: ISO-8601 UTC `at`, concise `response` naming
      what changed and where, and an `anchor` (`file`, `line`, exact current line text as
      `snapshot`) whenever the addressed code has a clear location — always working-tree.
   6. Rules: NEVER write the notes file; only append to responses (read-modify-write the whole
      JSON; keep `version: 1`; preserve existing entries); one writer per file.
   7. Version-bump rule mirroring cluster-review SKILL.md:50: schema changes require bumping
      `version` and updating `src/notes.ts` in the same commit.
3. README: bullets-first style (short summary + skimmable bullets; developer detail stays in
   DEVELOPMENT.md).
4. DEVELOPMENT.md manual script — add scenarios covering: add note both sides, edit/delete,
   resolve/unresolve, reply-to-reopen, agent round-trip (hand-written response), anchor relocation,
   outdated via edit + via mark-reviewed (base progression), REVIEW NOTES navigation, clear
   resolved, branch switch, corrupt-file warnings.
5. **Full manual pass**: run the entire (old + new) manual test script in the F5 dev host; also
   glance at VS Code's built-in Comments panel to confirm threads appear there and nothing was
   built against it (REQ-PRESERVE-3). Fix anything found before completing the task.

## Testing suggestions

- Dry-run the skill by hand in a Claude Code session on this repo: create two notes in the dev
  host, prompt "address my review notes", confirm the agent finds the contract, edits code,
  responds with an anchor, and the extension shows the reply live — the full loop from mock 5A.
- Re-run `yarn test` (no changes expected) and the packaging path `yarn package` (skill files ship
  with the plugin, not the vsix — confirm the vsix builds regardless).

## Gotchas

- The skill must instruct reading `.vscode/settings.json` as JSONC if it needs the base branch —
  but it does NOT need it (notes are branch-keyed, not base-keyed); leave base-branch logic out.
- `at` timestamps: second precision is fine, but must be UTC ISO-8601 (`date -u +%FT%TZ`) — the
  extension sorts turns by it.
- Do not add cluster-review's file-listing behavior — the notes skill acts on code, it never groups
  files.
- Keep README changes out of the Settings section — no new settings exist.

## Verification checklist

- [ ] Skill dry-run loop succeeds end-to-end (note → agent → addressed → resolve).
- [ ] Full manual test script (existing + new scenarios) passes in the dev host.
- [ ] `yarn lint`, `yarn build`, `yarn test`, `yarn package` pass.
- [ ] End-to-end tests: Test exception applies (no e2e infrastructure exists — verify with unit
      tests plus manual verification in the F5 Extension Development Host): the full manual pass +
      skill dry-run above are the substitute verification.
