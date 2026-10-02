import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceAccessibilityRuntime } from './workspaceAccessibilityRuntime';

const installMatchMedia = (): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
};

describe('WorkspaceAccessibilityRuntime surface lifecycle', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('opens and closes one governed dialog with stable announcements', () => {
    installMatchMedia();
    const runtime = new WorkspaceAccessibilityRuntime({ document, window, now: () => 1_000 });
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.setDialogDepth(1);
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(1);
    expect(runtime.getSnapshot().accessibility.focusZone).toBe('dialog');
    expect(runtime.getSnapshot().politeAnnouncement).toBe('İletişim penceresi açıldı.');
    runtime.setDialogDepth(0);
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(0);
    expect(runtime.getSnapshot().liveRegions.polite.some((item) => item.text === 'İletişim penceresi kapatıldı.')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('supports nested dialog depth without repeating first-open announcements', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window, now: () => 2_000 });
    runtime.setDialogDepth(3);
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(3);
    expect(runtime.getSnapshot().liveRegions.polite.filter((item) => item.text === 'İletişim penceresi açıldı.')).toHaveLength(1);
    runtime.setDialogDepth(2);
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(2);
    expect(runtime.getSnapshot().liveRegions.polite.some((item) => item.text === 'İletişim penceresi kapatıldı.')).toBe(false);
    runtime.setDialogDepth(0);
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(0);
    expect(runtime.getSnapshot().liveRegions.polite.some((item) => item.text === 'İletişim penceresi kapatıldı.')).toBe(true);
  });

  it('bounds hostile dialog depth inputs', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    runtime.setDialogDepth(10_000);
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(8);
    runtime.setDialogDepth(-900);
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(0);
    runtime.setDialogDepth(Number.NaN);
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(0);
  });

  it('keeps repeated dialog depth synchronization idempotent', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.setDialogDepth(1);
    const sequence = runtime.getSnapshot().accessibility.sequence;
    runtime.setDialogDepth(1);
    expect(runtime.getSnapshot().accessibility.sequence).toBe(sequence);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tracks command palette lifecycle and restores the origin zone', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window, now: () => 5_000 });
    document.body.innerHTML = '<main id="experience-workspace-controls"><button id="origin">Origin</button></main>';
    const origin = document.getElementById('origin')!;
    origin.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(runtime.getSnapshot().accessibility.focusZone).toBe('unknown');
    runtime.start();
    origin.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(runtime.getSnapshot().accessibility.focusZone).toBe('workspace');
    runtime.setCommandPaletteOpen(true);
    expect(runtime.getSnapshot().accessibility.commandPaletteOpen).toBe(true);
    expect(runtime.getSnapshot().accessibility.focusZone).toBe('command-palette');
    expect(runtime.getSnapshot().liveRegions.polite.some((item) => item.text === 'Komut paleti açıldı.')).toBe(true);
    runtime.setCommandPaletteOpen(false);
    expect(runtime.getSnapshot().accessibility.commandPaletteOpen).toBe(false);
    expect(runtime.getSnapshot().accessibility.focusZone).toBe('workspace');
    expect(runtime.getSnapshot().liveRegions.polite.some((item) => item.text === 'Komut paleti kapatıldı.')).toBe(true);
    runtime.dispose();
  });

  it('keeps repeated palette state synchronization idempotent', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.setCommandPaletteOpen(true);
    runtime.setCommandPaletteOpen(true);
    runtime.setCommandPaletteOpen(false);
    runtime.setCommandPaletteOpen(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps dialog authority ahead of base-zone focus transitions while nested', () => {
    installMatchMedia();
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    document.body.innerHTML = '<div id="esri-map-container"><button id="map">Map</button></div>';
    runtime.start();
    runtime.setDialogDepth(2);
    document.getElementById('map')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(2);
    expect(runtime.getSnapshot().accessibility.focusZone).toBe('map');
    runtime.setDialogDepth(1);
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(1);
    runtime.setDialogDepth(0);
    expect(runtime.getSnapshot().accessibility.dialogDepth).toBe(0);
    runtime.dispose();
  });

  it('does not let surface lifecycle methods retain caller payloads', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    runtime.setDialogDepth(2);
    runtime.setCommandPaletteOpen(true);
    const serialized = JSON.stringify(runtime.getSnapshot());
    expect(serialized).not.toContain('HTMLElement');
    expect(serialized.length).toBeLessThan(2_000);
  });
});
