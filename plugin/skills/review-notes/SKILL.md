---
name: review-notes
description: >-
  Work with the reviewer's inline review notes written in the Delta Review VS
  Code extension. Default behavior: address them — read the notes contract,
  fix the code each note asks about, and reply through the responses contract
  file. Use when the user asks to address my review notes, handle my diff
  comments, respond to review notes, or otherwise act on Delta Review notes —
  and as the contract reference whenever any task or skill needs to read from
  or respond to Delta Review notes files for any purpose (summarizing,
  triaging, discussing, driving fixes). Requires a git repository with a
  feature branch.
---

# Review Notes

Two JSON files per branch form the contract: a **notes file** the extension writes and you read, and a **responses file** you write and the extension reads — one writer per file. Loop: the reviewer notes diff lines → you fix the code and append a response per note → the extension shows your reply, flips the note to **Addressed**, and relocates it via your anchor.

## Contract

Binding for every consumer of these files, whatever workflow or skill is driving.

### Files

Work from the repo root (`git rev-parse --show-toplevel`, `cd` there):

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMON_DIR=$(git rev-parse --git-common-dir)   # may be relative (".git") — resolve against the repo root
```

Sanitize the branch for filenames with regex `[^A-Za-z0-9._-]` → `-` (`feature/x` → `feature-x`; matches the extension's `sanitizeBranchForFilename`).

- Notes: `<COMMON_DIR>/delta-review/notes-<sanitized-branch>.json`
- Responses: `<COMMON_DIR>/delta-review/responses-<sanitized-branch>.json`

Files are keyed by branch only — no base branch or VS Code settings needed. Never commit, push, or stage either file; they live under the git directory, invisible to `git status`, and must stay that way.

### Notes file (read-only)

Never write, reformat, or repair the notes file. If it exists but is not valid JSON, report that to the user and stop.

```json
{
  "version": 1,
  "notes": [
    {
      "id": "a1b2c3",
      "file": "src/api.ts",
      "side": "working",
      "startLine": 12,
      "endLine": 14,
      "snapshot": ["const x = fetchUser();", "use(x);", "done();"],
      "contentBlob": "<sha>",
      "turns": [
        { "text": "Handle the error case here", "at": "2026-07-18T20:00:00Z" }
      ],
      "status": "open",
      "outdated": false,
      "currentStartLine": 12,
      "currentEndLine": 14,
      "createdAt": "2026-07-18T20:00:00Z"
    }
  ]
}
```

- `turns` — reviewer messages, oldest first. The newest reviewer turn is the instruction; earlier turns and your prior responses are context.
- `snapshot` — exact text of the noted lines at note time, one entry per line; the authoritative locator — search the file for it. `currentStartLine`/`currentEndLine` are hints refreshed only while the extension runs; never trust them over content.
- `side: "working"` — the note is on current code in `file`. `side: "base"` — it is on old/removed code from the diff's left side; that text may no longer exist anywhere, so address the intent of what replaced it (or its deletion).
- `outdated: true` — the noted lines changed after the note was written; `snapshot` is what they were.
- `status`, `contentBlob`, `appliedAnchorAt` — extension bookkeeping; `status` matters only in the work-set rule below.

### Responses file (write)

```json
{
  "version": 1,
  "responses": [
    {
      "noteId": "a1b2c3",
      "response": "Wrapped the fetch in a try/catch and surfaced the error — src/api.ts",
      "at": "2026-07-18T20:05:00Z",
      "anchor": {
        "file": "src/api.ts",
        "line": 13,
        "snapshot": "} catch (error) {"
      }
    }
  ]
}
```

Append-only: never edit or remove existing entries; multiple entries per `noteId` are normal (each is one agent turn in the thread). To write, read-modify-write the whole JSON — keep `"version": 1`, preserve every existing entry, append yours — atomically: serialize to a temp file in the same `delta-review` directory, then rename over the responses file (the extension watches the directory). If the file exists but is corrupt, stop and tell the user; a missing file just means no responses yet.

Parser rejections (one bad entry rejects the whole file; the reviewer sees a warning instead of your replies):

- `version` must be exactly the integer `1`; `responses` must be an array.
- Each entry: an object with non-empty string `noteId`, non-empty string `response`, non-empty string `at`.
- `anchor` optional; when present: non-empty string `file`, integer `line` >= 1, string `snapshot`.

Silent failures — not rejected, so you must get these right:

- `at`: ISO-8601 UTC (`date -u +%FT%TZ`, second precision fine). Thread turns sort by it, so a bogus timestamp misorders the thread and can make a note look unhandled.
- `noteId` not matching an existing note → entry silently dropped.
- `anchor.file`: repo-relative, `/`-separated — never absolute, no `\`, no `.` or `..` segments. `anchor.line`: 1-based in the current working tree. Bad path shape, missing file, or out-of-range line → dangling: your response text still shows, but the note is not relocated.
- `anchor.snapshot` is not validated against the file — it is stored as-is as the note's new authoritative `snapshot`. It must be the exact current text of `anchor.line`; a wrong value still relocates the note and silently corrupts its anchor.

Entry conventions: `response` is concise — what you changed and where, written for a human reading a comment thread. Include `anchor` whenever the addressed code has a clear location (working-tree coordinates); omit it only when there is none (code deleted, change spans many places).

### Work set

Any driver that responds to notes must compute the work set this way. A note is **actionable** iff:

- `status` is not `"resolved"`, and
- the newest turn across both files is a reviewer turn — the latest `at` in the note's `turns` is newer than every one of your response entries for that `noteId`.

Never trust `status` alone (the extension that refreshes it may not be running); the timestamp comparison is what prevents re-addressing a note you already answered.

### Schema changes

Changing the schema requires bumping `version` and updating the extension's parser (`src/notes.ts` in the delta-review repo) in the same commit — the extension rejects any version other than 1.

## Default workflow: addressing the notes

The default when the user asks to address their review notes; other skills or instructions may drive different behavior on the same contract (summarize, triage, custom fix policies) — the Contract still governs all file access. Explain-only replies are legitimate: a response entry is just a turn, with or without a code change.

1. **Locate and read the notes** per the Contract. Missing file or empty `notes` array → report "no review notes on this branch" and stop. Corrupt JSON → stop per the Contract.
2. **Compute the work set** from both files per the Contract.
3. **Address each actionable note**: read its whole thread (`turns` plus your prior responses, interleaved oldest → newest by `at`), locate the target per the Contract's reading semantics, and make the change the newest reviewer turn asks for, following project conventions.
4. **Respond**: append one entry per note handled, per the Contract's entry conventions and write rules.
5. **Report** to the user: each note addressed (file, what it asked, what you changed) and any skipped (already resolved, awaiting the reviewer, or not actionable — say so in a response entry too, so the thread shows it).
