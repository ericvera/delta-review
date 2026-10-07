# Review

- 01_01 review-notes watch mode (5d573aa, 8e539ec, fix 9aa874f): SKILL.md gains a Watch mode (entered by `watch` arg/reply or `${user_config.always_watch}`), Monitor until-loop on `git hash-object` of the notes file (3s poll, `timeout_ms` 1800000, silent re-arm on expiry), work-set recompute per wake, one status line per round, end-of-pass `watch` offer; plugin.json 0.7.0 + `userConfig.always_watch` (boolean, default false); README bullet; DEVELOPMENT.md notes + manual step 35. Verify: `claude plugin validate plugin`; run `/delta:review-notes watch`, add a note in the extension, confirm a reply and one status line; idle >30 min then add a note; toggle Always watch in `/plugin configure` and run without `watch`.

## Open assumptions

- Missing notes file is waited on in watch mode; corrupt file still stops.
- No Monitor tool → one normal pass plus a "watch mode unavailable" line.
- The extension's derived-field write-back causes one extra wake per round (accepted).
- Settings wording says `/plugin configure`; current docs may show plugin options under `/config` rows.

## Amendments

- none
