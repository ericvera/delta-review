import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeBranchForFilename } from "./clusters";
import { deltaReviewDirFor } from "./documents";
import type { Git } from "./git";
import { readMarkBranch } from "./pendingRead";

// The diff base is per branch because stacked branches review against their
// parent, not a single global base. It lives under the git common dir so every
// worktree on a branch shares one base and an agent can set it by writing the
// contract file.

export const MAX_CONTAINS_ARGS = 32;

export type ParsedBaseFile =
  { ok: true; branch: string; base: string } | { ok: false; error: string };

export type BranchBaseRead =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  | { state: "ok"; base: string };

export interface BranchReflog {
  creationRef?: string;
  unmoved: boolean;
  ownCommits: Set<string>;
}

export interface DetectionCache {
  key?: string;
  total?: number;
  reflog?: BranchReflog;
  containing?: Set<string>;
  upstreamHasBase?: boolean;
  staleKey?: string;
  staleOffFirstParent?: boolean;
  perCandidate: Map<string, { mb: string; distance: number }>;
}

export interface DetectionResult {
  forkPoint?: string;
  upstream?: string;
  upstreamEligible: boolean;
}

export interface BaseResolution {
  branch: string;
  base: string;
  source: "explicit" | "detected" | "fallback";
  detectedVia?: "forkPoint" | "upstream";
  fallback: string;
  missing: boolean;
  stale: boolean;
  fileError?: string;
  suggestions: { forkPoint?: string; upstream?: string; fallback: string };
}

export interface AheadBehindLine {
  name: string;
  sha: string;
  ahead: number;
  behind: number;
}

export const createDetectionCache = (): DetectionCache => ({
  perCandidate: new Map(),
});

export const resetDetectionCache = (cache: DetectionCache): void => {
  cache.key = undefined;
  cache.total = undefined;
  cache.reflog = undefined;
  cache.containing = undefined;
  cache.upstreamHasBase = undefined;
  cache.staleKey = undefined;
  cache.staleOffFirstParent = undefined;
  cache.perCandidate.clear();
};

export const baseFileName = (branch: string): string =>
  `base-${sanitizeBranchForFilename(readMarkBranch(branch))}.json`;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const parseBaseFile = (text: string): ParsedBaseFile => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${(error as Error).message}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "not a JSON object" };
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return { ok: false, error: "version must be 1" };
  }
  if (!isNonEmptyString(record.branch)) {
    return { ok: false, error: "branch must be a non-empty string" };
  }
  if (!isNonEmptyString(record.base)) {
    return { ok: false, error: "base must be a non-empty string" };
  }
  return { ok: true, branch: record.branch, base: record.base };
};

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

const baseFilePath = async (git: Git, branch: string): Promise<string> =>
  join(await deltaReviewDirFor(git), baseFileName(branch));

const readBaseFileText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
};

export const readBranchBase = async (
  git: Git,
  branch: string,
): Promise<BranchBaseRead> => {
  const stripped = readMarkBranch(branch);
  const path = await baseFilePath(git, stripped);
  let text: string | undefined;
  try {
    text = await readBaseFileText(path);
  } catch (error) {
    return { state: "invalid", error: (error as Error).message };
  }
  if (text === undefined) {
    return { state: "missing" };
  }
  const parsed = parseBaseFile(text);
  if (!parsed.ok) {
    return { state: "invalid", error: parsed.error };
  }
  if (parsed.branch !== stripped) {
    return { state: "missing" };
  }
  return { state: "ok", base: parsed.base };
};

// Same-dir hidden random temp file renamed over the target, so a reader never
// sees a partial file and concurrent writers never share a temp file.
const writeAtomically = async (
  dir: string,
  fileName: string,
  text: string,
): Promise<void> => {
  await mkdir(dir, { recursive: true });
  const tempPath = join(
    dir,
    `.${fileName}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tempPath, text);
    await rename(tempPath, join(dir, fileName));
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
};

export const writeBranchBase = async (
  git: Git,
  branch: string,
  base: string,
): Promise<void> => {
  const stripped = readMarkBranch(branch);
  const text =
    JSON.stringify({ version: 1, branch: stripped, base }, null, 2) + "\n";
  await writeAtomically(
    await deltaReviewDirFor(git),
    baseFileName(stripped),
    text,
  );
};

export const clearBranchBase = async (
  git: Git,
  branch: string,
): Promise<void> => {
  const stripped = readMarkBranch(branch);
  const path = await baseFilePath(git, stripped);
  const text = await readBaseFileText(path);
  if (text === undefined) {
    return;
  }
  const parsed = parseBaseFile(text);
  if (parsed.ok && parsed.branch !== stripped) {
    return;
  }
  await unlink(path).catch((error: unknown) => {
    if (!isEnoent(error)) {
      throw error;
    }
  });
};

export const pickDetectedBase = (
  candidates: { name: string; distance: number }[],
  fallback: string,
  creationRef?: string,
): string | undefined => {
  const rank = (name: string): number =>
    name === fallback ? 0 : name === creationRef ? 1 : 2;
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    if (
      best === undefined ||
      candidate.distance < best.distance ||
      (candidate.distance === best.distance &&
        rank(candidate.name) < rank(best.name))
    ) {
      best = candidate;
    }
  }
  return best?.name;
};

const CREATION = /^branch: Created from (.+)$/;
const FINISH_ONTO = /\(finish\): .* onto ([0-9a-f]+)$/;
const OWN_PREFIXES = ["commit", "cherry-pick", "revert", "rebase"];

const isOwnCommitEntry = (sha: string, subject: string): boolean => {
  const finish = FINISH_ONTO.exec(subject);
  if (finish !== null && finish[1] === sha) {
    return false;
  }
  if (OWN_PREFIXES.some((prefix) => subject.startsWith(prefix))) {
    return true;
  }
  return (
    (subject.startsWith("merge") || subject.startsWith("pull")) &&
    !subject.includes("Fast-forward")
  );
};

export const parseBranchReflog = (
  output: string,
  headSha: string,
): BranchReflog => {
  const entries = output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const space = line.indexOf(" ");
      return space === -1
        ? { sha: line, subject: "" }
        : { sha: line.slice(0, space), subject: line.slice(space + 1) };
    });
  const oldest = entries[entries.length - 1];
  const creation = oldest === undefined ? null : CREATION.exec(oldest.subject);
  let creationRef: string | undefined;
  if (creation !== null) {
    const ref = creation[1].startsWith("refs/heads/")
      ? creation[1].slice("refs/heads/".length)
      : creation[1];
    creationRef = ref === "HEAD" ? undefined : ref;
  }
  const unmoved =
    creation !== null && entries.length === 1 && oldest?.sha === headSha;
  const ownCommits = new Set<string>();
  entries.forEach((entry, index) => {
    const isCreationLine = creation !== null && index === entries.length - 1;
    if (!isCreationLine && isOwnCommitEntry(entry.sha, entry.subject)) {
      ownCommits.add(entry.sha);
    }
  });
  return { creationRef, unmoved, ownCommits };
};

export const isEligibleCandidate = (
  candidate: { name: string; ahead: number; behind: number },
  total: number,
  reflog: BranchReflog,
  containing: ReadonlySet<string>,
  fallback: string,
): boolean => {
  if (candidate.behind === total) {
    return false;
  }
  if (candidate.behind === 0 && !reflog.unmoved) {
    return false;
  }
  return !(containing.has(candidate.name) && candidate.name !== fallback);
};

export const containsArgs = (ownCommits: Iterable<string>): string[] => {
  const args: string[] = [];
  for (const sha of ownCommits) {
    if (args.length >= MAX_CONTAINS_ARGS) {
      break;
    }
    args.push(`--contains=${sha}`);
  }
  return args;
};

export const parseAheadBehindLines = (
  output: string,
  currentBranch: string,
): AheadBehindLine[] => {
  const current = readMarkBranch(currentBranch);
  const result: AheadBehindLine[] = [];
  for (const line of output.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 4) {
      continue;
    }
    const behind = Number(fields[fields.length - 1]);
    const ahead = Number(fields[fields.length - 2]);
    const sha = fields[fields.length - 3];
    const name = fields.slice(0, fields.length - 3).join(" ");
    if (
      name === current ||
      !Number.isInteger(ahead) ||
      !Number.isInteger(behind)
    ) {
      continue;
    }
    result.push({ name, sha, ahead, behind });
  }
  return result;
};

const parseNameShaLines = (output: string): { name: string; sha: string }[] =>
  output
    .split("\n")
    .map((line) => line.split(" "))
    .filter((fields) => fields.length >= 2)
    .map((fields) => ({
      name: fields.slice(0, fields.length - 1).join(" "),
      sha: fields[fields.length - 1],
    }));

const tryRun = async (
  git: Git,
  args: string[],
): Promise<string | undefined> => {
  try {
    return await git.run(args);
  } catch {
    return undefined;
  }
};

const succeeds = async (git: Git, args: string[]): Promise<boolean> =>
  (await tryRun(git, args)) !== undefined;

const MODERN_FORMAT =
  "--format=%(refname:lstrip=2) %(objectname) %(ahead-behind:HEAD)";
const LEGACY_FORMAT = "--format=%(refname:lstrip=2) %(objectname)";

const listBranches = async (
  git: Git,
): Promise<{ output: string; legacy: boolean }> => {
  try {
    return {
      output: await git.run(["for-each-ref", MODERN_FORMAT, "refs/heads"]),
      legacy: false,
    };
  } catch (error) {
    if (!/ahead-behind/.test((error as Error).message)) {
      return { output: "", legacy: false };
    }
  }
  const output =
    (await tryRun(git, ["for-each-ref", LEGACY_FORMAT, "refs/heads"])) ?? "";
  return { output, legacy: true };
};

const legacyCandidates = async (
  git: Git,
  lines: { name: string; sha: string }[],
  headSha: string,
  cache: DetectionCache,
): Promise<{ name: string; ahead: number; behind: number }[]> => {
  const keys = new Set(lines.map((line) => `${line.sha} ${headSha}`));
  for (const key of cache.perCandidate.keys()) {
    if (!keys.has(key)) {
      cache.perCandidate.delete(key);
    }
  }
  const measured = await Promise.all(
    lines.map(async (line) => {
      const key = `${line.sha} ${headSha}`;
      const cached = cache.perCandidate.get(key);
      if (cached !== undefined) {
        return { name: line.name, ahead: 0, behind: cached.distance };
      }
      const mb = (await tryRun(git, ["merge-base", line.sha, "HEAD"]))?.trim();
      if (mb === undefined || mb === "") {
        return undefined;
      }
      const count = await tryRun(git, ["rev-list", "--count", `${mb}..HEAD`]);
      if (count === undefined) {
        return undefined;
      }
      const distance = Number(count.trim());
      cache.perCandidate.set(key, { mb, distance });
      return {
        name: line.name,
        ahead: 0,
        behind: mb === headSha ? 0 : distance,
      };
    }),
  );
  return measured.filter((entry) => entry !== undefined);
};

export const detectBase = async (
  git: Git,
  branch: string,
  fallback: string,
  cache: DetectionCache,
): Promise<DetectionResult> => {
  const current = readMarkBranch(branch);
  const [{ output, legacy }, upstreamOutput] = await Promise.all([
    listBranches(git),
    tryRun(git, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
  ]);
  const upstream = upstreamOutput?.trim() || undefined;
  const key = `${legacy ? "legacy" : "modern"}\0${output}\0${upstream ?? ""}\0${fallback}`;
  if (cache.key !== key) {
    cache.key = key;
    cache.total = undefined;
    cache.reflog = undefined;
    cache.containing = undefined;
    cache.upstreamHasBase = undefined;
  }

  const nameShaLines = parseNameShaLines(
    legacy
      ? output
      : output
          .split("\n")
          .map((line) => line.split(" ").slice(0, -2).join(" "))
          .join("\n"),
  );
  const headSha = nameShaLines.find((line) => line.name === current)?.sha;

  let forkPoint: string | undefined;
  if (headSha !== undefined) {
    const [total, reflog] = await Promise.all([
      cache.total ??
        tryRun(git, ["rev-list", "--count", "HEAD"]).then((count) =>
          count === undefined ? undefined : Number(count.trim()),
        ),
      cache.reflog ??
        tryRun(git, [
          "reflog",
          "show",
          "--format=%H %gs",
          `refs/heads/${current}`,
          "--",
        ]).then((text) => parseBranchReflog(text ?? "", headSha)),
    ]);
    cache.reflog = reflog;
    if (total !== undefined) {
      cache.total = total;
      if (cache.containing === undefined) {
        const args = containsArgs(reflog.ownCommits);
        const listed =
          args.length === 0
            ? ""
            : ((await tryRun(git, [
                "for-each-ref",
                "--format=%(refname:lstrip=2)",
                ...args,
                "refs/heads",
              ])) ?? "");
        cache.containing = new Set(
          listed.split("\n").filter((name) => name.length > 0),
        );
      }
      const containing = cache.containing;
      const candidates = legacy
        ? await legacyCandidates(
            git,
            nameShaLines.filter((line) => line.name !== current),
            headSha,
            cache,
          )
        : parseAheadBehindLines(output, current);
      forkPoint = pickDetectedBase(
        candidates
          .filter((candidate) =>
            isEligibleCandidate(candidate, total, reflog, containing, fallback),
          )
          .map((candidate) => ({
            name: candidate.name,
            distance: candidate.behind,
          })),
        fallback,
        reflog.creationRef,
      );
    }
  }

  let upstreamEligible = false;
  if (upstream !== undefined && !upstream.endsWith(`/${current}`)) {
    cache.upstreamHasBase ??= await succeeds(git, [
      "merge-base",
      upstream,
      "HEAD",
    ]);
    upstreamEligible = cache.upstreamHasBase;
  }
  return { forkPoint, upstream, upstreamEligible };
};

export const isRefValid = async (git: Git, ref: string): Promise<boolean> =>
  ref.length > 0 &&
  !ref.startsWith("-") &&
  (await succeeds(git, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]));

const isStale = async (
  git: Git,
  base: string,
  fallback: string,
  cache: DetectionCache,
): Promise<boolean> => {
  if (base === fallback || fallback.startsWith("-")) {
    return false;
  }
  const isBranch =
    (await succeeds(git, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${base}`,
    ])) ||
    (await succeeds(git, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/${base}`,
    ]));
  if (!isBranch) {
    return false;
  }
  const shas = await tryRun(git, [
    "rev-parse",
    `${base}^{commit}`,
    `${fallback}^{commit}`,
  ]);
  const [baseSha, fallbackSha] = (shas ?? "").trim().split("\n");
  if (baseSha === undefined || fallbackSha === undefined) {
    return false;
  }
  const staleKey = `${baseSha} ${fallbackSha}`;
  if (cache.staleKey === staleKey && cache.staleOffFirstParent !== undefined) {
    return cache.staleOffFirstParent;
  }
  let stale = false;
  if (
    await succeeds(git, ["merge-base", "--is-ancestor", baseSha, fallbackSha])
  ) {
    const log = await tryRun(git, [
      "log",
      "--first-parent",
      "--format=%P",
      `${baseSha}..${fallbackSha}`,
    ]);
    const lines = (log ?? "").split("\n").filter((line) => line.length > 0);
    const oldest = lines[lines.length - 1];
    stale = oldest !== undefined && oldest.split(" ")[0] !== baseSha;
  }
  cache.staleKey = staleKey;
  cache.staleOffFirstParent = stale;
  return stale;
};

export const resolveDiffBase = async (
  git: Git,
  branch: string,
  fallback: string,
  cache: DetectionCache,
): Promise<BaseResolution> => {
  const current = readMarkBranch(branch);
  const asFallback = (
    suggestions: BaseResolution["suggestions"],
    fileError?: string,
  ): BaseResolution => ({
    branch: current,
    base: fallback,
    source: "fallback",
    fallback,
    missing: false,
    stale: false,
    fileError,
    suggestions,
  });
  if (current === "HEAD") {
    return asFallback({ fallback });
  }

  const explicit = await readBranchBase(git, current);
  const fileError = explicit.state === "invalid" ? explicit.error : undefined;
  const detection =
    current === fallback
      ? undefined
      : await detectBase(git, current, fallback, cache);
  const suggestions = {
    forkPoint: detection?.forkPoint,
    upstream: detection?.upstream,
    fallback,
  };

  if (explicit.state === "ok") {
    const missing = !(await isRefValid(git, explicit.base));
    const stale =
      !missing &&
      current !== fallback &&
      (await isStale(git, explicit.base, fallback, cache));
    return {
      branch: current,
      base: explicit.base,
      source: "explicit",
      fallback,
      missing,
      stale,
      suggestions,
    };
  }
  if (detection?.forkPoint !== undefined) {
    return {
      branch: current,
      base: detection.forkPoint,
      source: "detected",
      detectedVia: "forkPoint",
      fallback,
      missing: false,
      stale: await isStale(git, detection.forkPoint, fallback, cache),
      fileError,
      suggestions,
    };
  }
  if (detection?.upstreamEligible && detection.upstream !== undefined) {
    return {
      branch: current,
      base: detection.upstream,
      source: "detected",
      detectedVia: "upstream",
      fallback,
      missing: false,
      stale: false,
      fileError,
      suggestions,
    };
  }
  return asFallback(suggestions, fileError);
};
