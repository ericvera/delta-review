[infra] add a watch mode to delta:review-notes that picks up new notes without re-running the skill. (let's discuss proposed usage before proceeding)

## Investigation

- Skill is doc-only: plugin/skills/review-notes/SKILL.md (Contract 19–139, Default workflow 141–150). Plugin ships no scripts/hooks/commands.
- Watch mode slots into Default workflow: step 2 ends the pass on an empty work set (146), step 5 re-reads and repeats (149), step 6 reports (150). Watch waits instead of stopping.
- Trigger: actionability is the Work set timestamp rule (118–125). New notes and reviewer replies arrive as writes to `notes-<branch>.json`.
- Spurious wakeups certain: extension rewrites derived fields (status, outdated, current lines, anchors) into the notes file after each refresh (src/notesStore.ts:640-660) — including right after the agent responds. Watcher must recompute the work set, not trust mtime.
- Writes are atomic temp+rename and no-op saves are skipped (src/notesStore.ts:171-198); polling is safe.
- Open mechanism choice: Monitor until-loop vs `/loop` vs other; end condition; poll interval.
- Channel discipline (127–135) allows one status line plus blockers; a long-running watch needs a per-wake vs on-exit reporting rule.
- No schema change; no `version` bump. Plugin bump plugin/.claude-plugin/plugin.json (0.6.0), commit "plugin vX.Y.Z: …". Update SKILL.md description trigger phrases, README.md:87-88, DEVELOPMENT.md Review notes section and manual step 35 (261).
- No unit-testable code unless a helper script is added; verification is a manual/scripted loop run.

## Decisions

- Waiting: Claude Code's Monitor tool runs a shell until-loop that exits when the notes file's content changes; on wake the agent recomputes the Work set and re-waits if empty. Doc-only; no helper script. One extra wake per round from the extension's derived-field write-back is accepted.
- End: only when the user interrupts. No idle timeout.
- Reporting: one Channel-discipline status line per round that did work, plus blockers as they arise.

## Assumptions

- Invoked by an argument/phrase (e.g. `/delta:review-notes watch`, "watch my review notes"); the SKILL.md description gains that trigger.
- Watch is a Default workflow mode (overridable), with any binding rule it needs (e.g. per-round status line) stated once in the Contract.
- Change detection compares file content (hash), polled every few seconds; a missing notes file is waited on, not an error; a corrupt file still stops per the Contract.
- If the Monitor tool is unavailable, the skill does one normal pass and says watch mode is unavailable.
- Plugin minor bump plugin.json 0.6.0 → 0.7.0, commit "plugin v0.7.0: …"; README agent-loop bullets, DEVELOPMENT.md Review notes section and manual step 35 updated.
- Verification is a manual/scripted watch run; no unit tests (no code).

## Proposal

Issue: delta:review-notes stops after one pass, so new reviewer notes need the skill re-run.
Approach: add a `watch` Default-workflow mode that, after a pass, waits via a Monitor until-loop on notes-file content change, recomputes the Work set, handles it, prints one status line per round, and runs until interrupted; docs + plugin 0.7.0.
Skips: spec and critic (doc-only, one skill file, no schema/API change, easily undone).
