import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRefreshScheduler,
  headFingerprint,
  isSelfWriteEventPath,
} from "./refreshScheduler";

describe("createRefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const run = vi.fn(async () => {});
    const scheduler = createRefreshScheduler({
      delayMs: 400,
      maxWaitMs: 1500,
      run,
    });
    return { run, scheduler };
  };

  it("fires once after the delay for a single schedule", () => {
    const { run, scheduler } = setup();
    scheduler.schedule();
    vi.advanceTimersByTime(399);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires at the max wait under a steady stream of schedules", () => {
    const { run, scheduler } = setup();
    scheduler.schedule();
    for (let elapsed = 100; elapsed < 1500; elapsed += 100) {
      vi.advanceTimersByTime(100);
      scheduler.schedule();
    }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("starts a new window for a schedule after a fire", () => {
    const { run, scheduler } = setup();
    scheduler.schedule();
    vi.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    scheduler.schedule();
    vi.advanceTimersByTime(399);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not fire after cancel", () => {
    const { run, scheduler } = setup();
    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("isSelfWriteEventPath", () => {
  it.each([
    "/repo/.git/refs/review/feat/x",
    "/repo/.git/refs/review-notes/x.lock",
    "/repo/.git/logs/refs/review/x",
    "C:\\repo\\.git\\refs\\review\\feat\\x",
  ])("is true for %s", (path) => {
    expect(isSelfWriteEventPath(path)).toBe(true);
  });

  it.each([
    "/repo/.git/HEAD",
    "/repo/.git/refs/heads/main",
    "/repo/src/refs/review.ts",
    "/repo/.git/delta-review/notes-x.json",
  ])("is false for %s", (path) => {
    expect(isSelfWriteEventPath(path)).toBe(false);
  });
});

describe("headFingerprint", () => {
  it("differs when the name or commit changes", () => {
    const base = headFingerprint({ name: "main", commit: "abc" });
    expect(headFingerprint({ name: "main", commit: "abc" })).toBe(base);
    expect(headFingerprint({ name: "feat", commit: "abc" })).not.toBe(base);
    expect(headFingerprint({ name: "main", commit: "def" })).not.toBe(base);
    expect(headFingerprint(undefined)).not.toBe(base);
  });
});
