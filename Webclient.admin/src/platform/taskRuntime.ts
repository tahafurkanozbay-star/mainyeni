import { reportAdminError } from "./diagnostics";

export interface LatestTaskToken {
  readonly id: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  throwIfStale(): void;
}

export interface LatestTaskGate {
  begin(reason?: string): LatestTaskToken;
  cancel(reason?: string): void;
  destroy(): void;
  snapshot(): Readonly<{ activeId: number | null; destroyed: boolean }>;
}

const abortReason = (reason: string): DOMException =>
  new DOMException(reason, "AbortError");

export const createLatestTaskGate = (): LatestTaskGate => {
  let sequence = 0;
  let active: { id: number; controller: AbortController } | null = null;
  let destroyed = false;

  const cancel = (reason = "Superseded"): void => {
    const current = active;
    active = null;
    if (current && !current.controller.signal.aborted) {
      current.controller.abort(abortReason(reason));
    }
  };

  return {
    begin: (reason = "Superseded by a newer task") => {
      if (destroyed) throw new Error("LatestTaskGate destroy edildikten sonra kullanılamaz.");
      cancel(reason);
      const id = ++sequence;
      const controller = new AbortController();
      active = { id, controller };
      return Object.freeze({
        id,
        signal: controller.signal,
        isCurrent: () => !destroyed && active?.id === id && !controller.signal.aborted,
        throwIfStale: () => {
          if (destroyed || active?.id !== id || controller.signal.aborted) {
            throw controller.signal.reason ?? abortReason("Stale task");
          }
        },
      });
    },
    cancel,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      cancel("Task gate destroyed");
    },
    snapshot: () => Object.freeze({ activeId: active?.id ?? null, destroyed }),
  };
};

export interface OwnedAbortGroup {
  create(label?: string): AbortSignal;
  abortAll(reason?: string): void;
  release(signal: AbortSignal): void;
  destroy(): void;
  size(): number;
}

export const createOwnedAbortGroup = (capacity = 32): OwnedAbortGroup => {
  const max = Math.min(128, Math.max(1, Math.trunc(capacity)));
  const controllers = new Map<AbortSignal, AbortController>();
  let destroyed = false;

  return {
    create: (label = "owned-request") => {
      if (destroyed) throw new Error("OwnedAbortGroup destroy edildikten sonra kullanılamaz.");
      if (controllers.size >= max) throw new Error(`OwnedAbortGroup kapasitesi aşıldı: ${max}`);
      const controller = new AbortController();
      controllers.set(controller.signal, controller);
      controller.signal.addEventListener("abort", () => controllers.delete(controller.signal), { once: true });
      Object.defineProperty(controller.signal, "__adminLabel", {
        configurable: false,
        enumerable: false,
        value: label.slice(0, 80),
      });
      return controller.signal;
    },
    release: (signal) => {
      controllers.delete(signal);
    },
    abortAll: (reason = "Owned operation cancelled") => {
      for (const controller of controllers.values()) {
        if (!controller.signal.aborted) controller.abort(abortReason(reason));
      }
      controllers.clear();
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const controller of controllers.values()) {
        if (!controller.signal.aborted) controller.abort(abortReason("Abort group destroyed"));
      }
      controllers.clear();
    },
    size: () => controllers.size,
  };
};

export const timeoutSignal = (
  timeoutMs: number,
  parent?: AbortSignal,
): { readonly signal: AbortSignal; readonly dispose: () => void } => {
  const controller = new AbortController();
  const timeout = Math.min(60_000, Math.max(1, Math.trunc(timeoutMs)));
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Operation exceeded ${timeout} ms`, "TimeoutError"));
  }, timeout);

  const onParentAbort = (): void => {
    controller.abort(parent?.reason ?? abortReason("Parent operation aborted"));
  };
  if (parent) {
    if (parent.aborted) onParentAbort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }

  let disposed = false;
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  });
};

export const settleTask = async <T>(
  task: Promise<T>,
  options: {
    readonly domain?: "auth" | "http" | "gis" | "ui" | "export";
    readonly code?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<T | null> => {
  try {
    const value = await task;
    if (options.signal?.aborted) return null;
    return value;
  } catch (error) {
    if (options.signal?.aborted) return null;
    reportAdminError(options.domain ?? "ui", options.code ?? "task-failure", error);
    return null;
  }
};
