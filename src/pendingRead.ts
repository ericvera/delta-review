import type { AnyNoteThread } from "./noteThreads";

// Pending-note read state: which agent turn the reviewer last marked read,
// keyed per repo and branch, plus the pruning that keeps the workspace-state
// map bounded. Pure module — no vscode, no git; the caller supplies the live
// branch set and persists the result.

// noteId → `at` of the agent turn the reviewer marked read
export type PendingReadMarks = Readonly<Record<string, string>>;

// branch → marks
export type BranchReadMarks = Readonly<Record<string, PendingReadMarks>>;

// repoRoot → branch marks
export type RepoReadMarks = Readonly<Record<string, BranchReadMarks>>;

// `git rev-parse --abbrev-ref HEAD` prints `heads/<name>` when a tag shares
// the branch's name; live branches are bare `refs/heads/` names, so an
// unstripped key would be pruned as dead once the reviewer switches away.
export const readMarkBranch = (branch: string): string =>
  branch.startsWith("heads/") ? branch.slice("heads/".length) : branch;

export const newestAgentTurnAt = (
  thread: AnyNoteThread,
): string | undefined => {
  for (let index = thread.turns.length - 1; index >= 0; index--) {
    const turn = thread.turns[index];
    if (turn !== undefined && turn.author === "agent") {
      return turn.at;
    }
  }
  return undefined;
};

export const isPendingUnread = (
  thread: AnyNoteThread,
  marks: PendingReadMarks,
): boolean =>
  thread.status === "pending" &&
  marks[thread.note.id] !== newestAgentTurnAt(thread);

export const withReadMark = (
  marks: PendingReadMarks,
  thread: AnyNoteThread,
): PendingReadMarks => {
  const at = newestAgentTurnAt(thread);
  if (at === undefined) {
    return marks;
  }
  return { ...marks, [thread.note.id]: at };
};

export const prunedReadMarks = (
  marks: PendingReadMarks,
  threads: readonly AnyNoteThread[],
): PendingReadMarks => {
  const ids = new Set(threads.map((thread) => thread.note.id));
  const kept = Object.entries(marks).filter(([id]) => ids.has(id));
  if (kept.length === Object.keys(marks).length) {
    return marks;
  }
  return Object.fromEntries(kept);
};

export const prunedBranchMarks = (
  all: BranchReadMarks,
  branch: string,
  threads: readonly AnyNoteThread[],
  liveBranches: ReadonlySet<string> | undefined,
): BranchReadMarks => {
  let changed = false;
  const next: Record<string, PendingReadMarks> = {};
  for (const [key, marks] of Object.entries(all)) {
    if (
      key !== branch &&
      liveBranches !== undefined &&
      !liveBranches.has(key)
    ) {
      changed = true;
      continue;
    }
    const pruned = key === branch ? prunedReadMarks(marks, threads) : marks;
    if (pruned !== marks) {
      changed = true;
    }
    if (Object.keys(pruned).length === 0) {
      changed = true;
      continue;
    }
    next[key] = pruned;
  }
  return changed ? next : all;
};

export const marksFor = (
  all: RepoReadMarks,
  repo: string,
  branch: string,
): PendingReadMarks => all[repo]?.[branch] ?? {};

export const withRepoReadMark = (
  all: RepoReadMarks,
  repo: string,
  branch: string,
  thread: AnyNoteThread,
): RepoReadMarks => {
  const current = marksFor(all, repo, branch);
  const next = withReadMark(current, thread);
  if (next === current) {
    return all;
  }
  return { ...all, [repo]: { ...all[repo], [branch]: next } };
};

export const prunedRepoMarks = (
  all: RepoReadMarks,
  repo: string,
  branch: string,
  threads: readonly AnyNoteThread[],
  liveBranches: ReadonlySet<string> | undefined,
): RepoReadMarks => {
  const current = all[repo];
  const pruned = prunedBranchMarks(
    current ?? {},
    branch,
    threads,
    liveBranches,
  );
  if (pruned === current) {
    return all;
  }
  if (Object.keys(pruned).length === 0) {
    if (current === undefined) {
      return all;
    }
    return Object.fromEntries(
      Object.entries(all).filter(([key]) => key !== repo),
    );
  }
  return { ...all, [repo]: pruned };
};
