export interface WorkspaceAccessibilityPreferences {
  readonly showStatusCenter: boolean;
  readonly showKeyboardGuide: boolean;
  readonly autoRevealOnOffline: boolean;
  readonly autoRevealOnMapBusy: boolean;
  readonly sequence: number;
}

export interface WorkspaceAccessibilityPreferencePatch {
  readonly showStatusCenter?: boolean;
  readonly showKeyboardGuide?: boolean;
  readonly autoRevealOnOffline?: boolean;
  readonly autoRevealOnMapBusy?: boolean;
}

export interface WorkspaceAccessibilityPreferenceStorage {
  readonly read: () => string | null;
  readonly write: (value: string) => void;
  readonly remove?: () => void;
}

export interface WorkspaceAccessibilityPreferenceDiagnostics {
  readonly readFailures: number;
  readonly writeFailures: number;
  readonly listenerFailures: number;
  readonly rejectedListeners: number;
  readonly rejectedPayloads: number;
  readonly activeListeners: number;
  readonly lastFailureKind: 'read' | 'write' | 'listener' | 'parse' | 'shape' | 'size' | null;
}

export interface WorkspaceAccessibilityPreferenceSession {
  readonly snapshot: () => WorkspaceAccessibilityPreferences;
  readonly diagnostics: () => WorkspaceAccessibilityPreferenceDiagnostics;
  readonly update: (patch: WorkspaceAccessibilityPreferencePatch) => WorkspaceAccessibilityPreferences;
  readonly reset: () => WorkspaceAccessibilityPreferences;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

const STORAGE_VERSION = 1;
const MAX_STORAGE_BYTES = 256;
const MAX_LISTENERS = 24;

const DEFAULTS: WorkspaceAccessibilityPreferences = Object.freeze({
  showStatusCenter: false,
  showKeyboardGuide: true,
  autoRevealOnOffline: true,
  autoRevealOnMapBusy: false,
  sequence: 0,
});

const DEFAULT_DIAGNOSTICS: WorkspaceAccessibilityPreferenceDiagnostics = Object.freeze({
  readFailures: 0,
  writeFailures: 0,
  listenerFailures: 0,
  rejectedListeners: 0,
  rejectedPayloads: 0,
  activeListeners: 0,
  lastFailureKind: null,
});

const freezePreferences = (
  value: Omit<WorkspaceAccessibilityPreferences, 'sequence'>,
  sequence: number,
): WorkspaceAccessibilityPreferences => Object.freeze({ ...value, sequence });

const encode = (value: WorkspaceAccessibilityPreferences): string => JSON.stringify({
  v: STORAGE_VERSION,
  s: value.showStatusCenter ? 1 : 0,
  k: value.showKeyboardGuide ? 1 : 0,
  o: value.autoRevealOnOffline ? 1 : 0,
  b: value.autoRevealOnMapBusy ? 1 : 0,
});

const isBinaryFlag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;

const decode = (raw: string): Omit<WorkspaceAccessibilityPreferences, 'sequence'> | null => {
  if (raw.length === 0 || raw.length > MAX_STORAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== STORAGE_VERSION) return null;
  if (![record.s, record.k, record.o, record.b].every(isBinaryFlag)) return null;
  return {
    showStatusCenter: record.s === 1,
    showKeyboardGuide: record.k === 1,
    autoRevealOnOffline: record.o === 1,
    autoRevealOnMapBusy: record.b === 1,
  };
};

const mergePatch = (
  current: WorkspaceAccessibilityPreferences,
  patch: WorkspaceAccessibilityPreferencePatch,
): Omit<WorkspaceAccessibilityPreferences, 'sequence'> => ({
  showStatusCenter: patch.showStatusCenter ?? current.showStatusCenter,
  showKeyboardGuide: patch.showKeyboardGuide ?? current.showKeyboardGuide,
  autoRevealOnOffline: patch.autoRevealOnOffline ?? current.autoRevealOnOffline,
  autoRevealOnMapBusy: patch.autoRevealOnMapBusy ?? current.autoRevealOnMapBusy,
});

const samePreferences = (
  left: WorkspaceAccessibilityPreferences,
  right: Omit<WorkspaceAccessibilityPreferences, 'sequence'>,
): boolean => (
  left.showStatusCenter === right.showStatusCenter
  && left.showKeyboardGuide === right.showKeyboardGuide
  && left.autoRevealOnOffline === right.autoRevealOnOffline
  && left.autoRevealOnMapBusy === right.autoRevealOnMapBusy
);

export const createWorkspaceAccessibilityPreferenceStorage = (
  storage: Storage | null | undefined,
  key = 'kentrehberi:workspace-accessibility:v1',
): WorkspaceAccessibilityPreferenceStorage | null => {
  if (!storage) return null;
  return Object.freeze({
    read: () => storage.getItem(key),
    write: (value: string) => storage.setItem(key, value),
    remove: () => storage.removeItem(key),
  });
};

export const createWorkspaceAccessibilityPreferenceSession = (
  storage: WorkspaceAccessibilityPreferenceStorage | null = null,
): WorkspaceAccessibilityPreferenceSession => {
  let current = DEFAULTS;
  let currentDiagnostics = DEFAULT_DIAGNOSTICS;
  let disposed = false;
  const listeners = new Set<() => void>();

  const setDiagnostics = (
    patch: Partial<WorkspaceAccessibilityPreferenceDiagnostics>,
  ): void => {
    currentDiagnostics = Object.freeze({ ...currentDiagnostics, ...patch });
  };

  const syncListenerCount = (): void => {
    if (currentDiagnostics.activeListeners === listeners.size) return;
    setDiagnostics({ activeListeners: listeners.size });
  };

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        setDiagnostics({
          listenerFailures: currentDiagnostics.listenerFailures + 1,
          lastFailureKind: 'listener',
        });
      }
    }
  };

  const persist = (): void => {
    if (!storage || disposed) return;
    try {
      const payload = encode(current);
      if (payload.length > MAX_STORAGE_BYTES) {
        setDiagnostics({
          rejectedPayloads: currentDiagnostics.rejectedPayloads + 1,
          lastFailureKind: 'size',
        });
        return;
      }
      storage.write(payload);
    } catch {
      setDiagnostics({
        writeFailures: currentDiagnostics.writeFailures + 1,
        lastFailureKind: 'write',
      });
    }
  };

  if (storage) {
    try {
      const raw = storage.read();
      if (raw) {
        const decoded = decode(raw);
        if (decoded) {
          current = freezePreferences(decoded, 0);
        } else {
          setDiagnostics({
            rejectedPayloads: currentDiagnostics.rejectedPayloads + 1,
            lastFailureKind: raw.length > MAX_STORAGE_BYTES ? 'size' : 'parse',
          });
        }
      }
    } catch {
      setDiagnostics({
        readFailures: currentDiagnostics.readFailures + 1,
        lastFailureKind: 'read',
      });
    }
  }

  const update = (patch: WorkspaceAccessibilityPreferencePatch): WorkspaceAccessibilityPreferences => {
    if (disposed) return current;
    const nextValue = mergePatch(current, patch);
    if (samePreferences(current, nextValue)) return current;
    current = freezePreferences(nextValue, current.sequence + 1);
    persist();
    notify();
    return current;
  };

  const reset = (): WorkspaceAccessibilityPreferences => {
    if (disposed) return current;
    const nextValue = {
      showStatusCenter: DEFAULTS.showStatusCenter,
      showKeyboardGuide: DEFAULTS.showKeyboardGuide,
      autoRevealOnOffline: DEFAULTS.autoRevealOnOffline,
      autoRevealOnMapBusy: DEFAULTS.autoRevealOnMapBusy,
    };
    if (samePreferences(current, nextValue)) return current;
    current = freezePreferences(nextValue, current.sequence + 1);
    if (storage?.remove) {
      try {
        storage.remove();
      } catch {
        setDiagnostics({
          writeFailures: currentDiagnostics.writeFailures + 1,
          lastFailureKind: 'write',
        });
      }
    } else {
      persist();
    }
    notify();
    return current;
  };

  return Object.freeze({
    snapshot: () => current,
    diagnostics: () => currentDiagnostics,
    update,
    reset,
    subscribe(listener: () => void): () => void {
      if (disposed) return () => undefined;
      if (listeners.size >= MAX_LISTENERS && !listeners.has(listener)) {
        setDiagnostics({
          rejectedListeners: currentDiagnostics.rejectedListeners + 1,
        });
        return () => undefined;
      }
      listeners.add(listener);
      syncListenerCount();
      return () => {
        if (!listeners.delete(listener)) return;
        syncListenerCount();
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      syncListenerCount();
    },
  });
};

export const workspaceAccessibilityPreferenceDefaults = (): WorkspaceAccessibilityPreferences => DEFAULTS;
export const workspaceAccessibilityPreferenceStorageLimit = (): number => MAX_STORAGE_BYTES;
