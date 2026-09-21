export const ADMIN_SESSION_STORAGE_KEY = '_cviaıq34gmx';

export interface AdminSession {
  readonly accessToken: string;
  readonly userName?: string;
  readonly [key: string]: unknown;
}

const isAdminSession = (value: unknown): value is AdminSession => {
  if (typeof value !== 'object' || value === null) return false;
  const accessToken = (value as { accessToken?: unknown }).accessToken;
  return typeof accessToken === 'string' && accessToken.length > 0;
};

const removeStorageKey = (storage: Storage | undefined): void => {
  if (!storage) return;
  try {
    storage.removeItem(ADMIN_SESSION_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
};

const clearLegacyPersistentSession = (): void => {
  try {
    removeStorageKey(globalThis.localStorage);
  } catch {
    // Accessing localStorage itself can throw for restricted origins.
  }
};

export const clearAdminSession = (): void => {
  try {
    removeStorageKey(globalThis.sessionStorage);
  } catch {
    // Accessing sessionStorage itself can throw for restricted origins.
  }
  clearLegacyPersistentSession();
};

export const readAdminSession = (): AdminSession | null => {
  clearLegacyPersistentSession();

  try {
    const serialized = globalThis.sessionStorage?.getItem(ADMIN_SESSION_STORAGE_KEY);
    if (!serialized) return null;

    const candidate: unknown = JSON.parse(serialized);
    if (!isAdminSession(candidate)) {
      clearAdminSession();
      return null;
    }

    return Object.freeze({ ...candidate });
  } catch {
    clearAdminSession();
    return null;
  }
};

export const writeAdminSession = (session: unknown): boolean => {
  clearLegacyPersistentSession();

  if (!isAdminSession(session)) {
    clearAdminSession();
    return false;
  }

  try {
    globalThis.sessionStorage?.setItem(
      ADMIN_SESSION_STORAGE_KEY,
      JSON.stringify(session),
    );
    return true;
  } catch {
    clearAdminSession();
    return false;
  }
};
