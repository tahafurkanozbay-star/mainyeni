import { describe, expect, it, vi } from 'vitest';
import { createShellCommandRegistry, normalizeCommandSearchText, normalizeCommandShortcut } from './commandRegistryRuntime';

describe('normalizeCommandSearchText', () => {
  it.each([
    [' KADIN  DANIŞMA ', 'kadin danisma'],
    ['İstasyon', 'istasyon'],
    ['Wi-Fi!', 'wi-fi'],
    ['', ''],
    [null, ''],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeCommandSearchText(input)).toBe(expected);
  });
});

describe('normalizeCommandShortcut', () => {
  it.each([
    ['ctrl+k', 'Ctrl+K'],
    ['Shift + Ctrl + p', 'Ctrl+Shift+P'],
    ['command+k', 'Meta+K'],
    ['option+enter', 'Alt+Enter'],
    ['esc', 'Escape'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeCommandShortcut(input)).toBe(expected);
  });

  it('returns null for missing shortcuts', () => {
    expect(normalizeCommandShortcut(undefined)).toBeNull();
    expect(normalizeCommandShortcut(' ')).toBeNull();
  });

  it('rejects shortcuts with multiple non-modifier keys', () => {
    expect(() => normalizeCommandShortcut('Ctrl+K+P')).toThrow(/exactly one/i);
  });
});

describe('createShellCommandRegistry', () => {
  it('registers commands and exposes immutable snapshots', () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'map.zoom', label: 'Haritaya Yaklaş', execute: () => undefined });
    const snapshot = registry.snapshot();
    expect(snapshot).toMatchObject({ revision: 1, commandCount: 1, shortcutCount: 0 });
    expect(snapshot.commands[0]).toMatchObject({ id: 'map.zoom', label: 'Haritaya Yaklaş', enabled: true });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.commands)).toBe(true);
  });

  it('register returns an idempotent unregister handle', () => {
    const registry = createShellCommandRegistry();
    const unregister = registry.register({ id: 'x', label: 'X', execute: () => undefined });
    expect(unregister()).toBe(true);
    expect(unregister()).toBe(false);
    expect(registry.has('x')).toBe(false);
  });

  it('rejects duplicate command ids', () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'x', label: 'X', execute: () => undefined });
    expect(() => registry.register({ id: 'x', label: 'Y', execute: () => undefined })).toThrow(/already registered/i);
  });

  it('rejects duplicate normalized shortcuts', () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'x', label: 'X', shortcut: 'ctrl+k', execute: () => undefined });
    expect(() => registry.register({
      id: 'y',
      label: 'Y',
      shortcut: 'Control + K',
      execute: () => undefined,
    })).toThrow(/shortcut is already/i);
  });

  it('enforces capacity', () => {
    const registry = createShellCommandRegistry({ capacity: 1 });
    registry.register({ id: 'x', label: 'X', execute: () => undefined });
    expect(() => registry.register({ id: 'y', label: 'Y', execute: () => undefined })).toThrow(/capacity/i);
  });

  it('clamps capacity', () => {
    expect(createShellCommandRegistry({ capacity: 0 }).snapshot().commandCount).toBe(0);
    const registry = createShellCommandRegistry({ capacity: 9999 });
    for (let index = 0; index < 500; index += 1) {
      registry.register({ id: `x-${index}`, label: `X ${index}`, execute: () => undefined });
    }
    expect(() => registry.register({ id: 'overflow', label: 'Overflow', execute: () => undefined })).toThrow(/capacity/i);
  });

  it('rejects missing execute handlers', () => {
    expect(() => createShellCommandRegistry().register({
      id: 'x',
      label: 'X',
      execute: null as never,
    })).toThrow(/execute/i);
  });

  it('rejects blank ids and labels', () => {
    const registry = createShellCommandRegistry();
    expect(() => registry.register({ id: ' ', label: 'X', execute: () => undefined })).toThrow(/empty/i);
    expect(() => registry.register({ id: 'x', label: ' ', execute: () => undefined })).toThrow(/empty/i);
  });

  it('searches labels using Turkish normalization', () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'women', label: 'Kadın Danışma Merkezi', execute: () => undefined });
    expect(registry.search('KADIN').map((item) => item.id)).toEqual(['women']);
  });

  it('searches descriptions, groups and keywords', () => {
    const registry = createShellCommandRegistry();
    registry.register({
      id: 'measure',
      label: 'Ölçüm',
      description: 'Haritada mesafe ölç',
      group: 'GIS Araçları',
      keywords: ['uzunluk', 'distance'],
      execute: () => undefined,
    });
    expect(registry.search('mesafe').map((item) => item.id)).toEqual(['measure']);
    expect(registry.search('gis araçları').map((item) => item.id)).toEqual(['measure']);
    expect(registry.search('distance').map((item) => item.id)).toEqual(['measure']);
  });

  it('requires all query tokens', () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'measure', label: 'Harita Ölçüm', execute: () => undefined });
    expect(registry.search('harita ölçüm')).toHaveLength(1);
    expect(registry.search('harita yazdır')).toHaveLength(0);
  });

  it('returns no commands for blank search', () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'x', label: 'X', execute: () => undefined });
    expect(registry.search('   ')).toEqual([]);
  });

  it('ranks enabled commands before disabled commands', () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'disabled', label: 'Harita A', enabled: () => false, execute: () => undefined });
    registry.register({ id: 'enabled', label: 'Harita B', execute: () => undefined });
    expect(registry.search('harita').map((item) => item.id)).toEqual(['enabled', 'disabled']);
  });

  it('ranks priority before weaker text rank within enabled commands', () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'low', label: 'Harita', priority: 0, execute: () => undefined });
    registry.register({ id: 'high', label: 'Harita Aracı', priority: 10, execute: () => undefined });
    expect(registry.search('harita')[0]?.id).toBe('high');
  });

  it('clamps priority', () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'high', label: 'High', priority: 999, execute: () => undefined });
    registry.register({ id: 'low', label: 'Low', priority: -999, execute: () => undefined });
    const snapshot = registry.snapshot();
    expect(snapshot.commands.find((item) => item.id === 'high')?.score).toBe(100_000);
    expect(snapshot.commands.find((item) => item.id === 'low')?.score).toBe(-100_000);
  });

  it('enforces search result limits', () => {
    const registry = createShellCommandRegistry();
    for (let index = 0; index < 10; index += 1) {
      registry.register({ id: `x-${index}`, label: `Harita ${index}`, execute: () => undefined });
    }
    expect(registry.search('harita', {}, 3)).toHaveLength(3);
  });

  it('resolves normalized shortcuts', () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'palette', label: 'Komut Paleti', shortcut: 'Ctrl+Shift+P', execute: () => undefined });
    expect(registry.resolveShortcut('shift+control+p')?.id).toBe('palette');
    expect(registry.resolveShortcut('Ctrl+K')).toBeNull();
  });

  it('reflects enabled predicate in shortcut matches', () => {
    const registry = createShellCommandRegistry();
    registry.register({
      id: 'admin',
      label: 'Admin',
      shortcut: 'Ctrl+A',
      enabled: (context) => context.allowed === true,
      execute: () => undefined,
    });
    expect(registry.resolveShortcut('Ctrl+A', { allowed: false })?.enabled).toBe(false);
    expect(registry.resolveShortcut('Ctrl+A', { allowed: true })?.enabled).toBe(true);
  });

  it('treats enabled predicate exceptions as disabled', () => {
    const registry = createShellCommandRegistry();
    registry.register({
      id: 'unsafe',
      label: 'Unsafe',
      enabled: () => { throw new Error('bad predicate'); },
      execute: () => undefined,
    });
    expect(registry.search('unsafe')[0]?.enabled).toBe(false);
  });

  it('executes enabled commands', async () => {
    const execute = vi.fn();
    const registry = createShellCommandRegistry();
    registry.register({ id: 'x', label: 'X', execute });
    await expect(registry.execute('x', { value: 1 })).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith({ value: 1 });
  });

  it('does not execute disabled commands', async () => {
    const execute = vi.fn();
    const registry = createShellCommandRegistry();
    registry.register({ id: 'x', label: 'X', enabled: () => false, execute });
    await expect(registry.execute('x')).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns false for missing commands', async () => {
    await expect(createShellCommandRegistry().execute('missing')).resolves.toBe(false);
  });

  it('propagates execution failures while emitting failure event', async () => {
    const events: string[] = [];
    const registry = createShellCommandRegistry();
    registry.subscribe((event) => events.push(event.type));
    registry.register({ id: 'x', label: 'X', execute: () => { throw new Error('boom'); } });
    await expect(registry.execute('x')).rejects.toThrow('boom');
    expect(events).toContain('failed');
  });

  it('emits register, execute and unregister events', async () => {
    const events: string[] = [];
    const registry = createShellCommandRegistry();
    registry.subscribe((event) => events.push(event.type));
    registry.register({ id: 'x', label: 'X', execute: () => undefined });
    await registry.execute('x');
    registry.unregister('x');
    expect(events).toEqual(['registered', 'executed', 'unregistered']);
  });

  it('isolates observer failures', () => {
    const registry = createShellCommandRegistry();
    registry.subscribe(() => { throw new Error('observer'); });
    expect(() => registry.register({ id: 'x', label: 'X', execute: () => undefined })).not.toThrow();
    expect(registry.snapshot().observerFailures).toBe(1);
  });

  it('supports idempotent unsubscribe', () => {
    const registry = createShellCommandRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);
  });

  it('rejects invalid listeners', () => {
    expect(() => createShellCommandRegistry().subscribe(null as never)).toThrow(/listener/i);
  });

  it('fails closed on invalid clocks when events are emitted', () => {
    const registry = createShellCommandRegistry({ now: () => Number.NaN });
    expect(() => registry.register({ id: 'x', label: 'X', execute: () => undefined })).toThrow(/clock/i);
  });

  it('destroy is idempotent and blocks later operations', async () => {
    const registry = createShellCommandRegistry();
    registry.register({ id: 'x', label: 'X', execute: () => undefined });
    registry.destroy();
    expect(() => registry.destroy()).not.toThrow();
    expect(() => registry.snapshot()).toThrow(/destroyed/i);
    await expect(registry.execute('x')).rejects.toThrow(/destroyed/i);
  });

  it('snapshot revisions advance on registration changes', () => {
    const registry = createShellCommandRegistry();
    expect(registry.snapshot().revision).toBe(0);
    const unregister = registry.register({ id: 'x', label: 'X', execute: () => undefined });
    expect(registry.snapshot().revision).toBe(1);
    unregister();
    expect(registry.snapshot().revision).toBe(2);
  });
});
