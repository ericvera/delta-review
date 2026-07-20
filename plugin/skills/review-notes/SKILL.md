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

Work with the inline review notes a human wrote in the Delta Review VS Code extension. Two JSON files per branch make up the contract:

- **Notes file** — extension-owned. You only ever **read** it. Never write, reformat, or "fix" it, even if it looks wrong.
- **Responses file** — agent-owned. You reply by appending entries to it; the extension is the only reader. One writer per file.

The loop: the reviewer writes notes on diff lines → you fix the code and append a response per note → the extension shows your reply in the thread, flips it to **Addressed**, and relocates the note to where your fix landed (via the anchor you provide). The reviewer then resolves it or replies to reopen.

## Contract

This section is binding for every consumer of these files, whether you are following the default workflow below or being driven by other skills or instructions.

### Locating the contract files

Work from the repository root: `git rev-parse --show-toplevel`, and `cd` there.

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMON_DIR=$(git rev-parse --git-common-dir)   # may be relative (".git") — resolve against the repo root
```

Sanitize the branch name for the filenames: replace every character outside `[A-Za-z0-9._-]` with `-` (regex `[^A-Za-z0-9._-]` → `-`; `feature/x` becomes `feature-x`), matching the extension's `sanitizeBranchForFilename` exactly.

- Notes: `<COMMON_DIR>/delta-review/notes-<sanitized-branch>.json`
- Responses: `<COMMON_DIR>/delta-review/responses-<sanitized-branch>.json`

You do not need the base branch or any VS Code settings — notes are keyed by branch only.

Never commit or push either contract file, and never add them to the working tree or the index — they live under the git directory (`.git/delta-review/`), invisible to `git status`, and must stay that way.

### Schemas (version 1)

Notes file (you read this):

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

How to read a note:

- `turns` — the reviewer's messages, oldest first. The **newest reviewer turn is the instruction**; earlier turns and your own prior responses are context.
- `snapshot` — the exact text of the noted lines at note time, one entry per line. This is the authoritative way to find the target: search the file for it. `currentStartLine`/`currentEndLine` are hints the extension refreshes **only while it is running** — never trust them over content.
- `side: "working"` — the note is on current code in `file`. `side: "base"` — the note is on old/removed code shown on the left of the diff; `snapshot` is that old text, which may no longer exist anywhere. Figure out what replaced it (or that it was deleted) and address the intent.
- `outdated: true` — the noted lines changed after the note was written; `snapshot` shows what the line was when noted.
- `status`, `contentBlob`, `appliedAnchorAt` — extension bookkeeping. `status` matters only as part of the work-set rule below; everything else you can ignore.

If the notes file exists but is not valid JSON, report that to the user and stop — never repair or rewrite the notes file.

Responses file (you write this):

```json
{
  "version": 1,
  "responses": [
    {
      "noteId": "a1b2c3",
      "status": "addressed",
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

Entries only ever **accumulate** — multiple entries per `noteId` are normal (each becomes one agent turn in the thread). Never edit or remove existing entries.

Rules the extension's parser rejects (one violating entry rejects the whole file, and the reviewer sees a warning instead of your replies):

- `version` must be exactly the integer `1`; `responses` must be an array.
- Each entry must be an object with non-empty string `noteId`, `status` exactly `"addressed"`, non-empty string `response`, and non-empty string `at`.
- `anchor` is optional; when present it must have a non-empty string `file`, an integer `line` >= 1, and a string `snapshot`.

Conventions you must follow anyway — the extension does not reject these, it fails silently instead:

- `at` must be an ISO-8601 UTC timestamp (`date -u +%FT%TZ`; second precision is fine). The extension sorts thread turns by it — a bogus timestamp misorders the conversation and can make a note look unhandled.
- `noteId` must be the id of an existing note; entries with unknown ids are silently dropped.
- `anchor.file` must be a repo-relative, `/`-separated path — never absolute, no `\`, no `.` or `..` segments. `anchor.line` is 1-based in the **current working tree**. An anchor with a bad path shape, a missing file, or an out-of-range line is treated as dangling: your response text still shows, but the note is not relocated. Those are the only checks — `anchor.snapshot` is **not** validated against the file. It is stored as-is as the note's new authoritative `snapshot`, so it must be the exact current text of `anchor.line`; a wrong snapshot still relocates the note and silently corrupts its anchor content.

### Writing responses

Writing the file: read-modify-write the **whole** JSON — keep `"version": 1`, preserve every existing entry, append yours. Write atomically: serialize to a temporary file in the same `delta-review` directory, then rename it over the responses file (the extension watches the directory and may read at any moment).

If the responses file exists but is corrupt, stop and tell the user rather than clobbering it (a missing file just means no responses yet).

Response entry conventions:

- `at`: current UTC time, ISO-8601 (`date -u +%FT%TZ`).
- `response`: concise — what you changed and where. Written for a human reading a comment thread.
- `anchor`: include one whenever the addressed code has a clear location — `file` (repo-relative), `line`, and the exact current text of that line as `snapshot`, always working-tree coordinates. Omit it only when there is no single sensible location (e.g. the fix was deleting the code, or it spans many places).

### The work set

Any driver that responds to notes must compute the work set this way — no exceptions. A note is **actionable** iff both:

- its `status` is not `"resolved"`, and
- the **newest turn across both files** is a reviewer turn — i.e. the latest `at` among the note's `turns` is newer than every one of your response entries for that `noteId`.

Never trust `status` alone: it is refreshed by the extension, which may not be running. Comparing turn timestamps is what prevents re-addressing a note you already responded to.

### Changing the schema

If you ever need to change this schema, you must bump `version` and update the extension's parser (`src/notes.ts` in the delta-review repo) in the same commit; the extension rejects any version other than 1.

## Default workflow: addressing the notes

This is the default behavior when the user asks to address their review notes; other skills or instructions may drive different behavior on the same contract (summarize, triage, explain without code changes, custom fix policies) — the Contract section above still governs all file access. Responding without a code change is legitimate: a response entry is just a turn in the thread, and explain-only replies are fine.

### 1. Locate and read the notes

Resolve the contract file paths per the Contract section. If the notes file is missing, or parses with an empty `notes` array, report "no review notes on this branch" and stop. If it is corrupt JSON, stop as the Contract requires.

### 2. Compute the work set

Read the responses file too and apply the Contract's work-set rule to find the actionable notes.

### 3. Address each actionable note

For each actionable note:

1. Read the whole thread — the note's `turns` plus your prior responses for that id, interleaved oldest → newest by `at`. The newest reviewer turn is the instruction.
2. Locate the target by searching for the `snapshot` content; treat `currentStartLine` as a hint only. Remember `side: "base"` snapshots describe old code and `outdated` snapshots describe what the line was.
3. Make the code change the note asks for, following the project's conventions as you would for any edit.

### 4. Respond

Append one entry per note you addressed, following the Contract's response entry conventions and its atomic read-modify-write rule.

### 5. Report

Tell the user what you did: each note addressed (file, what the note asked, what you changed), any notes you skipped and why (already resolved, already responded and awaiting the reviewer, or could not be acted on — say so in the response entry too, so the thread shows it).
