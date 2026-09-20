import { asAdminSession, type AdminSession } from "./contracts";
import { reportAdminError } from "./diagnostics";
import { runtimeConfig } from "./runtimeConfig";

export type SessionChangeReason =
  | "initialized"
  | "login"
  | "logout"
  | "expired"
  | "invalid"
  | "storage-unavailable";

export interface SessionSnapshot {
  readonly session: AdminSession | null;
  readonly authenticated: boolean;
  readonly reason: SessionChangeReason;
}

export interface AuthSessionStoreOptions {
  readonly key?: string;
  readonly sessionStorage?: Storage | null;
  readonly localStorage?: Storage | null;
  readonly now?: () => number;
}

export interface AuthSessionStore {
  read(): AdminSession | null;
  write(value: unknown): boolean;
  clear(reason?: SessionChangeReason): void;
  snapshot(): SessionSnapshot;
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void;
}

const parseExpiry = (session: AdminSession): number | null => {
  if (!session.expiresAt) return null;
  const timestamp = Date.parse(session.expiresAt);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const safeRemove = (storage: Storage | null, key: string): boolean => {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch (error) {
    reportAdminError("storage", "session-remove-failed", error);
    return false;
  }
};

export const createAuthSessionStore = (options: AuthSessionStoreOptions = {}): AuthSessionStore => {
  const key = options.key ?? runtimeConfig.sessionStorageKey;
  const sessionStorage = options.sessionStorage
    ?? (typeof window === "undefined" ? null : window.sessionStorage);
  const localStorage = options.localStorage
    ?? (typeof window === "undefined" ? null : window.localStorage);
  const now = options.now ?? Date.now;
  const listeners = new Set<(snapshot: SessionSnapshot) => void>();
  let current: AdminSession | null = null;
  let reason: SessionChangeReason = "initialized";

  const emit = (): void => {
    const snapshot = Object.freeze({
      session: current,
      authenticated: current !== null,
      reason,
    }) satisfies SessionSnapshot;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        reportAdminError("auth", "session-listener-failed", error);
      }
    }
  };

  const clearPersistentLegacy = (): void => {
    safeRemove(localStorage, key);
  };

  const clear = (nextReason: SessionChangeReason = "logout"): void => {
    safeRemove(sessionStorage, key);
    clearPersistentLegacy();
    current = null;
    reason = nextReason;
    emit();
  };

  const read = (): AdminSession | null => {
    clearPersistentLegacy();
    if (!sessionStorage) {
      current = null;
      reason = "storage-unavailable";
      return null;
    }

    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(key);
    } catch (error) {
      current = null;
      reason = "storage-unavailable";
      reportAdminError("storage", "session-read-failed", error);
      return null;
    }
    if (!raw) {
      current = null;
      reason = "initialized";
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      clear("invalid");
      return null;
    }
    const session = asAdminSession(parsed);
    if (!session) {
      clear("invalid");
      return null;
    }
    const expiresAt = parseExpiry(session);
    if (expiresAt !== null && expiresAt <= now()) {
      clear("expired");
      return null;
    }

    current = session;
    reason = "initialized";
    return current;
  };

  const write = (value: unknown): boolean => {
    clearPersistentLegacy();
    const session = asAdminSession(value);
    if (!session || !sessionStorage) {
      clear(session ? "storage-unavailable" : "invalid");
      return false;
    }
    const expiresAt = parseExpiry(session);
    if (expiresAt !== null && expiresAt <= now()) {
      clear("expired");
      return false;
    }

    try {
      sessionStorage.setItem(key, JSON.stringify(session));
      current = session;
      reason = "login";
      emit();
      return true;
    } catch (error) {
      reportAdminError("storage", "session-write-failed", error);
      clear("storage-unavailable");
      return false;
    }
  };

  return Object.freeze({
    read,
    write,
    clear,
    snapshot: () => Object.freeze({
      session: current,
      authenticated: current !== null,
      reason,
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
};

export const authSessionStore = createAuthSessionStore();
