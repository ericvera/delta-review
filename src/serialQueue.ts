export interface SerialQueue {
  run: <T>(task: () => Promise<T>) => Promise<T>;
}

// Runs tasks one at a time, in enqueue order: a task starts only once the
// previous one has settled, so overlapping read-modify-write cycles on the
// same state cannot interleave and drop each other's changes. A task's
// rejection reaches its own caller only — the chain always advances.
export const createSerialQueue = (): SerialQueue => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run: <T>(task: () => Promise<T>): Promise<T> => {
      // tail never rejects, so the continuation cannot observe (or be skipped
      // by) the previous task's outcome; the caller-facing promise is a
      // separate branch off the same link
      const result = tail.then(() => task());
      tail = result.catch(() => undefined);
      return result;
    },
  };
};
