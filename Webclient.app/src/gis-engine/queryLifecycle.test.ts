import { describe, expect, it, vi } from "vitest";
import { QueryLifecycleCoordinator, QueryLifecycleError } from "./queryLifecycle";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("QueryLifecycleCoordinator", () => {
  it("deduplicates concurrent work while preserving subscriber results", async () => {
    const gate = deferred<number>();
    const execute = vi.fn(() => gate.promise);
    const coordinator = new QueryLifecycleCoordinator({ maxConcurrent: 2, dedupeTtlMs: 0 });

    const first = coordinator.execute({ key: "layer:1", priority: "foreground", execute });
    const second = coordinator.execute({ key: "layer:1", priority: "interactive", execute });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().dedupedSubscribers).toBe(1);
    gate.resolve(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
    expect(coordinator.snapshot().completed).toBe(1);
  });

  it("orders queued work by priority without preempting active work", async () => {
    const firstGate = deferred<string>();
    const order: string[] = [];
    const coordinator = new QueryLifecycleCoordinator({ maxConcurrent: 1, dedupeTtlMs: 0 });

    const first = coordinator.execute({
      key: "first",
      priority: "background",
      execute: async () => {
        order.push("first");
        return firstGate.promise;
      },
    });
    const background = coordinator.execute({
      key: "background",
      priority: "background",
      execute: async () => {
        order.push("background");
        return "background";
      },
    });
    const interactive = coordinator.execute({
      key: "interactive",
      priority: "interactive",
      execute: async () => {
        order.push("interactive");
        return "interactive";
      },
    });

    firstGate.resolve("first");
    await first;
    await interactive;
    await background;
    expect(order).toEqual(["first", "interactive", "background"]);
  });

  it("rejects admission when both active and bounded queue are saturated", async () => {
    const gate = deferred<void>();
    const coordinator = new QueryLifecycleCoordinator({ maxConcurrent: 1, maxQueued: 1, dedupeTtlMs: 0 });
    const active = coordinator.execute({ key: "active", priority: "foreground", execute: () => gate.promise });
    const queued = coordinator.execute({ key: "queued", priority: "foreground", execute: async () => undefined });

    await expect(
      coordinator.execute({ key: "overflow", priority: "foreground", execute: async () => undefined }),
    ).rejects.toMatchObject({ code: "queue-full" });

    gate.resolve();
    await active;
    await queued;
    expect(coordinator.snapshot().rejected).toBe(1);
  });

  it("cancels one subscriber without cancelling shared work needed by another", async () => {
    const gate = deferred<number>();
    const controller = new AbortController();
    const coordinator = new QueryLifecycleCoordinator({ dedupeTtlMs: 0 });
    const execute = vi.fn(() => gate.promise);

    const cancelled = coordinator.execute({ key: "shared", priority: "foreground", execute, signal: controller.signal });
    const survivor = coordinator.execute({ key: "shared", priority: "foreground", execute });
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    gate.resolve(7);
    await expect(survivor).resolves.toBe(7);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("aborts underlying queued work when its final subscriber cancels", async () => {
    const activeGate = deferred<void>();
    const coordinator = new QueryLifecycleCoordinator({ maxConcurrent: 1, dedupeTtlMs: 0 });
    const active = coordinator.execute({ key: "active", priority: "foreground", execute: () => activeGate.promise });
    const controller = new AbortController();
    const execute = vi.fn(async () => "never");
    const queued = coordinator.execute({ key: "queued", priority: "background", execute, signal: controller.signal });

    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "cancelled" });
    activeGate.resolve();
    await active;
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces hard timeout and aborts transport signal", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const coordinator = new QueryLifecycleCoordinator({ timeoutMs: 25, dedupeTtlMs: 0 });
      const result = coordinator.execute({
        key: "slow",
        priority: "foreground",
        execute: (signal) => {
          observedSignal = signal;
          return new Promise<number>(() => undefined);
        },
      });
      const assertion = expect(result).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(observedSignal?.aborted).toBe(true);
      expect(coordinator.snapshot().timedOut).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses a recent successful result only within configured TTL", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(async () => 11);
      const coordinator = new QueryLifecycleCoordinator({ dedupeTtlMs: 100 });
      await expect(coordinator.execute({ key: "cache", priority: "foreground", execute })).resolves.toBe(11);
      await expect(coordinator.execute({ key: "cache", priority: "foreground", execute })).resolves.toBe(11);
      expect(execute).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(101);
      await expect(coordinator.execute({ key: "cache", priority: "foreground", execute })).resolves.toBe(11);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for invalid keys and after disposal", async () => {
    const coordinator = new QueryLifecycleCoordinator();
    await expect(
      coordinator.execute({ key: "   ", priority: "foreground", execute: async () => 1 }),
    ).rejects.toBeInstanceOf(QueryLifecycleError);
    coordinator.dispose();
    await expect(
      coordinator.execute({ key: "valid", priority: "foreground", execute: async () => 1 }),
    ).rejects.toMatchObject({ code: "disposed" });
  });

  it("disposal rejects active and queued subscribers deterministically", async () => {
    const gate = deferred<void>();
    const coordinator = new QueryLifecycleCoordinator({ maxConcurrent: 1, dedupeTtlMs: 0 });
    const active = coordinator.execute({ key: "active", priority: "foreground", execute: () => gate.promise });
    const queued = coordinator.execute({ key: "queued", priority: "background", execute: async () => undefined });
    coordinator.dispose("shutdown");
    await expect(active).rejects.toMatchObject({ code: "disposed", message: "shutdown" });
    await expect(queued).rejects.toMatchObject({ code: "disposed", message: "shutdown" });
    expect(coordinator.snapshot()).toMatchObject({ active: 1, queued: 0 });
    gate.resolve();
    await Promise.resolve();
  });
});
