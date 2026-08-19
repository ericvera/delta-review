# Review checklist

Answer every rule pass / fail / n-a against your diff before committing.

## Code

1. No leftover debug code — grep the diff for print/console/debugger statements and commented-out code.
2. Every new file has a colocated test, or the task cites a Test exception — list the new files.
3. No `REQ-*` identifiers in code, comments, tests, or strings — grep the diff.
4. Nothing changed outside the task's Files to modify/create (the progress log excepted) — compare the diff's file list against the task.
5. Changed behavior has a test that fails without the change — name it.

## Prose

6. Every comment explains why or a non-obvious what; none restates the code — read each added comment.
