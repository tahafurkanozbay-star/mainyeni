export interface MapWorkspaceShellSessionPreference {
  readonly collapsed: boolean;
}

export interface MapWorkspaceShellSessionDiagnostics {
  readonly readCount: number;
  readonly writeCount: number;
  readonly rejectedCount: number;
  readonly failureCount: number;
  readonly lastFailureKind: string | null;
}

export interface MapWorkspaceShellSessionStoreOptions {
  readonly storage?: Storage | null;
  readonly key?: string;
  readonly maxSerializedLength?: number;
  readonly onError?: (error: unknown) => void;
}

interface SerializedPreference {
  readonly version: 1;
  readonly collapsed: boolean;
}

const DEFAULT_KEY = 'kentrehberi.workspace-shell.v1';
const DEFAULT_MAX_SERIALIZED_LENGTH = 256;
const MAX_SERIALIZED_LENGTH_LIMIT = 2_048;

const clampMaxLength = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SERIALIZED_LENGTH;
  return Math.max(64, Math.min(MAX_SERIALIZED_LENGTH_LIMIT, Math.trunc(value ?? DEFAULT_MAX_SERIALIZED_LENGTH)));
};

const failureKind = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const safeDefaultStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const isSerializedPreference = (value: unknown): value is SerializedPreference => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && typeof candidate.collapsed === 'boolean';
};

export class MapWorkspaceShellSessionStore {
  readonly #storage: Storage | null;
  readonly #key: string;
  readonly #maxSerializedLength: number;
  readonly #onError?: (error: unknown) => void;
  #readCount = 0;
  #writeCount = 0;
  #rejectedCount = 0;
  #failureCount = 0;
  #lastFailureKind: string | null = null;

  constructor(options: MapWorkspaceShellSessionStoreOptions = {}) {
    this.#storage = options.storage === undefined ? safeDefaultStorage() : options.storage;
    this.#key = options.key?.trim() || DEFAULT_KEY;
    this.#maxSerializedLength = clampMaxLength(options.maxSerializedLength);
    this.#onError = options.onError;
  }

  getDiagnostics(): MapWorkspaceShellSessionDiagnostics {
    return Object.freeze({
      readCount: this.#readCount,
      writeCount: this.#writeCount,
      rejectedCount: this.#rejectedCount,
      failureCount: this.#failureCount,
      lastFailureKind: this.#lastFailureKind,
    });
  }

  read(): MapWorkspaceShellSessionPreference | null {
    this.#readCount += 1;
    if (!this.#storage) return null;
    try {
      const raw = this.#storage.getItem(this.#key);
      if (!raw) return null;
      if (raw.length > this.#maxSerializedLength) {
        this.#rejectedCount += 1;
        return null;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isSerializedPreference(parsed)) {
        this.#rejectedCount += 1;
        return null;
      }
      return Object.freeze({ collapsed: parsed.collapsed });
    } catch (error) {
      this.#recordFailure(error);
      return null;
    }
  }

  write(preference: MapWorkspaceShellSessionPreference): boolean {
    if (!this.#storage) return false;
    const payload: SerializedPreference = Object.freeze({ version: 1, collapsed: preference.collapsed === true });
    const serialized = JSON.stringify(payload);
    if (serialized.length > this.#maxSerializedLength) {
      this.#rejectedCount += 1;
      return false;
    }
    try {
      this.#storage.setItem(this.#key, serialized);
      this.#writeCount += 1;
      return true;
    } catch (error) {
      this.#recordFailure(error);
      return false;
    }
  }

  clear(): boolean {
    if (!this.#storage) return false;
    try {
      this.#storage.removeItem(this.#key);
      return true;
    } catch (error) {
      this.#recordFailure(error);
      return false;
    }
  }

  #recordFailure(error: unknown): void {
    this.#failureCount += 1;
    this.#lastFailureKind = failureKind(error);
    if (!this.#onError) return;
    try {
      this.#onError(error);
    } catch (reporterError) {
      this.#lastFailureKind = `reporter:${failureKind(reporterError)}`;
    }
  }
}
