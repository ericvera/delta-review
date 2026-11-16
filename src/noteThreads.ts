import type {
  Note,
  NoteStatus,
  NotesFile,
  ResponseAnchor,
  ResponsesFile,
} from "./notes";

// Thread merge: combines the extension-owned notes file and the agent-owned
// responses file into display-ready threads — interleaved turns, last-speaker
// status derivation, and response-anchor application. Pure module — no
// vscode, no git; whether an anchor resolves against the working tree is
// runtime knowledge injected via a callback.

export type ThreadTurn = {
  author: "reviewer" | "agent";
  text: string;
  // ISO-8601 UTC timestamp
  at: string;
  anchor?: ResponseAnchor;
  // agent turns only: the reply leaves work queued
  pending?: true;
};

export type ThreadStatus = NoteStatus | "pending";

export interface NoteThread {
  note: Note;
  turns: ThreadTurn[];
  // Derived: explicit resolve wins, else last speaker (pending agent →
  // pending, agent → addressed, reviewer → open)
  status: ThreadStatus;
  // Newest applied (non-dangling) anchor; consumers use it for relocation
  // and the base→working side flip
  effectiveAnchor?: ResponseAnchor;
}

// Ascending by timestamp; returns 0 on ties or unparsable timestamps so the
// stable sort preserves each source array's order (file-order fallback).
const compareTurns = (a: ThreadTurn, b: ThreadTurn): number => {
  const timeA = Date.parse(a.at);
  const timeB = Date.parse(b.at);
  if (Number.isNaN(timeA) || Number.isNaN(timeB) || timeA === timeB) {
    return 0;
  }
  return timeA - timeB;
};

export const deriveThreadStatus = (
  noteStatus: NoteStatus,
  turns: readonly ThreadTurn[],
): ThreadStatus => {
  if (noteStatus === "resolved") {
    return "resolved";
  }
  const lastTurn = turns[turns.length - 1];
  if (lastTurn === undefined || lastTurn.author !== "agent") {
    return "open";
  }
  return lastTurn.pending === true ? "pending" : "addressed";
};

// Pending is stored as addressed: older extensions reject unknown status
// values in the notes file.
export const persistedStatus = (status: ThreadStatus): NoteStatus =>
  status === "pending" ? "addressed" : status;

// Merges notes and responses into display threads. Responses referencing
// unknown note ids are dropped; a missing/invalid responses file (undefined)
// behaves as empty. Input notes are never mutated.
export const mergeThreads = (
  notes: NotesFile,
  responses: ResponsesFile | undefined,
  anchorResolves: (anchor: ResponseAnchor) => boolean,
): NoteThread[] => {
  const agentTurnsByNoteId = new Map<string, ThreadTurn[]>();
  for (const entry of responses?.responses ?? []) {
    const turn: ThreadTurn = {
      author: "agent",
      text: entry.response,
      at: entry.at,
    };
    if (entry.anchor !== undefined) {
      turn.anchor = entry.anchor;
    }
    if (entry.pending === true) {
      turn.pending = true;
    }
    const group = agentTurnsByNoteId.get(entry.noteId);
    if (group === undefined) {
      agentTurnsByNoteId.set(entry.noteId, [turn]);
    } else {
      group.push(turn);
    }
  }

  return notes.notes.map((note) => {
    const reviewerTurns: ThreadTurn[] = note.turns.map((turn) => ({
      author: "reviewer",
      text: turn.text,
      at: turn.at,
    }));
    const agentTurns = agentTurnsByNoteId.get(note.id) ?? [];
    const turns = [...reviewerTurns, ...agentTurns].sort(compareTurns);

    const status = deriveThreadStatus(note.status, turns);

    let effectiveAnchor: ResponseAnchor | undefined;
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (
        turn !== undefined &&
        turn.author === "agent" &&
        turn.anchor !== undefined &&
        anchorResolves(turn.anchor)
      ) {
        effectiveAnchor = turn.anchor;
        break;
      }
    }

    const thread: NoteThread = { note, turns, status };
    if (effectiveAnchor !== undefined) {
      thread.effectiveAnchor = effectiveAnchor;
    }
    return thread;
  });
};

// Threads still needing work, mirroring the contract's actionable rule:
// derived status open or pending. Outdated is a flag, not a status — it never
// removes a thread from the work set.
export const workSet = (threads: NoteThread[]): NoteThread[] =>
  threads.filter(
    (thread) => thread.status === "open" || thread.status === "pending",
  );
