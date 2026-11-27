I am finding that there are some directories that I keep marking reviewed, but not reading (e.g. .mise/ directory). Let's work no possible designs to have certain directories not count towards the badge and show somewhere that signals that we are not actively reviewing certain files. Also, I would like to get a sense of where we are in a long process. Like for instance, when running mise I sometimes ask for an ETA... or perhaps number of tasks left vs completed. Not sure, but wanting to have a sense of progress. Also not sure if this is something that could be exposed here of perhaps as part of aydy is would be better.

## Investigation

- Exclusion mechanism exists: auto triage. `src/triage.ts:9` classifies paths as `auto` from `deltaReview.autoReview.globs` (`package.json:712`) plus linguist-generated `.gitattributes`; model calls it at `src/model.ts:698`, stored as `ReviewFile.triage` (`model.ts:105`, `:799`). A `.mise/**` glob works today; `.vscode/settings.json` sets no globs.
- Auto files still count toward the badge: `publishModel` (`src/extension.ts:566-576`) counts every file for `treeView.badge` and status bar `Review x/y`. Group count `src/treeProvider.ts:430` (`filesWithStatus`, `:764-776`) includes them, documented at `DEVELOPMENT.md:130` — must be updated.
- Auto subgroup row: `treeProvider.ts:444-460` (ungrouped), `:698-707` (grouped); default-collapsed (`:153-156`); contextValue from `autoGroupContextValue`. Dim styling in `src/decorations.ts:48-122`.
- Auto-mark: `extension.ts:700-712` writes review refs for auto files when `autoReview.markAutomatically` is on.
- Folder bulk actions exclude auto files (`extension.ts:1785-1802`); Mark All includes them.
- Agent-side alternative: clusters contract `levels` (`skim`) at `plugin/skills/cluster/SKILL.md:190`, `src/reviewLevel.ts:3`. A contract exclusion key would follow the ungated-key pattern (`src/clusters.ts:597-602`, `DEVELOPMENT.md:144`) plus SKILL.md update.
- Badge test: `extension.ts:2906` exposes `notesBadge` to scripted host check; file badge has no pure helper — counting logic should be extracted into a pure function.
- Progress: extension has no task/ETA source; reads only git and its own contract files under git common dir (`DEVELOPMENT.md:136`). Existing progress surface: status bar item (`extension.ts:389-393`, text `:576`). Mise state lives in `.mise/` (`goals.md`, `tasks/`, `tasks/done/`); extension never reads it.
- "aydy" matches nothing in tracked files.
- Contradiction: goals imply no way to exclude directories; `autoReview.globs` exists — the gap is that excluded files still count in badge, status bar, group counts.

## Decisions

- Exclusion is declared by the existing `deltaReview.autoReview.globs` setting (plus linguist-generated `.gitattributes`); no new setting or contract key.
- Auto-triaged files stop counting toward the tree badge, the status bar `Review x/y`, and group counts. No other display change: the Auto subgroup stays as-is.
- AYDY is a separate tool (its own repo under ~/Code) that signals when agents are done and sets status on VS Code window tabs.

- Long-run progress / ETA is dropped from this run (out of scope).

## Assumptions

- "Group counts" means the per-group file counts in the tree (`filesWithStatus`); the Auto subgroup row keeps its own count of auto files.
- Mark All, folder bulk actions and `autoReview.markAutomatically` keep their current behavior.
- When every non-auto file is reviewed and only auto files remain, the badge is cleared and the status bar shows full progress.
- The counting logic moves into a pure, VS Code-free helper with a colocated Vitest test; `DEVELOPMENT.md:130` is updated to the new rule.
- No mock: a count change is not a tree-structure, view, panel or command change under the config's Mock conditions.

## Proposal

- Issue: files matched by `autoReview.globs` (e.g. `.mise/**`) still inflate the badge, status bar `Review x/y` and group counts.
- Approach: exclude auto-triaged files from those three counts through a pure, tested helper, and update DEVELOPMENT.md; no other UI change.
- Skips: spec and critic (one module, no API or contract change).

## Amendments

- 2026-11-27 Remove the `deltaReview.autoReview.markAutomatically` setting and the auto-mark behavior it gates (contribution in package.json, the auto-mark code path, docs, tests); first confirm nothing else depends on auto files being marked reviewed (Mark All, notes, Branch overview, bulk actions) and report any dependency instead of removing it — auto files no longer affect counts, so auto-marking is redundant — tasks: next planned id
