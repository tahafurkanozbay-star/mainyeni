import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceAccessibilityPreferenceSession,
  createWorkspaceAccessibilityPreferenceStorage,
  workspaceAccessibilityPreferenceDefaults,
  workspaceAccessibilityPreferenceStorageLimit,
  type WorkspaceAccessibilityPreferenceStorage,
} from './workspaceAccessibilityPreferencesModel';

const memoryStorage = (initial: string | null = null) => {
  let value = initial;
  return {
    storage: Object.freeze({
      read: vi.fn(() => value),
      write: vi.fn((next: string) => { value = next; }),
      remove: vi.fn(() => { value = null; }),
    }) satisfies WorkspaceAccessibilityPreferenceStorage,
    value: () => value,
  };
};

describe('workspaceAccessibilityPreferencesModel', () => {
  it('starts with safe visual-only defaults', () => {
    const session = createWorkspaceAccessibilityPreferenceSession();
    expect(session.snapshot()).toEqual({
      showStatusCenter: false,
      showKeyboardGuide: true,
      autoRevealOnOffline: true,
      autoRevealOnMapBusy: false,
      sequence: 0,
    });
    expect(Object.isFrozen(session.snapshot())).toBe(true);
  });

  it('updates one preference without mutating the previous snapshot', () => {
    const session = createWorkspaceAccessibilityPreferenceSession();
    const before = session.snapshot();
    const after = session.update({ showStatusCenter: true });
    expect(before.showStatusCenter).toBe(false);
    expect(after.showStatusCenter).toBe(true);
    expect(after.sequence).toBe(1);
    expect(after).not.toBe(before);
  });

  it('returns the same snapshot for an idempotent patch', () => {
    const session = createWorkspaceAccessibilityPreferenceSession();
    const before = session.snapshot();
    expect(session.update({ showKeyboardGuide: true })).toBe(before);
  });

  it('persists a compact versioned payload', () => {
    const memory = memoryStorage();
    const session = createWorkspaceAccessibilityPreferenceSession(memory.storage);
    session.update({ showStatusCenter: true, autoRevealOnMapBusy: true });
    expect(memory.storage.write).toHaveBeenCalledTimes(1);
    expect(memory.value()).toBe('{"v":1,"s":1,"k":1,"o":1,"b":1}');
    expect(memory.value()!.length).toBeLessThan(workspaceAccessibilityPreferenceStorageLimit());
  });

  it('hydrates only the bounded canonical schema', () => {
    const memory = memoryStorage('{"v":1,"s":1,"k":0,"o":0,"b":1}');
    const session = createWorkspaceAccessibilityPreferenceSession(memory.storage);
    expect(session.snapshot()).toMatchObject({
      showStatusCenter: true,
      showKeyboardGuide: false,
      autoRevealOnOffline: false,
      autoRevealOnMapBusy: true,
    });
  });

  it('rejects unknown versions instead of guessing migration semantics', () => {
    const memory = memoryStorage('{"v":99,"s":1,"k":0,"o":0,"b":1}');
    const session = createWorkspaceAccessibilityPreferenceSession(memory.storage);
    expect(session.snapshot()).toEqual(workspaceAccessibilityPreferenceDefaults());
    expect(session.diagnostics().rejectedPayloads).toBe(1);
    expect(session.diagnostics().lastFailureKind).toBe('parse');
  });

  it('rejects non-binary flags fail closed', () => {
    const memory = memoryStorage('{"v":1,"s":"yes","k":1,"o":1,"b":0}');
    const session = createWorkspaceAccessibilityPreferenceSession(memory.storage);
    expect(session.snapshot().showStatusCenter).toBe(false);
    expect(session.diagnostics().rejectedPayloads).toBe(1);
  });

  it('rejects oversized storage payloads before parsing', () => {
    const memory = memoryStorage('x'.repeat(workspaceAccessibilityPreferenceStorageLimit() + 1));
    const session = createWorkspaceAccessibilityPreferenceSession(memory.storage);
    expect(session.snapshot()).toEqual(workspaceAccessibilityPreferenceDefaults());
    expect(session.diagnostics().lastFailureKind).toBe('size');
  });

  it('isolates storage read failures', () => {
    const storage: WorkspaceAccessibilityPreferenceStorage = {
      read: () => { throw new Error('blocked'); },
      write: vi.fn(),
    };
    const session = createWorkspaceAccessibilityPreferenceSession(storage);
    expect(session.snapshot()).toEqual(workspaceAccessibilityPreferenceDefaults());
    expect(session.diagnostics().readFailures).toBe(1);
    expect(session.diagnostics().lastFailureKind).toBe('read');
  });

  it('isolates storage write failures while retaining in-memory state', () => {
    const storage: WorkspaceAccessibilityPreferenceStorage = {
      read: () => null,
      write: () => { throw new Error('quota'); },
    };
    const session = createWorkspaceAccessibilityPreferenceSession(storage);
    const after = session.update({ showStatusCenter: true });
    expect(after.showStatusCenter).toBe(true);
    expect(session.diagnostics().writeFailures).toBe(1);
    expect(session.diagnostics().lastFailureKind).toBe('write');
  });

  it('notifies healthy listeners when another listener throws', () => {
    const session = createWorkspaceAccessibilityPreferenceSession();
    const healthy = vi.fn();
    session.subscribe(() => { throw new Error('listener'); });
    session.subscribe(healthy);
    session.update({ showStatusCenter: true });
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(session.diagnostics().listenerFailures).toBe(1);
    expect(session.diagnostics().lastFailureKind).toBe('listener');
  });

  it('tracks active listener diagnostics and cleanup', () => {
    const session = createWorkspaceAccessibilityPreferenceSession();
    const unsubscribe = session.subscribe(() => undefined);
    expect(session.diagnostics().activeListeners).toBe(1);
    unsubscribe();
    expect(session.diagnostics().activeListeners).toBe(0);
  });

  it('bounds listener cardinality', () => {
    const session = createWorkspaceAccessibilityPreferenceSession();
    for (let index = 0; index < 30; index += 1) session.subscribe(() => undefined);
    expect(session.diagnostics().activeListeners).toBe(24);
    expect(session.diagnostics().rejectedListeners).toBe(6);
  });

  it('resets preferences and removes persisted state when supported', () => {
    const memory = memoryStorage();
    const session = createWorkspaceAccessibilityPreferenceSession(memory.storage);
    session.update({ showKeyboardGuide: false, autoRevealOnOffline: false });
    const reset = session.reset();
    expect(reset).toMatchObject({
      showKeyboardGuide: true,
      autoRevealOnOffline: true,
      showStatusCenter: false,
      autoRevealOnMapBusy: false,
    });
    expect(memory.storage.remove).toHaveBeenCalledTimes(1);
  });

  it('does not notify on a no-op reset', () => {
    const session = createWorkspaceAccessibilityPreferenceSession();
    const listener = vi.fn();
    session.subscribe(listener);
    session.reset();
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops publishing after dispose', () => {
    const session = createWorkspaceAccessibilityPreferenceSession();
    const listener = vi.fn();
    session.subscribe(listener);
    const before = session.snapshot();
    session.dispose();
    expect(session.update({ showStatusCenter: true })).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(session.diagnostics().activeListeners).toBe(0);
  });

  it('adapts browser Storage without exposing unrelated keys', () => {
    const browserStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    } as unknown as Storage;
    const adapter = createWorkspaceAccessibilityPreferenceStorage(browserStorage, 'safe-key');
    expect(adapter).not.toBeNull();
    adapter!.read();
    adapter!.write('{}');
    adapter!.remove?.();
    expect(browserStorage.getItem).toHaveBeenCalledWith('safe-key');
    expect(browserStorage.setItem).toHaveBeenCalledWith('safe-key', '{}');
    expect(browserStorage.removeItem).toHaveBeenCalledWith('safe-key');
  });

  it('returns null when browser storage is unavailable', () => {
    expect(createWorkspaceAccessibilityPreferenceStorage(null)).toBeNull();
    expect(createWorkspaceAccessibilityPreferenceStorage(undefined)).toBeNull();
  });
});
