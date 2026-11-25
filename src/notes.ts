import { sanitizeBranchForFilename } from "./clusters";
import { isDocumentNoteFileName } from "./documents";

// The notes contract: three versioned JSON files per branch under
// <git common dir>/delta-review/. The notes file is extension-owned (line and
// document notes written from the editor, plus whole-file and general notes
// from version 3); the responses file is agent-owned (a Claude Code agent
// writes its replies there); the archive file is extension-written history
// of the notes Clear Resolved removed, which the extension never reads back
// for behavior of its own. This module is the pure contract layer — types,
// parsing, validation — with no fs and no vscode.

export type NoteSide = "base" | "working";

export type NoteStatus = "open" | "addressed" | "resolved";

export type NoteDocument = "clusterNotes" | "branch";

export interface ReviewerTurn {
  text: string;
  // ISO-8601 UTC timestamp
  at: string;
}

export interface Note {
  id: string;
  // Repo-relative path the note anchors to; for a document note, the
  // document's file name: inside the cluster notes dir for "clusterNotes",
  // inside the delta-review dir for "branch"
  file: string;
  // Set on notes anchored to a cluster notes document or the Branch overview
  // document (version 2 only)
  document?: NoteDocument;
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

// A whole-file note: no line range, anchored to the file's content at
// creation time (version 3 only)
export interface FileNote {
  scope: "file";
  id: string;
  // Repo-relative path
  file: string;
  contentBlob: string;
  turns: ReviewerTurn[];
  status: NoteStatus;
  // Derived: the file is no longer in the review set
  outdated: boolean;
  createdAt: string;
}

// A note on the branch as a whole, with no file (version 3 only)
export interface GeneralNote {
  scope: "general";
  id: string;
  turns: ReviewerTurn[];
  status: NoteStatus;
  // Always false
  outdated: boolean;
  createdAt: string;
}

export type AnyNote = Note | FileNote | GeneralNote;

export interface NotesFile {
  version: 1 | 2 | 3;
  notes: AnyNote[];
}

export const isFileNote = (note: AnyNote): note is FileNote =>
  "scope" in note && note.scope === "file";

export const isGeneralNote = (note: AnyNote): note is GeneralNote =>
  "scope" in note && note.scope === "general";

export const isLineNote = (note: AnyNote): note is Note => !("scope" in note);

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
  // The reply leaves work queued; the note derives pending.
  pending?: true;
}

export interface ResponsesFile {
  version: 1;
  responses: ResponseEntry[];
}

// The archive file, validated at the top level only: its entries are
// history (a removed note plus `deletedAt`) that no reader here re-checks
// against the note schema, and the index signature carries over any other
// top-level key a future writer added, so a read-modify-write append never
// drops what it does not understand.
export interface ArchiveShell {
  version: 1;
  notes: unknown[];
  [key: string]: unknown;
}

export type ParseNotesResult =
  { ok: true; file: NotesFile } | { ok: false; error: string };

export type ParseResponsesResult =
  { ok: true; file: ResponsesFile } | { ok: false; error: string };

export type ParseArchiveResult =
  { ok: true; file: ArchiveShell } | { ok: false; error: string };

export type LoadNotesResult =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  | { state: "ok"; file: NotesFile };

export type LoadResponsesResult =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  | { state: "ok"; file: ResponsesFile };

// File names live next to clusters-<branch>.json in the delta-review dir;
// the notes-/responses-/archive- prefixes must never collide with clusters-.
export const notesFileName = (branch: string): string =>
  `notes-${sanitizeBranchForFilename(branch)}.json`;

export const responsesFileName = (branch: string): string =>
  `responses-${sanitizeBranchForFilename(branch)}.json`;

export const archiveFileName = (branch: string): string =>
  `archive-${sanitizeBranchForFilename(branch)}.json`;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isLineNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type SharedNoteFields = Pick<
  GeneralNote,
  "turns" | "status" | "outdated" | "createdAt"
>;

// Validates the fields every note kind carries besides "id".
const parseSharedFields = (
  value: Record<string, unknown>,
  where: string,
): { shared: SharedNoteFields } | { error: string } => {
  if (!Array.isArray(value.turns)) {
    return { error: `${where}: "turns" must be an array` };
  }
  if (value.turns.length === 0) {
    return { error: `${where}: "turns" must have at least one entry` };
  }
  const turns: ReviewerTurn[] = [];
  for (let turnIndex = 0; turnIndex < value.turns.length; turnIndex++) {
    const turn: unknown = value.turns[turnIndex];
    if (!isRecord(turn)) {
      return { error: `${where}: turn ${turnIndex + 1} must be an object` };
    }
    if (typeof turn.text !== "string") {
      return {
        error: `${where}: turn ${turnIndex + 1}: "text" must be a string`,
      };
    }
    if (typeof turn.at !== "string") {
      return {
        error: `${where}: turn ${turnIndex + 1}: "at" must be a string`,
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
      error: `${where}: "status" must be "open", "addressed", or "resolved"`,
    };
  }
  if (typeof value.outdated !== "boolean") {
    return { error: `${where}: "outdated" must be a boolean` };
  }
  if (!isNonEmptyString(value.createdAt)) {
    return { error: `${where}: "createdAt" must be a non-empty string` };
  }
  return {
    shared: {
      turns,
      status: value.status,
      outdated: value.outdated,
      createdAt: value.createdAt,
    },
  };
};

const parseLineNote = (
  value: Record<string, unknown> & { id: string },
  where: string,
  version: 1 | 2 | 3,
): { note: Note } | { error: string } => {
  if (!isNonEmptyString(value.file)) {
    return { error: `${where}: "file" must be a non-empty string` };
  }
  if (value.side !== "base" && value.side !== "working") {
    return { error: `${where}: "side" must be "base" or "working"` };
  }
  const document = version >= 2 ? value.document : undefined;
  if (document !== undefined) {
    if (document !== "clusterNotes" && document !== "branch") {
      return {
        error: `${where}: "document" must be "clusterNotes" or "branch"`,
      };
    }
    if (!isDocumentNoteFileName(document, value.file)) {
      return {
        error:
          document === "clusterNotes"
            ? `${where}: a document note's "file" must be a cluster notes file name`
            : `${where}: a branch document note's "file" must be a branch document file name`,
      };
    }
    if (value.side !== "working") {
      return { error: `${where}: a document note's "side" must be "working"` };
    }
  }
  if (!isLineNumber(value.startLine)) {
    return { error: `${where}: "startLine" must be an integer >= 1` };
  }
  if (!isLineNumber(value.endLine)) {
    return { error: `${where}: "endLine" must be an integer >= 1` };
  }
  if (value.endLine < value.startLine) {
    return { error: `${where}: "endLine" must be >= "startLine"` };
  }
  if (!isStringArray(value.snapshot)) {
    return { error: `${where}: "snapshot" must be an array of strings` };
  }
  if (!isNonEmptyString(value.contentBlob)) {
    return { error: `${where}: "contentBlob" must be a non-empty string` };
  }
  const shared = parseSharedFields(value, where);
  if ("error" in shared) {
    return shared;
  }
  if (!isLineNumber(value.currentStartLine)) {
    return { error: `${where}: "currentStartLine" must be an integer >= 1` };
  }
  if (!isLineNumber(value.currentEndLine)) {
    return { error: `${where}: "currentEndLine" must be an integer >= 1` };
  }
  if (value.currentEndLine < value.currentStartLine) {
    return {
      error: `${where}: "currentEndLine" must be >= "currentStartLine"`,
    };
  }
  if (
    value.appliedAnchorAt !== undefined &&
    typeof value.appliedAnchorAt !== "string"
  ) {
    return { error: `${where}: "appliedAnchorAt" must be a string` };
  }
  const { turns, status, outdated, createdAt } = shared.shared;
  const note: Note = {
    id: value.id,
    file: value.file,
    ...(document === undefined ? {} : { document }),
    side: value.side,
    startLine: value.startLine,
    endLine: value.endLine,
    snapshot: value.snapshot,
    contentBlob: value.contentBlob,
    turns,
    status,
    outdated,
    currentStartLine: value.currentStartLine,
    currentEndLine: value.currentEndLine,
    createdAt,
  };
  if (value.appliedAnchorAt !== undefined) {
    note.appliedAnchorAt = value.appliedAnchorAt;
  }
  return { note };
};

// Validates one raw note entry; returns the normalized note or a user-facing
// error string. Only version 3 reads "scope"; scoped notes are rebuilt from
// their own keys so line-note fields never ride along.
const parseNote = (
  value: unknown,
  index: number,
  version: 1 | 2 | 3,
): { note: AnyNote } | { error: string } => {
  const where = `note ${index + 1}`;
  if (!isRecord(value)) {
    return { error: `${where} must be an object` };
  }
  if (!isNonEmptyString(value.id)) {
    return { error: `${where}: "id" must be a non-empty string` };
  }
  const id = value.id;
  const where2 = `${where} ("${id}")`;
  const scope = version === 3 ? value.scope : undefined;
  if (scope === undefined) {
    return parseLineNote({ ...value, id }, where2, version);
  }
  if (scope !== "file" && scope !== "general") {
    return { error: `${where2}: "scope" must be "file" or "general"` };
  }
  if (scope === "general") {
    const shared = parseSharedFields(value, where2);
    return "error" in shared
      ? shared
      : { note: { scope, id, ...shared.shared } };
  }
  const { file, contentBlob } = value;
  if (!isNonEmptyString(file)) {
    return { error: `${where2}: "file" must be a non-empty string` };
  }
  if (!isNonEmptyString(contentBlob)) {
    return { error: `${where2}: "contentBlob" must be a non-empty string` };
  }
  const shared = parseSharedFields(value, where2);
  return "error" in shared
    ? shared
    : { note: { scope, id, file, contentBlob, ...shared.shared } };
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
  if (value.pending !== undefined && typeof value.pending !== "boolean") {
    return { error: `${where2}: "pending" must be a boolean` };
  }
  const entry: ResponseEntry = {
    noteId: value.noteId,
    response: value.response,
    at: value.at,
  };
  if (value.pending === true) {
    entry.pending = true;
  }
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

// Shared top-level validation: JSON.parse, non-array object, a supported
// version, and the entries key present as an array. Errors are one-line and
// user-facing. The validated record rides along for callers that must
// preserve keys they do not model.
const parseVersionedFile = (
  text: string,
  entriesKey: "notes" | "responses",
  versions: readonly number[],
):
  | {
      ok: true;
      version: number;
      entries: unknown[];
      record: Record<string, unknown>;
    }
  | { ok: false; error: string } => {
  const listed =
    versions.length > 1
      ? `${versions.slice(0, -1).join(", ")} and ${versions[versions.length - 1]}`
      : versions.join("");
  const supported = `(extension supports ${listed})`;
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
    return { ok: false, error: `missing "version" ${supported}` };
  }
  if (typeof data.version !== "number" || !versions.includes(data.version)) {
    return {
      ok: false,
      error: `unsupported version ${JSON.stringify(data.version)} ${supported}`,
    };
  }
  if (!Array.isArray(data[entriesKey])) {
    return { ok: false, error: `"${entriesKey}" must be an array` };
  }
  return {
    ok: true,
    version: data.version,
    entries: data[entriesKey],
    record: data,
  };
};

// The version a notes file is written at: the lowest that holds every note,
// so files without newer note kinds stay readable by older extensions.
export const notesFileVersion = (notes: readonly AnyNote[]): 1 | 2 | 3 => {
  if (notes.some((note) => !isLineNote(note))) {
    return 3;
  }
  return notes.some((note) => isLineNote(note) && note.document !== undefined)
    ? 2
    : 1;
};

// Parses and validates notes-file text. Unknown extra keys are ignored
// (forward-friendly within a version).
export const parseNotesFile = (text: string): ParseNotesResult => {
  const top = parseVersionedFile(text, "notes", [1, 2, 3]);
  if (!top.ok) {
    return top;
  }
  const version = top.version === 3 ? 3 : top.version === 2 ? 2 : 1;
  const notes: AnyNote[] = [];
  for (let index = 0; index < top.entries.length; index++) {
    const result = parseNote(top.entries[index], index, version);
    if ("error" in result) {
      return { ok: false, error: result.error };
    }
    notes.push(result.note);
  }
  return { ok: true, file: { version, notes } };
};

// Parses and validates responses-file text. A violating entry rejects the
// file as a whole (clusters semantics). Structurally valid anchors pointing
// at nonexistent locations are accepted — resolution is a runtime concern.
export const parseResponsesFile = (text: string): ParseResponsesResult => {
  const top = parseVersionedFile(text, "responses", [1]);
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

// Parses archive-file text. Only the shell is checked — archived entries
// are opaque history, so a single unrecognized entry must not cost the file
// — and unknown top-level keys survive into the returned shell.
export const parseArchiveFile = (text: string): ParseArchiveResult => {
  const top = parseVersionedFile(text, "notes", [1]);
  if (!top.ok) {
    return top;
  }
  return {
    ok: true,
    file: { ...top.record, version: 1, notes: top.entries },
  };
};
