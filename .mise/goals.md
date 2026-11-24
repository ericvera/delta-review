I have another skill that defines different uses for the functionalities in delta review. An agent there gave the following suggestion "In delta:cluster: a line saying a calling skill's rules replace its defaults for grouping, order, levels and notes content. The notes document shape shrinks to the title and whatever the caller asks for, with the Reading order section gone.". I think delta:cluster should have a way to run with guidance from the user or another agent/skill

## Investigation

- Doc-only change; the extension parses none of the behavior involved.
- Main file: plugin/skills/cluster/SKILL.md — frontmatter triggers (:3-13), "Two situations" (:20-23), Contract heading "Binding for every consumer… whatever workflow is driving" (:25-27), Default workflow (:213-269).
- Rules a caller would override, current locations: grouping/narrative (workflow step 6, :251-261); `files` order = reading order (:207, :259); levels (:170-174); notes content (:158-168); wait (:176-181); document shape — title, intro, `## Reading order`, `## Check` (:189).
- Precedent: plugin/skills/review-notes/SKILL.md:151 — Default workflow intro says other skills/instructions may drive different behavior; the Contract still governs file access. Cluster has no such sentence.
- CLAUDE.md:3 — binding Contract + overridable Default workflow, each rule once. Levels, notes content and document shape currently sit in the Contract (:158-190), binding for every consumer (:27); they must move to the workflow or get an explicit caller-overridable carve-out.
- Document shape is free to the extension: it finds/renders markdown by path/slug (DEVELOPMENT.md:144-147, :219-221). Nothing parses `## Reading order`; only a test fixture (src/documents.test.ts:62-75). No code change needed.
- Sidebar list mode uses `files` order (SKILL.md:207; README.md:71), so caller-defined order changes the sidebar too.
- Never caller-overridable: schema/validation (:90-116), location (:31-40), atomic write (:199-201), move/extraction evidence (:124-156), document slug and rename/delete reply duty (:188-190).
- Hard to undo: document deletes under the git dir (:185); rename/delete of notes files must reply to open review notes first (:190). No schema/API change.
- Release: skill-only changes bump plugin/.claude-plugin/plugin.json `version` (0.11.0 → 0.12.0); extension package.json (0.17.0) unchanged.
- No Vitest test applies (no src change); checks are yarn lint / yarn build.

## Decisions

- Guidance sources: `/delta:cluster` arguments, the user's message, or a calling skill's instructions. Precedence: user > calling skill > defaults.
- Guidance may replace everything not binding: grouping, `files` order, levels, wait flags, label length, the no-junk-drawer rule, notes content and document shape. Always binding regardless of guidance: schema/validation, location, atomic write, move/extraction evidence, document slug, rename/delete reply duty.
- Under guidance the notes document is a title plus whatever sections the guidance asks for; `## Reading order` and `## Check` appear only if requested.

## Assumptions

- Overridable rules move out of the Contract into the Default workflow (or the Contract marks them as defaults), per CLAUDE.md's Contract/Default-workflow rule; each rule stated once.
- Wording follows the review-notes precedent (plugin/skills/review-notes/SKILL.md:151).
- The workflow's final report step still applies under guidance unless the guidance says otherwise.
- Frontmatter description gains a trigger for running with caller/user guidance.
- plugin/.claude-plugin/plugin.json bumps 0.11.0 → 0.12.0; extension version unchanged; no src or test change.
- No mock: no extension UI change.

## Proposal

Issue: delta:cluster's Contract hard-binds grouping, order, levels, wait, notes content and document shape, so a user or calling skill can't steer them.
Approach: in plugin/skills/cluster/SKILL.md, keep file-integrity rules binding, move the rest to the Default workflow as defaults that guidance (user > calling skill > defaults) replaces, shrink the guided notes document to title + requested sections; bump plugin to 0.12.0.
Skips: spec and critic (single doc file, no schema/API change).
