# 01_01 Review-notes watch mode

## Goal

Add a watch mode to the `delta:review-notes` skill: after a pass, instead of stopping, the agent waits for the notes file to change, recomputes the Work set, handles any actionable notes, prints one status line per round that did work, and repeats until the user interrupts. Entered via a `watch` argument/reply or a new plugin `userConfig` option `always_watch`. Ship as plugin v0.7.0 with docs updated.

## Files to modify/create

- `plugin/skills/review-notes/SKILL.md`
- `plugin/.claude-plugin/plugin.json`
- `README.md`
- `DEVELOPMENT.md`

## Background

- The plugin is doc-only: no scripts, hooks or commands. Do not add a helper script.
- `plugin/skills/review-notes/SKILL.md` structure: frontmatter `description` (lines 3-12), Contract (19-139) with `### Work set` (118-125) and `### Channel discipline` (127-135), then `## Default workflow: addressing the notes` (141-150). Step 2 ends the pass on an empty work set (146), step 5 re-reads and repeats (149), step 6 reports (150).
- Actionability is the Work set timestamp rule; new notes and reviewer replies arrive as writes to `notes-<sanitized-branch>.json` (path per Contract `### Files`).
- The extension writes the notes file atomically (temp + rename) and skips no-op saves (`src/notesStore.ts:171-198`), so polling its content is safe. After every refresh it rewrites derived fields (`status`, `outdated`, `currentStartLine/EndLine`, anchors) into the notes file (`src/notesStore.ts:640-660`) — including right after the agent writes a response. So a content change does NOT imply new work: on every wake, recompute the Work set and re-wait if empty. One extra wake per round from this write-back is accepted.
- Prior plugin bumps are their own commit with subject `plugin vX.Y.Z: <summary>` (e.g. `3ca76be plugin v0.5.0: review-notes contract documents the archive file`). Current `plugin/.claude-plugin/plugin.json` version is `0.6.0`.
- README agent-loop bullets: `README.md:87-88` ("Agent loop:" section).
- DEVELOPMENT.md: `### Review notes` section (line ~132) and manual test step 35 (line ~261, "Agent round-trip").

Design decisions (owner-approved, binding):

- Waiting mechanism: Claude Code's Monitor tool runs a shell until-loop that polls every few seconds and exits when the notes file's content hash differs from the hash taken at the start of the wait. A missing notes file is waited on (treated as a hash of "absent"), not an error. A corrupt notes file on wake still stops per the Contract.
- On wake: re-read per the Contract, recompute the Work set; empty → wait again; otherwise run the normal workflow steps 2-5 for that round.
- End: only when the user interrupts. No idle timeout.
- Reporting: one Channel-discipline status line per round that did work, plus blockers as they arise. Rounds with no work print nothing.
- Entry: watch mode starts when the skill is invoked with `watch` (e.g. `/delta:review-notes watch`, "watch my review notes") or when `${user_config.always_watch}` is on. Otherwise the normal pass ends its report by offering: "Reply `watch` to keep watching — or turn on *Always watch* in `/plugin configure`."
- If the Monitor tool is unavailable, do one normal pass and say watch mode is unavailable.
- `always_watch`: a `userConfig` entry in `plugin.json`, default off, read in the SKILL.md body via `${user_config.always_watch}` substitution; the user sets it with `/plugin configure`. Docs: https://code.claude.com/docs/en/plugins/manifest-reference.md#user-configuration
- Watch is a Default workflow mode (overridable). Any binding rule it needs (the per-round status line) is stated once, in the Contract's Channel discipline. No notes/responses schema change; no `version` bump.

## Guides

- DEVELOPMENT.md (doc): build/run/packaging, how review state works internally, manual test script
- plugin/skills/review-notes/SKILL.md (doc): the notes/responses contract files — read before changing review notes or their file format

## Implementation details

1. `plugin/.claude-plugin/plugin.json`:
   - Fetch the manifest-reference docs URL above. Add `userConfig.always_watch` with title "Always watch", a one-line description, and default off. Use `type: "boolean"` if the docs support it; otherwise a string with `"yes"`/`"no"` and default `"no"`. Determine from the docs what an unset value substitutes to in `${user_config.always_watch}` and word the SKILL.md check accordingly (e.g. "watch mode is on if `${user_config.always_watch}` reads `true`; anything else, including an unsubstituted placeholder, is off").
   - Bump `version` to `0.7.0`.
2. `plugin/skills/review-notes/SKILL.md`:
   - Frontmatter `description`: add watch triggers ("watch my review notes", "keep watching for review notes", `/delta:review-notes watch`) without dropping existing ones.
   - Contract `### Channel discipline`: add one rule — when a driver keeps running across rounds, each round that did work emits its own status line; rounds with no work emit nothing; blockers as they arise. Adjust the "questions asked; reply in Delta Review and re-run" wording so it does not tell a watching user to re-run (e.g. "re-run" applies only when the pass ends).
   - Default workflow: add the end-of-pass offer to step 6 (only when not already watching), and add a watch-mode subsection or step (after step 6) covering: entry conditions (`watch` arg/reply, `${user_config.always_watch}`), the Monitor until-loop (give a short bash snippet: compute notes path per Contract Files; hash with `shasum` or `git hash-object` falling back to a fixed token when the file is missing; `until [ "$(hash)" != "$START" ]; do sleep 3; done`), recompute-and-re-wait on wake, run steps 2-5 then the per-round status line, loop until interrupted, Monitor-unavailable fallback. Reference Contract sections by name; do not restate their rules (CLAUDE.md).
   - Keep it terse: every line normative, no motivational prose.
3. `README.md` agent-loop bullets (87-88): add one bullet — say "watch my review notes" (or `/delta:review-notes watch`) to keep the agent picking up new notes and replies until interrupted; *Always watch* in `/plugin configure` makes it the default.
4. `DEVELOPMENT.md`:
   - `### Review notes`: one bullet/sentence stating the skill's watch mode polls the notes file's content (not mtime) and recomputes the Work set on every change because derived-field write-backs cause spurious wakes.
   - Manual step 35 (plain integer-numbered list; extend step 35 with a sentence rather than renumbering): run `/delta:review-notes watch`, add a note in the diff → the agent replies without being re-invoked; reply & reopen → it answers again; a round with only derived-field rewrites prints nothing.
5. Commits: one commit for the skill/docs change, then a separate `plugin v0.7.0: review-notes watch mode` commit for the version bump (or a single commit with that subject if the `userConfig` addition and bump are inseparable — keep the `plugin v0.7.0:` subject either way).

## Gotchas

- `.mise/` and `.claude/` must stay in `.prettierignore`; run `yarn format` but do not let it touch `.mise/`.
- The notes file is read-only for the agent: the watch loop must only read/hash it, never touch it.
- Do not trust `status` or mtime to decide work; the Work set rule decides.
- The wait loop runs through the Monitor tool, not a foreground Bash `sleep` (foreground sleep is blocked).
- Do not invent `userConfig` fields; confirm field names against the docs URL.
- No `.ts` source changes; no new tests are needed (Test exception: doc-only change).

## Verification

- Run Check: `yarn lint`, `yarn build`; and `yarn test` (unchanged suite stays green).
- `node -e 'JSON.parse(require("fs").readFileSync("plugin/.claude-plugin/plugin.json","utf8"))'` parses; if `claude plugin validate plugin` is available, it passes.
- Substitute check for the wait loop (no unit test covers it): in the scratchpad, run the exact bash snippet from SKILL.md against a temp file path — (a) file missing → loop keeps waiting; create the file → loop exits; (b) restart with file present, rewrite with identical content via temp+rename → loop keeps waiting; change content → loop exits. Record the outcome in the commit/progress notes.
- Re-read the SKILL.md diff against CLAUDE.md rules: each rule stated once in the Contract; workflow references Contract sections by name.
