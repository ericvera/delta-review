// Refresh debouncing and the event filters that feed it. The extension's own
// review-ref writes are dropped so a mark does not trigger a superseding
// refresh, and git state events count only when HEAD moves. Trade-offs: a
// `git fetch` that only moves remote refs no longer refreshes, so a
// remote-branch base updates on the next focus or save; another window's mark
// shows up on the next focus, save or HEAD change.

interface SchedulerTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export interface RefreshScheduler {
  schedule(): void;
  cancel(): void;
}

export const createRefreshScheduler = ({
  delayMs,
  maxWaitMs,
  run,
  timers = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: Date.now,
  },
}: {
  delayMs: number;
  maxWaitMs: number;
  run: () => Promise<void>;
  timers?: SchedulerTimers;
}): RefreshScheduler => {
  let handle: unknown;
  let firstPendingAt: number | undefined;

  const cancel = (): void => {
    if (handle !== undefined) {
      timers.clearTimeout(handle);
      handle = undefined;
    }
    firstPendingAt = undefined;
  };

  const schedule = (): void => {
    const now = timers.now();
    if (handle !== undefined) {
      timers.clearTimeout(handle);
    }
    firstPendingAt ??= now;
    const wait = Math.max(
      0,
      Math.min(delayMs, firstPendingAt + maxWaitMs - now),
    );
    handle = timers.setTimeout(() => {
      handle = undefined;
      firstPendingAt = undefined;
      void run();
    }, wait);
  };

  return { schedule, cancel };
};

export const isSelfWriteEventPath = (fsPath: string): boolean => {
  const normalized = fsPath.replace(/\\/g, "/");
  const marker = "/.git/";
  const index = normalized.indexOf(marker);
  if (index === -1) {
    return false;
  }
  const rest = normalized.slice(index + marker.length);
  return rest.startsWith("refs/review") || rest.startsWith("logs/refs/review");
};

export const headFingerprint = (
  head: { name?: string; commit?: string } | undefined,
): string => `${head?.name ?? ""}\0${head?.commit ?? ""}`;
