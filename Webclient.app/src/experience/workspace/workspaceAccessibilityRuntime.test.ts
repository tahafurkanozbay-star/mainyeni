import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceAccessibilityRuntime, workspaceFocusZoneForElement } from './workspaceAccessibilityRuntime';

const makeMediaQuery = (matches = false) => {
  const listeners = new Set<() => void>();
  return {
    matches,
    media: '',
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    emit() { for (const listener of listeners) listener(); },
  } as unknown as MediaQueryList & { emit(): void };
};

describe('WorkspaceAccessibilityRuntime', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('tracks keyboard, pointer and touch modality without retaining event payloads', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    runtime.start();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(runtime.getSnapshot().accessibility.modality).toBe('keyboard');
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
    expect(runtime.getSnapshot().accessibility.modality).toBe('pointer');
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    expect(runtime.getSnapshot().accessibility.modality).toBe('touch');
    runtime.dispose();
  });

  it('maps focus targets to deterministic workspace zones', () => {
    document.body.innerHTML = `
      <main id="experience-workspace-controls"><button id="workspace-button">Workspace</button></main>
      <div id="esri-map-container"><button id="map-button">Map</button></div>
      <aside id="sidebar"><button id="tool-button">Tool</button></aside>
      <div data-experience-command-palette><input id="command-input" /></div>
      <div role="dialog"><button id="dialog-button">Dialog</button></div>
    `;
    expect(workspaceFocusZoneForElement(document.querySelector('#workspace-button'))).toBe('workspace');
    expect(workspaceFocusZoneForElement(document.querySelector('#map-button'))).toBe('map');
    expect(workspaceFocusZoneForElement(document.querySelector('#tool-button'))).toBe('tools');
    expect(workspaceFocusZoneForElement(document.querySelector('#command-input'))).toBe('command-palette');
    expect(workspaceFocusZoneForElement(document.querySelector('#dialog-button'))).toBe('dialog');
    expect(workspaceFocusZoneForElement(document.body)).toBe('unknown');
  });

  it('tracks focusin events and publishes immutable snapshots', () => {
    document.body.innerHTML = '<div id="esri-map-container"><button id="target">Map target</button></div>';
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.start();
    const target = document.querySelector<HTMLButtonElement>('#target')!;
    target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(runtime.getSnapshot().accessibility.focusZone).toBe('map');
    expect(Object.isFrozen(runtime.getSnapshot())).toBe(true);
    expect(listener).toHaveBeenCalled();
    runtime.dispose();
  });

  it('uses assertive connectivity announcements for offline transitions', () => {
    let now = 100;
    const runtime = new WorkspaceAccessibilityRuntime({ document, window, now: () => now });
    runtime.start();
    window.dispatchEvent(new Event('offline'));
    expect(runtime.getSnapshot().accessibility.online).toBe(false);
    expect(runtime.getSnapshot().assertiveAnnouncement).toContain('Bağlantı kesildi');
    now += 2_000;
    window.dispatchEvent(new Event('online'));
    expect(runtime.getSnapshot().accessibility.online).toBe(true);
    expect(runtime.getSnapshot().politeAnnouncement).toContain('Bağlantı yeniden kuruldu');
    runtime.dispose();
  });

  it('deduplicates repeated public announcements through the bounded live-region authority', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window, now: () => 1_000 });
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.announce('Katman seçildi.', 'polite', 'selection');
    runtime.announce('Katman seçildi.', 'polite', 'selection');
    expect(runtime.getSnapshot().liveRegions.polite).toHaveLength(1);
    expect(runtime.getSnapshot().politeAnnouncement).toBe('Katman seçildi.');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tracks map busy phase from the existing workspace phase contract', async () => {
    document.body.innerHTML = '<div id="esri-map-container" data-workspace-phase="booting"></div>';
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    runtime.start();
    expect(runtime.getSnapshot().accessibility.mapBusy).toBe(true);
    expect(runtime.getSnapshot().politeAnnouncement).toBe('Harita güncelleniyor.');
    const map = document.querySelector<HTMLElement>('#esri-map-container')!;
    map.dataset.workspacePhase = 'ready';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.getSnapshot().accessibility.mapBusy).toBe(false);
    expect(runtime.getSnapshot().politeAnnouncement).toBe('Harita güncelleniyor.');
    expect(runtime.getSnapshot().liveRegions.polite.some((item) => item.text === 'Harita güncellemesi tamamlandı.')).toBe(true);
    runtime.dispose();
  });

  it('isolates listener failures and continues notifying healthy subscribers', () => {
    const errors: unknown[] = [];
    const runtime = new WorkspaceAccessibilityRuntime({ document, window, onError: (error) => errors.push(error) });
    const healthy = vi.fn();
    runtime.subscribe(() => { throw new Error('observer failed'); });
    runtime.subscribe(healthy);
    runtime.announce('Durum değişti.');
    expect(errors).toHaveLength(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('does not publish when a state transition is a no-op', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.setMapBusy(false);
    runtime.setMapBusy(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishes only once for a real map busy transition', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window, now: () => 5_000 });
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.setMapBusy(true);
    runtime.setMapBusy(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().accessibility.mapBusy).toBe(true);
  });

  it('starts and disposes idempotently', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    runtime.start();
    runtime.start();
    runtime.dispose();
    runtime.dispose();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(runtime.getSnapshot().accessibility.modality).toBe('unknown');
  });

  it('survives matchMedia failures without blocking keyboard tracking', () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => { throw new Error('blocked'); } });
    const errors: unknown[] = [];
    const runtime = new WorkspaceAccessibilityRuntime({ document, window, onError: (error) => errors.push(error) });
    runtime.start();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(runtime.getSnapshot().accessibility.modality).toBe('keyboard');
    expect(errors.length).toBeGreaterThan(0);
    runtime.dispose();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
  });

  it('reflects reduced motion and forced colors media preferences', () => {
    const reduced = makeMediaQuery(true);
    const forced = makeMediaQuery(true);
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => query.includes('reduced-motion') ? reduced : forced,
    });
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    runtime.start();
    expect(runtime.getSnapshot().accessibility.reducedMotion).toBe(true);
    expect(runtime.getSnapshot().accessibility.forcedColors).toBe(true);
    runtime.dispose();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
  });

  it('bounds custom announcement text through the live-region model', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window, now: () => 10 });
    runtime.announce(`  ${'a'.repeat(500)}  `);
    expect(runtime.getSnapshot().politeAnnouncement).toHaveLength(240);
  });

  it('keeps assertive and polite channels independent', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window, now: () => 10 });
    runtime.announce('Bilgi', 'polite');
    runtime.announce('Kritik bilgi', 'assertive');
    expect(runtime.getSnapshot().politeAnnouncement).toBe('Bilgi');
    expect(runtime.getSnapshot().assertiveAnnouncement).toBe('Kritik bilgi');
  });

  it('removes DOM listeners after dispose', () => {
    const runtime = new WorkspaceAccessibilityRuntime({ document, window });
    runtime.start();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(runtime.getSnapshot().accessibility.modality).toBe('keyboard');
    runtime.dispose();
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
    expect(runtime.getSnapshot().accessibility.modality).toBe('keyboard');
  });
});
