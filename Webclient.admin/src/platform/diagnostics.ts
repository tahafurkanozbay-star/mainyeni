import { safeErrorMessage, toJsonSafe, type JsonValue } from "./contracts";

export type DiagnosticLevel = "debug" | "info" | "warning" | "error";
export type DiagnosticDomain = "bootstrap" | "auth" | "http" | "routing" | "ui" | "gis" | "export" | "storage";

export interface DiagnosticEvent {
  readonly id: number;
  readonly timestamp: number;
  readonly level: DiagnosticLevel;
  readonly domain: DiagnosticDomain;
  readonly code: string;
  readonly message: string;
  readonly detail: JsonValue | null;
}

export interface DiagnosticInput {
  readonly level?: DiagnosticLevel;
  readonly domain: DiagnosticDomain;
  readonly code: string;
  readonly message: string;
  readonly detail?: unknown;
}

export interface DiagnosticSnapshot {
  readonly size: number;
  readonly dropped: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly latest: DiagnosticEvent | null;
  readonly events: readonly DiagnosticEvent[];
}

export interface DiagnosticJournalOptions {
  readonly capacity?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: DiagnosticEvent) => void;
}

const sanitizeCode = (value: string): string => {
  const normalized = value.trim().replace(/[^a-z0-9:_-]+/giu, "-").replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 80) || "unknown";
};

const sanitizeMessage = (value: string): string => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.slice(0, 500);
};

export class DiagnosticJournal {
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly onEvent: ((event: DiagnosticEvent) => void) | undefined;
  private readonly events: DiagnosticEvent[] = [];
  private sequence = 0;
  private dropped = 0;

  constructor(options: DiagnosticJournalOptions = {}) {
    this.capacity = Math.min(500, Math.max(10, Math.trunc(options.capacity ?? 100)));
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
  }

  record(input: DiagnosticInput): DiagnosticEvent {
    const event = Object.freeze({
      id: ++this.sequence,
      timestamp: this.now(),
      level: input.level ?? "info",
      domain: input.domain,
      code: sanitizeCode(input.code),
      message: sanitizeMessage(input.message),
      detail: input.detail === undefined ? null : toJsonSafe(input.detail),
    }) satisfies DiagnosticEvent;

    this.events.push(event);
    while (this.events.length > this.capacity) {
      this.events.shift();
      this.dropped += 1;
    }

    try {
      this.onEvent?.(event);
    } catch {
      // Diagnostic observers must never destabilize the admin runtime.
    }
    return event;
  }

  error(domain: DiagnosticDomain, code: string, error: unknown, detail?: unknown): DiagnosticEvent {
    return this.record({
      level: "error",
      domain,
      code,
      message: safeErrorMessage(error),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  warning(domain: DiagnosticDomain, code: string, message: string, detail?: unknown): DiagnosticEvent {
    return this.record({
      level: "warning",
      domain,
      code,
      message,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  clear(): void {
    this.events.splice(0);
    this.dropped = 0;
  }

  snapshot(limit = this.capacity): DiagnosticSnapshot {
    const safeLimit = Math.min(this.capacity, Math.max(0, Math.trunc(limit)));
    const selected = this.events.slice(Math.max(0, this.events.length - safeLimit));
    return Object.freeze({
      size: this.events.length,
      dropped: this.dropped,
      errorCount: this.events.filter((event) => event.level === "error").length,
      warningCount: this.events.filter((event) => event.level === "warning").length,
      latest: this.events.at(-1) ?? null,
      events: Object.freeze([...selected]),
    });
  }
}

export const adminDiagnostics = new DiagnosticJournal();

export const reportAdminError = (
  domain: DiagnosticDomain,
  code: string,
  error: unknown,
  detail?: unknown,
): void => {
  adminDiagnostics.error(domain, code, error, detail);
  if (typeof globalThis.reportError === "function") {
    try {
      globalThis.reportError(error instanceof Error ? error : new Error(safeErrorMessage(error)));
    } catch {
      // The platform reporting hook is optional and must not throw into product code.
    }
  }
};
