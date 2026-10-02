import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShellModel } from './mapWorkspaceShellModel';
import {
  MapWorkspaceShellBrowserRuntime,
  focusMapWorkspaceLandmark,
  resolveMapWorkspaceLandmark,
} from './mapWorkspaceShellBrowserRuntime';

type Listener = (event: MediaQueryListEvent) => void;

const mediaState = new Map<string, boolean>();
const mediaListeners = new Map<string, Set<Listener>>();

const installMatchMedia = (): void => {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
    media: query,
    matches: mediaState.get(query) === true,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener !== 'function') return;
      const set = mediaListeners.get(query) ?? new Set<Listener>();
      set.add(listener as Listener);
      mediaListeners.set(query, set);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener !== 'function') return;
      mediaListeners.get(query)?.delete(listener as Listener);
    },
    dispatchEvent: vi.fn(() => true),
  }));
};

const emitMedia = (query: string, matches: boolean): void => {
  mediaState.set(query, matches);
  for (const listener of mediaListeners.get(query) ?? []) {
    listener(new Event('change') as MediaQueryListEvent);
  }
};

const addLandmark = (id: string, options: { hidden?: boolean; tabIndex?: number } = {}): HTMLElement => {
  const element = document.createElement('div');
  element.id = id;
  if (options.hidden) element.hidden = true;
  if (options.tabIndex !== undefined) element.tabIndex = options.tabIndex;
  document.body.appendChild(element);
  return element;
};

const flushAnimationFrame = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

describe('mapWorkspaceShellBrowserRuntime', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mediaState.clear();
    mediaListeners.clear();
    installMatchMedia();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280, writable: true });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720, writable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('resolves known landmark ids from the current document', () => {
    const map = addLandmark('esri-map-container');
    expect(resolveMapWorkspaceLandmark('map')).toBe(map);
    expect(resolveMapWorkspaceLandmark('sidebar')).toBeNull();
  });

  it('focuses a natively focusable target', () => {
    const search = document.createElement('input');
    search.id = 'kentrehberi-global-search';
    document.body.appendChild(search);
    const result = focusMapWorkspaceLandmark('search');
    expect(result).toEqual({ ok: true, id: 'search', reason: 'focused' });
    expect(document.activeElement).toBe(search);
  });

  it('temporarily makes a non-focusable landmark focusable', () => {
    const sidebar = addLandmark('sidebar');
    expect(sidebar.hasAttribute('tabindex')).toBe(false);
    const result = focusMapWorkspaceLandmark('sidebar');
    expect(result.ok).toBe(true);
    expect(sidebar.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(sidebar);
    sidebar.dispatchEvent(new FocusEvent('blur'));
    expect(sidebar.hasAttribute('tabindex')).toBe(false);
  });

  it('preserves an existing tabindex contract', () => {
    const toolbar = addLandmark('toolbar-widget', { tabIndex: 0 });
    const result = focusMapWorkspaceLandmark('toolbar');
    expect(result.ok).toBe(true);
    expect(toolbar.getAttribute('tabindex')).toBe('0');
    toolbar.dispatchEvent(new FocusEvent('blur'));
    expect(toolbar.getAttribute('tabindex')).toBe('0');
  });

  it('rejects a missing landmark without throwing', () => {
    expect(focusMapWorkspaceLandmark('help')).toEqual({ ok: false, id: 'help', reason: 'missing' });
  });

  it('rejects hidden landmarks', () => {
    addLandmark('sidebar', { hidden: true });
    expect(focusMapWorkspaceLandmark('sidebar')).toEqual({ ok: false, id: 'sidebar', reason: 'hidden' });
  });

  it('publishes initial viewport and landmark availability on start', () => {
    addLandmark('esri-map-container');
    addLandmark('sidebar');
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    expect(model.getSnapshot()).toMatchObject({ width: 1280, height: 720, viewport: 'wide', availableLandmarkCount: 2 });
    expect(model.getSnapshot().landmarks.find((item) => item.id === 'map')?.available).toBe(true);
    expect(model.getSnapshot().landmarks.find((item) => item.id === 'sidebar')?.available).toBe(true);
    runtime.dispose();
  });

  it('detects landmarks mounted after runtime start', async () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    expect(model.getSnapshot().availableLandmarkCount).toBe(0);
    addLandmark('toolbar-widget');
    await flushAnimationFrame();
    expect(model.getSnapshot().landmarks.find((item) => item.id === 'toolbar')?.available).toBe(true);
    expect(runtime.getDiagnostics().mutationRefreshCount).toBeGreaterThan(0);
    runtime.dispose();
  });

  it('detects landmarks removed after runtime start', async () => {
    const sidebar = addLandmark('sidebar');
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    expect(model.getSnapshot().availableLandmarkCount).toBe(1);
    sidebar.remove();
    await flushAnimationFrame();
    expect(model.getSnapshot().availableLandmarkCount).toBe(0);
    runtime.dispose();
  });

  it('coalesces resize work into animation-frame refresh', async () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    const before = runtime.getDiagnostics().refreshCount;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640, writable: true });
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    expect(runtime.getDiagnostics().resizeRefreshCount).toBe(3);
    expect(runtime.getDiagnostics().refreshCount).toBe(before);
    await flushAnimationFrame();
    expect(runtime.getDiagnostics().refreshCount).toBe(before + 1);
    expect(model.getSnapshot().viewport).toBe('compact');
    runtime.dispose();
  });

  it('refreshes pointer and accessibility preferences from media queries', async () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    emitMedia('(pointer: coarse)', true);
    emitMedia('(prefers-reduced-motion: reduce)', true);
    emitMedia('(forced-colors: active)', true);
    await flushAnimationFrame();
    expect(model.getSnapshot()).toMatchObject({ coarsePointer: true, reducedMotion: true, forcedColors: true });
    expect(runtime.getDiagnostics().mediaRefreshCount).toBe(3);
    runtime.dispose();
  });

  it('tracks keyboard modality from unmodified key events', () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(model.getSnapshot().inputModality).toBe('keyboard');
    runtime.dispose();
  });

  it('does not treat command chords as keyboard modality changes', () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    model.setInputModality('touch');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(model.getSnapshot().inputModality).toBe('touch');
    runtime.dispose();
  });

  it('tracks pointer modality', () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
    expect(model.getSnapshot().inputModality).toBe('pointer');
    runtime.dispose();
  });

  it('tracks touch modality', () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    expect(model.getSnapshot().inputModality).toBe('touch');
    runtime.dispose();
  });

  it('maps focusin events to the containing landmark', () => {
    const toolbar = addLandmark('toolbar-widget');
    const button = document.createElement('button');
    toolbar.appendChild(button);
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    button.focus();
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(model.getSnapshot().activeLandmarkId).toBe('toolbar');
    runtime.dispose();
  });

  it('focus method updates active landmark on success', () => {
    addLandmark('sidebar');
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    const result = runtime.focus('sidebar');
    expect(result.ok).toBe(true);
    expect(model.getSnapshot().activeLandmarkId).toBe('sidebar');
    runtime.dispose();
  });

  it('returns missing when runtime focus target is not mounted', () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    expect(runtime.focus('sidebar')).toEqual({ ok: false, id: 'sidebar', reason: 'missing' });
    runtime.dispose();
  });

  it('stops reacting to resize after dispose', async () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    runtime.dispose();
    const before = model.getSnapshot().revision;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400, writable: true });
    window.dispatchEvent(new Event('resize'));
    await flushAnimationFrame();
    expect(model.getSnapshot().revision).toBe(before);
    expect(runtime.getDiagnostics().started).toBe(false);
  });

  it('stops mutation observation after dispose', async () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    runtime.dispose();
    addLandmark('sidebar');
    await flushAnimationFrame();
    expect(model.getSnapshot().availableLandmarkCount).toBe(0);
  });

  it('start is idempotent', () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    const refreshCount = runtime.getDiagnostics().refreshCount;
    runtime.start();
    expect(runtime.getDiagnostics().refreshCount).toBe(refreshCount);
    runtime.dispose();
  });

  it('dispose is idempotent', () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);
    runtime.start();
    runtime.dispose();
    runtime.dispose();
    expect(runtime.getDiagnostics().started).toBe(false);
  });
});
