import { sanitizeBranchForFilename } from "./clusters";

// The notes contract: two versioned JSON files per branch under
// <git common dir>/delta-review/. The notes file is extension-owned (review
// notes written from the diff editor); the responses file is agent-owned (a
// Claude Code agent writes its replies there). This module is the pure
// contract layer — types, parsing, validation — with no fs and no vscode.

export type NoteSide = "base" | "working";

export type NoteStatus = "open" | "addressed" | "resolved";

export interface ReviewerTurn {
  text: string;
  // ISO-8601 UTC timestamp
  at: string;
}

export interface Note {
  id: string;
  // Repo-relative path the note anchors to
  file: string;
  side: NoteSide;
  // 1-based, inclusive range at creation time
  startLine: number;
  endLine: number;
  // The anchored lines' text, one entry per line of the range
  snapshot: string[];
  contentBlob: string;
  // Reviewer follow-ups; always at least one turn (the original note text)
  turns: ReviewerTurn[];
  // status/outdated/currentStartLine/currentEndLine are derived fields the
  // extension refreshes; they persist so agents reading the file get
  // near-current hints
  status: NoteStatus;
  outdated: boolean;
  currentStartLine: number;
  currentEndLine: number;
  createdAt: string;
  // Extension-internal: timestamp of the last response anchor applied to the
  // note (one-shot guard). Parsed and re-serialized like any known field so
  // a load→save cycle never strips it.
  appliedAnchorAt?: string;
}

export interface NotesFile {
  version: 1;
  notes: Note[];
}

// Where the agent's fix landed; always working-tree coordinates
export interface ResponseAnchor {
  file: string;
  line: number;
  snapshot: string;
}

export interface ResponseEntry {
  noteId: string;
  response: string;
  at: string;
  anchor?: ResponseAnchor;
}

export interface ResponsesFile {
  version: 1;
  responses: ResponseEntry[];
}

export type ParseNotesResult =
  { ok: true; file: NotesFile } | { ok: false; error: string };

export type ParseResponsesResult =
  { ok: true; file: ResponsesFile } | { ok: false; error: string };

export type LoadNotesResult =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  | { state: "ok"; file: NotesFile };

export type LoadResponsesResult =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  | { state: "ok"; file: ResponsesFile };

// File names live next to clusters-<branch>.json in the delta-review dir;
// the notes-/responses- prefixes must never collide with clusters-.
export const notesFileName = (branch: string): string =>
  `notes-${sanitizeBranchForFilename(branch)}.json`;

export const responsesFileName = (branch: string): string =>
  `responses-${sanitizeBranchForFilename(branch)}.json`;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isLineNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Validates one raw note entry; returns the normalized note or a user-facing
// error string.
const parseNote = (
  value: unknown,
  index: number,
): { note: Note } | { error: string } => {
  const where = `note ${index + 1}`;
  if (!isRecord(value)) {
    return { error: `${where} must be an object` };
  }
  if (!isNonEmptyString(value.id)) {
    return { error: `${where}: "id" must be a non-empty string` };
  }
  const where2 = `${where} ("${value.id}")`;
  if (!isNonEmptyString(value.file)) {
    return { error: `${where2}: "file" must be a non-empty string` };
  }
  if (value.side !== "base" && value.side !== "working") {
    return { error: `${where2}: "side" must be "base" or "working"` };
  }
  if (!isLineNumber(value.startLine)) {
    return { error: `${where2}: "startLine" must be an integer >= 1` };
  }
  if (!isLineNumber(value.endLine)) {
    return { error: `${where2}: "endLine" must be an integer >= 1` };
  }
  if (value.endLine < value.startLine) {
    return { error: `${where2}: "endLine" must be >= "startLine"` };
  }
  if (!isStringArray(value.snapshot)) {
    return { error: `${where2}: "snapshot" must be an array of strings` };
  }
  if (!isNonEmptyString(value.contentBlob)) {
    return { error: `${where2}: "contentBlob" must be a non-empty string` };
  }
  if (!Array.isArray(value.turns)) {
    return { error: `${where2}: "turns" must be an array` };
  }
  if (value.turns.length === 0) {
    return { error: `${where2}: "turns" must have at least one entry` };
  }
  const turns: ReviewerTurn[] = [];
  for (let turnIndex = 0; turnIndex < value.turns.length; turnIndex++) {
    const turn: unknown = value.turns[turnIndex];
    if (!isRecord(turn)) {
      return { error: `${where2}: turn ${turnIndex + 1} must be an object` };
    }
    if (typeof turn.text !== "string") {
      return {
        error: `${where2}: turn ${turnIndex + 1}: "text" must be a string`,
      };
    }
    if (typeof turn.at !== "string") {
      return {
        error: `${where2}: turn ${turnIndex + 1}: "at" must be a string`,
      };
    }
    turns.push({ text: turn.text, at: turn.at });
  }
  if (
    value.status !== "open" &&
    value.status !== "addressed" &&
    value.status !== "resolved"
  ) {
    return {
      error: `${where2}: "status" must be "open", "addressed", or "resolved"`,
    };
  }
  if (typeof value.outdated !== "boolean") {
    return { error: `${where2}: "outdated" must be a boolean` };
  }
  if (!isLineNumber(value.currentStartLine)) {
    return { error: `${where2}: "currentStartLine" must be an integer >= 1` };
  }
  if (!isLineNumber(value.currentEndLine)) {
    return { error: `${where2}: "currentEndLine" must be an integer >= 1` };
  }
  if (value.currentEndLine < value.currentStartLine) {
    return {
      error: `${where2}: "currentEndLine" must be >= "currentStartLine"`,
    };
  }
  if (!isNonEmptyString(value.createdAt)) {
    return { error: `${where2}: "createdAt" must be a non-empty string` };
  }
  if (
    value.appliedAnchorAt !== undefined &&
    typeof value.appliedAnchorAt !== "string"
  ) {
    return { error: `${where2}: "appliedAnchorAt" must be a string` };
  }
  const note: Note = {
    id: value.id,
    file: value.file,
    side: value.side,
    startLine: value.startLine,
    endLine: value.endLine,
    snapshot: value.snapshot,
    contentBlob: value.contentBlob,
    turns,
    status: value.status,
    outdated: value.outdated,
    currentStartLine: value.currentStartLine,
    currentEndLine: value.currentEndLine,
    createdAt: value.createdAt,
  };
  if (value.appliedAnchorAt !== undefined) {
    note.appliedAnchorAt = value.appliedAnchorAt;
  }
  return { note };
};

// Validates one raw response entry; returns the normalized entry or a
// user-facing error string.
const parseResponseEntry = (
  value: unknown,
  index: number,
): { entry: ResponseEntry } | { error: string } => {
  const where = `response ${index + 1}`;
  if (!isRecord(value)) {
    return { error: `${where} must be an object` };
  }
  if (!isNonEmptyString(value.noteId)) {
    return { error: `${where}: "noteId" must be a non-empty string` };
  }
  const where2 = `${where} ("${value.noteId}")`;
  if (!isNonEmptyString(value.response)) {
    return { error: `${where2}: "response" must be a non-empty string` };
  }
  if (!isNonEmptyString(value.at)) {
    return { error: `${where2}: "at" must be a non-empty string` };
  }
  const entry: ResponseEntry = {
    noteId: value.noteId,
    response: value.response,
    at: value.at,
  };
  if (value.anchor !== undefined) {
    if (!isRecord(value.anchor)) {
      return { error: `${where2}: "anchor" must be an object` };
    }
    if (!isNonEmptyString(value.anchor.file)) {
      return {
        error: `${where2}: anchor "file" must be a non-empty string`,
      };
    }
    if (!isLineNumber(value.anchor.line)) {
      return { error: `${where2}: anchor "line" must be an integer >= 1` };
    }
    if (typeof value.anchor.snapshot !== "string") {
      return { error: `${where2}: anchor "snapshot" must be a string` };
    }
    entry.anchor = {
      file: value.anchor.file,
      line: value.anchor.line,
      snapshot: value.anchor.snapshot,
    };
  }
  return { entry };
};

// Shared top-level validation: JSON.parse, non-array object, version 1, and
// the entries key present as an array. Errors are one-line and user-facing.
const parseVersionedFile = (
  text: string,
  entriesKey: "notes" | "responses",
): { ok: true; entries: unknown[] } | { ok: false; error: string } => {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(data)) {
    return { ok: false, error: "top level must be an object" };
  }
  if (data.version === undefined) {
    return { ok: false, error: 'missing "version" (extension supports 1)' };
  }
  if (data.version !== 1) {
    return {
      ok: false,
      error: `unsupported version ${JSON.stringify(data.version)} (extension supports 1)`,
    };
  }
  if (!Array.isArray(data[entriesKey])) {
    return { ok: false, error: `"${entriesKey}" must be an array` };
  }
  return { ok: true, entries: data[entriesKey] };
};

// Parses and validates notes-file text. Unknown extra keys are ignored
// (forward-friendly within version 1).
export const parseNotesFile = (text: string): ParseNotesResult => {
  const top = parseVersionedFile(text, "notes");
  if (!top.ok) {
    return top;
  }
  const notes: Note[] = [];
  for (let index = 0; index < top.entries.length; index++) {
    const result = parseNote(top.entries[index], index);
    if ("error" in result) {
      return { ok: false, error: result.error };
    }
    notes.push(result.note);
  }
  return { ok: true, file: { version: 1, notes } };
};

// Parses and validates responses-file text. A violating entry rejects the
// file as a whole (clusters semantics). Structurally valid anchors pointing
// at nonexistent locations are accepted — resolution is a runtime concern.
export const parseResponsesFile = (text: string): ParseResponsesResult => {
  const top = parseVersionedFile(text, "responses");
  if (!top.ok) {
    return top;
  }
  const responses: ResponseEntry[] = [];
  for (let index = 0; index < top.entries.length; index++) {
    const result = parseResponseEntry(top.entries[index], index);
    if ("error" in result) {
      return { ok: false, error: result.error };
    }
    responses.push(result.entry);
  }
  return { ok: true, file: { version: 1, responses } };
};
