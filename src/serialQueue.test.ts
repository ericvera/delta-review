import { describe, expect, it } from "vitest";
import { createSerialQueue } from "./serialQueue";

// A promise plus the handles to settle it from the test body, so a task can be
// held open while later tasks are enqueued behind it
const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("createSerialQueue", () => {
  it("does not start a task before the previous one settles", async () => {
    const queue = createSerialQueue();
    const first = deferred<void>();
    const order: string[] = [];

    const firstRun = queue.run(async () => {
      order.push("first:start");
      await first.promise;
      order.push("first:end");
    });
    const secondRun = queue.run(async () => {
      order.push("second:start");
    });

    // Give the second task every chance to jump the queue
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    first.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("runs tasks in enqueue order", async () => {
    const queue = createSerialQueue();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((index) =>
        queue.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5 - index));
          order.push(index);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("passes return values through to the caller", async () => {
    const queue = createSerialQueue();
    await expect(queue.run(async () => "value")).resolves.toBe("value");
    await expect(queue.run(async () => 42)).resolves.toBe(42);
  });

  it("rejects only the failing task's caller and keeps the queue running", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];

    const failing = queue.run(async () => {
      order.push("failing");
      throw new Error("boom");
    });
    const following = queue.run(async () => {
      order.push("following");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("ok");
    expect(order).toEqual(["failing", "following"]);
  });

  it("keeps the queue running when a task throws synchronously", async () => {
    const queue = createSerialQueue();
    const failing = queue.run(() => {
      throw new Error("sync boom");
    });
    await expect(failing).rejects.toThrow("sync boom");
    await expect(queue.run(async () => "ok")).resolves.toBe("ok");
  });

  it("serializes read-modify-write cycles so neither update is lost", async () => {
    // Stands in for markReviewed: read the review state, add a path, write it
    // back. The read and the write are separate awaits, which is exactly the
    // window two unqueued callers interleave in.
    let state: string[] = [];
    const read = async (): Promise<string[]> => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return [...state];
    };
    const write = async (next: string[]): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      state = next;
    };
    const addPath = async (path: string): Promise<void> => {
      const current = await read();
      await write([...current, path]);
    };

    // Unqueued, the later read sees the pre-write state and one path is lost
    await Promise.all([addPath("a.ts"), addPath("b.ts")]);
    expect(state).toEqual(["b.ts"]);

    state = [];
    const queue = createSerialQueue();
    await Promise.all([
      queue.run(() => addPath("a.ts")),
      queue.run(() => addPath("b.ts")),
    ]);
    expect(state).toEqual(["a.ts", "b.ts"]);
  });
});
