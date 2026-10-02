import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShellSessionStore } from './mapWorkspaceShellSessionStore';

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
};

describe('MapWorkspaceShellSessionStore', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns null when no preference exists', () => {
    const store = new MapWorkspaceShellSessionStore({ storage: createMemoryStorage() });
    expect(store.read()).toBeNull();
    expect(store.getDiagnostics()).toMatchObject({ readCount: 1, rejectedCount: 0, failureCount: 0 });
  });

  it('round-trips collapsed state through a versioned payload', () => {
    const storage = createMemoryStorage();
    const store = new MapWorkspaceShellSessionStore({ storage });
    expect(store.write({ collapsed: true })).toBe(true);
    expect(store.read()).toEqual({ collapsed: true });
    expect(store.getDiagnostics()).toMatchObject({ readCount: 1, writeCount: 1, rejectedCount: 0, failureCount: 0 });
  });

  it('round-trips expanded state', () => {
    const storage = createMemoryStorage();
    const store = new MapWorkspaceShellSessionStore({ storage });
    expect(store.write({ collapsed: false })).toBe(true);
    expect(store.read()).toEqual({ collapsed: false });
  });

  it('uses a deterministic versioned default key', () => {
    const storage = createMemoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const store = new MapWorkspaceShellSessionStore({ storage });
    store.write({ collapsed: true });
    expect(setItem).toHaveBeenCalledWith('kentrehberi.workspace-shell.v1', JSON.stringify({ version: 1, collapsed: true }));
  });

  it('accepts a bounded custom key', () => {
    const storage = createMemoryStorage();
    const store = new MapWorkspaceShellSessionStore({ storage, key: 'workspace.test' });
    store.write({ collapsed: true });
    expect(storage.getItem('workspace.test')).not.toBeNull();
  });

  it('falls back to the default key for whitespace keys', () => {
    const storage = createMemoryStorage();
    const store = new MapWorkspaceShellSessionStore({ storage, key: '   ' });
    store.write({ collapsed: true });
    expect(storage.getItem('kentrehberi.workspace-shell.v1')).not.toBeNull();
  });

  it('rejects malformed JSON without throwing', () => {
    const storage = createMemoryStorage();
    storage.setItem('kentrehberi.workspace-shell.v1', '{bad json');
    const store = new MapWorkspaceShellSessionStore({ storage });
    expect(store.read()).toBeNull();
    expect(store.getDiagnostics()).toMatchObject({ failureCount: 1, lastFailureKind: 'SyntaxError' });
  });

  it('rejects payloads with an unknown version', () => {
    const storage = createMemoryStorage();
    storage.setItem('kentrehberi.workspace-shell.v1', JSON.stringify({ version: 2, collapsed: true }));
    const store = new MapWorkspaceShellSessionStore({ storage });
    expect(store.read()).toBeNull();
    expect(store.getDiagnostics().rejectedCount).toBe(1);
  });

  it('rejects payloads without a boolean collapsed field', () => {
    const storage = createMemoryStorage();
    storage.setItem('kentrehberi.workspace-shell.v1', JSON.stringify({ version: 1, collapsed: 'yes' }));
    const store = new MapWorkspaceShellSessionStore({ storage });
    expect(store.read()).toBeNull();
    expect(store.getDiagnostics().rejectedCount).toBe(1);
  });

  it('rejects array payloads', () => {
    const storage = createMemoryStorage();
    storage.setItem('kentrehberi.workspace-shell.v1', JSON.stringify([{ version: 1, collapsed: true }]));
    const store = new MapWorkspaceShellSessionStore({ storage });
    expect(store.read()).toBeNull();
  });

  it('rejects oversized serialized values before parsing', () => {
    const storage = createMemoryStorage();
    storage.setItem('kentrehberi.workspace-shell.v1', 'x'.repeat(300));
    const store = new MapWorkspaceShellSessionStore({ storage, maxSerializedLength: 128 });
    expect(store.read()).toBeNull();
    expect(store.getDiagnostics()).toMatchObject({ rejectedCount: 1, failureCount: 0 });
  });

  it('clamps an unrealistically small serialized budget', () => {
    const storage = createMemoryStorage();
    const store = new MapWorkspaceShellSessionStore({ storage, maxSerializedLength: 1 });
    expect(store.write({ collapsed: true })).toBe(true);
  });

  it('returns false when storage is explicitly unavailable', () => {
    const store = new MapWorkspaceShellSessionStore({ storage: null });
    expect(store.write({ collapsed: true })).toBe(false);
    expect(store.read()).toBeNull();
    expect(store.clear()).toBe(false);
  });

  it('records quota/write failures', () => {
    const quotaError = new DOMException('Quota exceeded', 'QuotaExceededError');
    const storage = createMemoryStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw quotaError; });
    const onError = vi.fn();
    const store = new MapWorkspaceShellSessionStore({ storage, onError });
    expect(store.write({ collapsed: true })).toBe(false);
    expect(onError).toHaveBeenCalledWith(quotaError);
    expect(store.getDiagnostics()).toMatchObject({ failureCount: 1, lastFailureKind: 'QuotaExceededError' });
  });

  it('records read failures from blocked storage', () => {
    const securityError = new DOMException('Blocked', 'SecurityError');
    const storage = createMemoryStorage();
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw securityError; });
    const store = new MapWorkspaceShellSessionStore({ storage });
    expect(store.read()).toBeNull();
    expect(store.getDiagnostics()).toMatchObject({ failureCount: 1, lastFailureKind: 'SecurityError' });
  });

  it('records clear failures', () => {
    const storage = createMemoryStorage();
    vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    const store = new MapWorkspaceShellSessionStore({ storage });
    expect(store.clear()).toBe(false);
    expect(store.getDiagnostics()).toMatchObject({ failureCount: 1, lastFailureKind: 'Error' });
  });

  it('contains reporter failures', () => {
    const storage = createMemoryStorage();
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('read failed'); });
    const store = new MapWorkspaceShellSessionStore({ storage, onError: () => { throw new TypeError('reporter failed'); } });
    expect(store.read()).toBeNull();
    expect(store.getDiagnostics()).toMatchObject({ failureCount: 1, lastFailureKind: 'reporter:TypeError' });
  });

  it('clears the versioned preference', () => {
    const storage = createMemoryStorage();
    const store = new MapWorkspaceShellSessionStore({ storage });
    store.write({ collapsed: true });
    expect(store.clear()).toBe(true);
    expect(store.read()).toBeNull();
  });

  it('returns immutable read snapshots', () => {
    const storage = createMemoryStorage();
    const store = new MapWorkspaceShellSessionStore({ storage });
    store.write({ collapsed: true });
    const result = store.read();
    expect(result).not.toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
  });
});
