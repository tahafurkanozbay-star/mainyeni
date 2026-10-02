import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_LANDMARK_DEFINITIONS } from './workspaceLandmarkInventoryModel';
import { WorkspaceLandmarkRuntime, observeWorkspaceLandmark } from './workspaceLandmarkRuntime';

const mountCoreLandmarks = (): void => {
  document.body.innerHTML = `
    <nav id="mainbar" aria-label="Üst gezinme"><button type="button">Menü</button></nav>
    <label for="kentrehberi-global-search">Adres veya yer ara</label>
    <input id="kentrehberi-global-search" />
    <aside id="sidebar" aria-label="Katman ve hizmet menüsü" tabindex="0"></aside>
    <div id="toolbar-widget" aria-label="Harita araçları" tabindex="0"></div>
    <main id="experience-workspace-controls" aria-label="Çalışma alanı" tabindex="0"></main>
    <div id="esri-map-container" aria-label="Kent haritası" tabindex="0"></div>
  `;
};

const installAnimationFrame = (): { readonly flush: () => void } => {
  let callbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  return {
    flush() {
      const queued = callbacks;
      callbacks = [];
      queued.forEach((callback) => callback(performance.now()));
    },
  };
};

describe('WorkspaceLandmarkRuntime', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('builds a critical snapshot before required landmarks exist', () => {
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    runtime.start();
    expect(runtime.getSnapshot().health).toBe('critical');
    expect(runtime.getSnapshot().missingRequiredCount).toBe(6);
    runtime.dispose();
  });

  it('discovers the real core shell landmarks without retaining nodes', () => {
    mountCoreLandmarks();
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    runtime.start();
    const snapshot = runtime.getSnapshot();
    expect(snapshot.health).toBe('ready');
    expect(snapshot.readyCount).toBe(6);
    expect(snapshot.availableFocusZones).toEqual(['map', 'workspace', 'tools']);
    expect(snapshot.entries.every((entry) => Object.values(entry).every((value) => !(value instanceof Node)))).toBe(true);
    runtime.dispose();
  });

  it('recognizes explicit aria-labels as accessible names', () => {
    const element = document.createElement('div');
    element.id = 'toolbar-widget';
    element.tabIndex = 0;
    element.setAttribute('aria-label', 'Araç çubuğu');
    document.body.appendChild(element);
    const definition = WORKSPACE_LANDMARK_DEFINITIONS.find((item) => item.id === 'toolbar');
    expect(definition).toBeDefined();
    const result = observeWorkspaceLandmark(definition!, document, window);
    expect(result).toMatchObject({ present: true, visible: true, focusable: true, labelled: true, disabled: false });
  });

  it('recognizes aria-labelledby text with bounded token resolution', () => {
    document.body.innerHTML = '<span id="label-one">Harita araçları</span><div id="toolbar-widget" tabindex="0" aria-labelledby="missing label-one"></div>';
    const definition = WORKSPACE_LANDMARK_DEFINITIONS.find((item) => item.id === 'toolbar')!;
    expect(observeWorkspaceLandmark(definition, document, window).labelled).toBe(true);
  });

  it('recognizes native form labels', () => {
    document.body.innerHTML = '<label for="kentrehberi-global-search">Yer ara</label><input id="kentrehberi-global-search">';
    const definition = WORKSPACE_LANDMARK_DEFINITIONS.find((item) => item.id === 'search')!;
    const result = observeWorkspaceLandmark(definition, document, window);
    expect(result.labelled).toBe(true);
    expect(result.focusable).toBe(true);
  });

  it('uses a visible candidate when the first selector match is hidden', () => {
    document.body.innerHTML = `
      <aside id="sidebar" hidden aria-label="Eski araçlar"></aside>
      <section data-workspace-tools aria-label="Yeni araçlar" tabindex="0"></section>
    `;
    const definition = WORKSPACE_LANDMARK_DEFINITIONS.find((item) => item.id === 'sidebar')!;
    const result = observeWorkspaceLandmark(definition, document, window);
    expect(result).toMatchObject({ present: true, visible: true, labelled: true, focusable: true });
  });

  it('treats hidden ancestors as unavailable', () => {
    document.body.innerHTML = '<section hidden><div id="toolbar-widget" tabindex="0" aria-label="Araçlar"></div></section>';
    const definition = WORKSPACE_LANDMARK_DEFINITIONS.find((item) => item.id === 'toolbar')!;
    expect(observeWorkspaceLandmark(definition, document, window).visible).toBe(false);
  });

  it('treats aria-hidden ancestors as unavailable', () => {
    document.body.innerHTML = '<section aria-hidden="true"><div id="toolbar-widget" tabindex="0" aria-label="Araçlar"></div></section>';
    const definition = WORKSPACE_LANDMARK_DEFINITIONS.find((item) => item.id === 'toolbar')!;
    expect(observeWorkspaceLandmark(definition, document, window).visible).toBe(false);
  });

  it('treats inert descendants as unavailable and disabled', () => {
    document.body.innerHTML = '<section inert><button id="toolbar-widget" aria-label="Araçlar">Araç</button></section>';
    const definition = WORKSPACE_LANDMARK_DEFINITIONS.find((item) => item.id === 'toolbar')!;
    const result = observeWorkspaceLandmark(definition, document, window);
    expect(result.visible).toBe(false);
  });

  it('treats disabled native controls as disabled and unfocusable', () => {
    document.body.innerHTML = '<button id="toolbar-widget" disabled aria-label="Araçlar">Araç</button>';
    const definition = WORKSPACE_LANDMARK_DEFINITIONS.find((item) => item.id === 'toolbar')!;
    const result = observeWorkspaceLandmark(definition, document, window);
    expect(result.disabled).toBe(true);
    expect(result.focusable).toBe(false);
  });

  it('treats aria-disabled custom controls as disabled', () => {
    document.body.innerHTML = '<div id="toolbar-widget" tabindex="0" aria-disabled="true" aria-label="Araçlar"></div>';
    const definition = WORKSPACE_LANDMARK_DEFINITIONS.find((item) => item.id === 'toolbar')!;
    const result = observeWorkspaceLandmark(definition, document, window);
    expect(result.disabled).toBe(true);
    expect(result.focusable).toBe(false);
  });

  it('coalesces mutation bursts into one animation-frame refresh', async () => {
    mountCoreLandmarks();
    const raf = installAnimationFrame();
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    runtime.start();
    const listener = vi.fn();
    runtime.subscribe(listener);
    const toolbar = document.getElementById('toolbar-widget')!;
    toolbar.setAttribute('aria-label', 'Araçlar A');
    toolbar.setAttribute('aria-label', 'Araçlar B');
    toolbar.classList.add('updated');
    await Promise.resolve();
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    raf.flush();
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('publishes when a required landmark becomes hidden', async () => {
    mountCoreLandmarks();
    const raf = installAnimationFrame();
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    runtime.start();
    const listener = vi.fn();
    runtime.subscribe(listener);
    document.getElementById('sidebar')!.setAttribute('hidden', '');
    await Promise.resolve();
    raf.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().health).toBe('critical');
    runtime.dispose();
  });

  it('publishes when an optional dialog appears and disappears', async () => {
    mountCoreLandmarks();
    const raf = installAnimationFrame();
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    runtime.start();
    const listener = vi.fn();
    runtime.subscribe(listener);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Ayarlar');
    dialog.tabIndex = -1;
    document.body.appendChild(dialog);
    await Promise.resolve();
    raf.flush();
    expect(runtime.getSnapshot().entries.find((item) => item.id === 'dialog')?.present).toBe(true);
    dialog.remove();
    await Promise.resolve();
    raf.flush();
    expect(runtime.getSnapshot().entries.find((item) => item.id === 'dialog')?.present).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('schedules a refresh for responsive resize without retaining event payloads', () => {
    mountCoreLandmarks();
    const raf = installAnimationFrame();
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    runtime.start();
    window.dispatchEvent(new Event('resize'));
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    raf.flush();
    expect(runtime.getSnapshot().revision).toBeGreaterThan(0);
    runtime.dispose();
  });

  it('uses a bounded fallback timer when requestAnimationFrame is unavailable', async () => {
    vi.useFakeTimers();
    mountCoreLandmarks();
    const original = window.requestAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: undefined });
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    runtime.start();
    document.getElementById('sidebar')!.setAttribute('hidden', '');
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    expect(runtime.getSnapshot().health).toBe('critical');
    runtime.dispose();
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: original });
  });

  it('keeps healthy listeners running when another listener throws', () => {
    mountCoreLandmarks();
    const reporter = vi.fn();
    const runtime = new WorkspaceLandmarkRuntime({ document, window, onError: reporter });
    runtime.start();
    const healthy = vi.fn();
    runtime.subscribe(() => { throw new Error('observer failed'); });
    runtime.subscribe(healthy);
    document.getElementById('sidebar')!.setAttribute('hidden', '');
    runtime.refresh();
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('contains reporter failures without blocking later listeners', () => {
    mountCoreLandmarks();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = new WorkspaceLandmarkRuntime({ document, window, onError: () => { throw new Error('reporter failed'); } });
    runtime.start();
    const healthy = vi.fn();
    runtime.subscribe(() => { throw new Error('observer failed'); });
    runtime.subscribe(healthy);
    document.getElementById('toolbar-widget')!.setAttribute('hidden', '');
    runtime.refresh();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('enforces a bounded listener budget', () => {
    const runtime = new WorkspaceLandmarkRuntime({ document, window, maxListeners: 2 });
    runtime.subscribe(() => undefined);
    runtime.subscribe(() => undefined);
    expect(() => runtime.subscribe(() => undefined)).toThrow(/listener limit exceeded/i);
    runtime.dispose();
  });

  it('returns idempotent unsubscriptions', () => {
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    const release = runtime.subscribe(() => undefined);
    expect(runtime.listenerCount()).toBe(1);
    release();
    release();
    expect(runtime.listenerCount()).toBe(0);
    runtime.dispose();
  });

  it('is idempotent across repeated start calls', () => {
    mountCoreLandmarks();
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    runtime.start();
    const firstRevision = runtime.getSnapshot().revision;
    runtime.start();
    expect(runtime.getSnapshot().revision).toBe(firstRevision);
    expect(runtime.isStarted()).toBe(true);
    runtime.dispose();
  });

  it('cancels scheduled work and listeners on dispose', async () => {
    mountCoreLandmarks();
    const raf = installAnimationFrame();
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    runtime.start();
    const listener = vi.fn();
    runtime.subscribe(listener);
    document.getElementById('sidebar')!.setAttribute('hidden', '');
    await Promise.resolve();
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    runtime.dispose();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    raf.flush();
    expect(listener).not.toHaveBeenCalled();
    expect(runtime.isDisposed()).toBe(true);
    expect(runtime.listenerCount()).toBe(0);
  });

  it('does not restart after disposal', () => {
    const runtime = new WorkspaceLandmarkRuntime({ document, window });
    runtime.dispose();
    runtime.start();
    expect(runtime.isStarted()).toBe(false);
    expect(runtime.isDisposed()).toBe(true);
  });
});
