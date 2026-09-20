import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createLatestTaskGate,
  createOwnedAbortGroup,
  settleTask,
  timeoutSignal,
} from "./taskRuntime";

describe("latest task gate", () => {
  test("supersedes the previous task deterministically", () => {
    const gate = createLatestTaskGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    gate.destroy();
  });

  test("throws for stale tokens", () => {
    const gate = createLatestTaskGate();
    const token = gate.begin();
    gate.cancel();
    expect(() => token.throwIfStale()).toThrow();
  });

  test("destroy is idempotent and blocks future work", () => {
    const gate = createLatestTaskGate();
    const token = gate.begin();
    gate.destroy();
    gate.destroy();
    expect(token.signal.aborted).toBe(true);
    expect(() => gate.begin()).toThrow(/destroy/);
  });
});

describe("owned abort group", () => {
  test("tracks and releases owned signals", () => {
    const group = createOwnedAbortGroup(2);
    const first = group.create("first");
    const second = group.create("second");
    expect(group.size()).toBe(2);
    group.release(first);
    expect(group.size()).toBe(1);
    group.abortAll();
    expect(second.aborted).toBe(true);
    expect(group.size()).toBe(0);
  });

  test("fails closed when capacity is exceeded", () => {
    const group = createOwnedAbortGroup(1);
    group.create();
    expect(() => group.create()).toThrow(/kapasitesi/);
  });
});

describe("timeout signals", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("aborts after the bounded timeout", () => {
    const managed = timeoutSignal(500);
    vi.advanceTimersByTime(499);
    expect(managed.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(managed.signal.aborted).toBe(true);
    expect((managed.signal.reason as DOMException).name).toBe("TimeoutError");
    managed.dispose();
  });

  test("inherits parent cancellation", () => {
    const parent = new AbortController();
    const managed = timeoutSignal(10_000, parent.signal);
    parent.abort(new DOMException("stop", "AbortError"));
    expect(managed.signal.aborted).toBe(true);
    expect(managed.signal.reason).toBe(parent.signal.reason);
    managed.dispose();
  });

  test("dispose cancels timeout ownership", () => {
    const managed = timeoutSignal(100);
    managed.dispose();
    vi.advanceTimersByTime(100);
    expect(managed.signal.aborted).toBe(false);
  });
});

describe("settleTask", () => {
  test("returns fulfilled values", async () => {
    await expect(settleTask(Promise.resolve(4))).resolves.toBe(4);
  });

  test("returns null for rejected work", async () => {
    await expect(settleTask(Promise.reject(new Error("boom")))).resolves.toBeNull();
  });

  test("suppresses results after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(settleTask(Promise.resolve(4), { signal: controller.signal })).resolves.toBeNull();
  });
});
