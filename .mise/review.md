# Review

## Tasks

- 01_01 `src/diffBase.ts`: per-branch base resolution (explicit file → reflog/ahead-behind detection → setting), stale check. Verify: `yarn test src/diffBase.test.ts` (real-repo stacked, tag-shadowed, rebase cases).
- 01_02 refresh resolves the base; new status-bar base item; `MergeBaseError` keeps the item and a source-aware hint. Verify: F5 on a stacked branch — tooltip shows source; set a bogus base → error tint + tree message.
- 01_03 base picker (`deltaReview.setBranchBase`, `useAutomaticBase`); welcome links on missing base / no merge-base. Verify: click the base item; pick a branch, enter a ref, use automatic detection.
- 01_04 stale-base prompt (Switch / Keep / Choose…), warning tint only while unanswered, dismissals per branch/base. Verify: DEVELOPMENT.md manual step 8d.
- 01_05 docs: cluster SKILL.md `### Diff base` contract + resolver snippet, README, DEVELOPMENT.md, setting description. Verify: read SKILL.md Diff base section.
- 02_01 compare-and-set review-state writes with retry; distinct moved/locked conflicts. Verify: `yarn test src/reviewState.test.ts`.
- 02_02 refresh scheduler: 400 ms debounce capped at 1.5 s, self-writes ignored, git events only on HEAD change. Verify: mark a file — one refresh, no cascade.
- 02_03 optimistic marks (flat and grouped), rollback with Retry / Show Log, no-op reasons. Verify: mark/unmark rapidly; `chmod -R a-w .git/refs/review` then mark (restore after).
- 03_01 notes v3 (`scope: file|general`), written only while a scoped note exists. Verify: `yarn test src/notes.test.ts src/notesStore.test.ts`.
- 03_02 whole-file comment threads (no range), "file left the diff" outdated label. Verify by eye: File note shows at the top of the diff editor.
- 03_03 General note conversation tab (webview, reused per note, draft mode, closes on delete). Verify: open a General note, reply, resolve, delete.
- 03_04 pane title `+` (File note / General note), General notes group first, File note rows read "file". Verify: `+` placement, disabled File note reason, save a File note.
- 03_05 docs: review-notes SKILL.md v3 contract + archive, README, DEVELOPMENT.md (incl. full `__inspect` list).

## Reviewer minors (not fixed)

- `src/generalNoteHtml.ts:172` binds any `[data-action]`, including raw HTML in rendered note bodies → a body could inject a working Resolve/Delete button.
- `src/basePicker.ts:58` uses `%(refname:short)`; tag-shadowed branches appear as `heads/x` (spec requires `lstrip=2`).
- README.md:102 "Click a note…" doesn't cover File/General notes.
- DEVELOPMENT.md:249 grouping order omits the General notes group.
- cluster SKILL.md frontmatter has no trigger for setting/checking a branch's diff base.

## Open assumptions

- "General note" is the user-facing name; conversation tab is a webview.
- "Current file" = active editor file in the diff; otherwise File note is disabled with a reason.
- Base file `<common dir>/delta-review/base-<branch>.json` records `branch`; a mismatched file is ignored.
- Detection uses `%(ahead-behind)` (git ≥ 2.41) with a per-branch fallback on older git.
- Notes archive stays version 1 with scoped entries.
- Stale prompt waits until the base is off the fallback's first-parent chain; Keep saves the base explicitly.

## Amendments

- None.
