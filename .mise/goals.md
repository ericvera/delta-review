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

## Open questions

1. Waiting mechanism.
2. How watch mode ends.
3. Reporting cadence while watching.
