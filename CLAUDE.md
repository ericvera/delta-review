# CLAUDE.md

- Agent-facing skill docs (`plugin/skills/*/SKILL.md`): structure as a binding **Contract** section plus a separate, overridable **Default workflow** that references it; the audience is a model — keep it terse, every line normative or behavior-changing, no motivational prose. State each rule exactly once, in the Contract; a workflow step references the Contract section by name instead of restating it. `DEVELOPMENT.md` gets the same treatment.
- Never open a pull request for, or merge into another branch, any branch whose tree contains `.mise/` — that work is still in flight; run `/mise:next` on that branch to finish acceptance and cleanup first.
