import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapWorkspaceShellController } from './mapWorkspaceShellController';
import { createMapWorkspaceShellModel } from './mapWorkspaceShellModel';

const visibleRect = (): DOMRect => ({
  x: 0,
  y: 0,
  width: 240,
  height: 80,
  top: 0,
  right: 240,
  bottom: 80,
  left: 0,
  toJSON: () => ({}),
} as DOMRect);

const makeVisible = (element: HTMLElement): void => {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(visibleRect());
};

const mountRegions = (): {
  navigation: HTMLElement;
  map: HTMLElement;
  sidebar: HTMLElement;
  toolbar: HTMLElement;
  workspace: HTMLElement;
  help: HTMLButtonElement;
} => {
  document.body.innerHTML = `
    <div class="mainbar-container"><button id="nav-button">Ana menü</button></div>
    <div id="esri-map-container"></div>
    <aside id="sidebar"><button>Katmanlar</button></aside>
    <div id="toolbar-widget"><button>Araç</button></div>
    <aside id="experience-workspace-controls" tabindex="-1"></aside>
    <button class="map-shortcut-help__launcher">Kısayollar</button>
  `;

  const navigation = document.querySelector<HTMLElement>('.mainbar-container')!;
  const map = document.getElementById('esri-map-container')!;
  const sidebar = document.getElementById('sidebar')!;
  const toolbar = document.getElementById('toolbar-widget')!;
  const workspace = document.getElementById('experience-workspace-controls')!;
  const help = document.querySelector<HTMLButtonElement>('.map-shortcut-help__launcher')!;
  [navigation, map, sidebar, toolbar, workspace, help].forEach(makeVisible);
  return { navigation, map, sidebar, toolbar, workspace, help };
};

describe('MapWorkspaceShellController', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('discovers all visible canonical regions on install', () => {
    mountRegions();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });

    const release = controller.install();

    expect(model.getSnapshot().availableRegionIds).toEqual([
      'navigation',
      'map',
      'sidebar',
      'toolbar',
      'workspace',
      'help',
    ]);
    expect(controller.snapshot()).toMatchObject({ installed: true, refreshCount: 1 });
    release();
  });

  it('excludes display-none regions', () => {
    const { sidebar } = mountRegions();
    sidebar.style.display = 'none';
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    expect(model.getSnapshot().availableRegionIds).not.toContain('sidebar');
    controller.dispose();
  });

  it('excludes visibility-hidden regions', () => {
    const { toolbar } = mountRegions();
    toolbar.style.visibility = 'hidden';
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    expect(model.getSnapshot().availableRegionIds).not.toContain('toolbar');
    controller.dispose();
  });

  it('excludes aria-hidden regions', () => {
    const { sidebar } = mountRegions();
    sidebar.setAttribute('aria-hidden', 'true');
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    expect(model.getSnapshot().availableRegionIds).not.toContain('sidebar');
    controller.dispose();
  });

  it('excludes hidden regions', () => {
    const { workspace } = mountRegions();
    workspace.hidden = true;
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    expect(model.getSnapshot().availableRegionIds).not.toContain('workspace');
    controller.dispose();
  });

  it('cycles forward with F6 and prevents the browser default', () => {
    mountRegions();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(model.getSnapshot()).toMatchObject({
      activeRegion: 'navigation',
      modality: 'keyboard',
      cycleCount: 1,
    });
    expect(document.activeElement?.id).toBe('nav-button');
    controller.dispose();
  });

  it('cycles forward from the current focused region', () => {
    const { navigation } = mountRegions();
    const navButton = navigation.querySelector<HTMLButtonElement>('button')!;
    navButton.focus();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true }));

    expect(model.getSnapshot().activeRegion).toBe('map');
    expect(document.activeElement?.id).toBe('esri-map-container');
    controller.dispose();
  });

  it('cycles backward with Shift+F6', () => {
    const { map } = mountRegions();
    map.setAttribute('tabindex', '-1');
    map.focus();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    const event = new KeyboardEvent('keydown', { key: 'F6', shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(model.getSnapshot().activeRegion).toBe('navigation');
    controller.dispose();
  });

  it('wraps forward after the final region', () => {
    const { help } = mountRegions();
    help.focus();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true }));

    expect(model.getSnapshot().activeRegion).toBe('navigation');
    controller.dispose();
  });

  it('wraps backward before the first region', () => {
    const { navigation } = mountRegions();
    navigation.querySelector<HTMLButtonElement>('button')!.focus();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', shiftKey: true, bubbles: true, cancelable: true }));

    expect(model.getSnapshot().activeRegion).toBe('help');
    controller.dispose();
  });

  it('does not escape an open modal dialog with F6', () => {
    mountRegions();
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    modal.append(input);
    document.body.append(modal);
    makeVisible(modal);
    makeVisible(input);
    input.focus();

    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();
    const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(model.getSnapshot().cycleCount).toBe(0);
    controller.dispose();
  });

  it('ignores Ctrl+F6 and Alt+F6 browser chords', () => {
    mountRegions();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', ctrlKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', altKey: true, bubbles: true }));

    expect(model.getSnapshot().cycleCount).toBe(0);
    controller.dispose();
  });

  it('ignores Meta+F6 chords', () => {
    mountRegions();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', metaKey: true, bubbles: true }));

    expect(model.getSnapshot().cycleCount).toBe(0);
    controller.dispose();
  });

  it('honors an already prevented F6 event', () => {
    mountRegions();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();
    const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    event.preventDefault();

    window.dispatchEvent(event);

    expect(model.getSnapshot().cycleCount).toBe(0);
    controller.dispose();
  });

  it('updates active region when focus enters a region', () => {
    const { toolbar } = mountRegions();
    const button = toolbar.querySelector<HTMLButtonElement>('button')!;
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    button.focus();

    expect(model.getSnapshot().activeRegion).toBe('toolbar');
    expect(controller.snapshot().lastFocusedRegion).toBe('toolbar');
    controller.dispose();
  });

  it('tracks pointer modality and active region', () => {
    const { sidebar } = mountRegions();
    const button = sidebar.querySelector<HTMLButtonElement>('button')!;
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));

    expect(model.getSnapshot()).toMatchObject({
      modality: 'pointer',
      activeRegion: 'sidebar',
    });
    controller.dispose();
  });

  it('tracks touch modality', () => {
    const { toolbar } = mountRegions();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    toolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));

    expect(model.getSnapshot().modality).toBe('touch');
    controller.dispose();
  });

  it('uses the first focusable descendant for non-focusable region roots', () => {
    const { sidebar } = mountRegions();
    const button = sidebar.querySelector<HTMLButtonElement>('button')!;
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    expect(controller.focusRegion('sidebar')).toBe(true);
    expect(document.activeElement).toBe(button);
    controller.dispose();
  });

  it('prefers explicit data-experience-region-focus targets', () => {
    const { sidebar } = mountRegions();
    const normal = sidebar.querySelector<HTMLButtonElement>('button')!;
    const preferred = document.createElement('button');
    preferred.dataset.experienceRegionFocus = 'true';
    preferred.textContent = 'Preferred';
    sidebar.prepend(preferred);
    makeVisible(preferred);
    makeVisible(normal);
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    controller.focusRegion('sidebar');

    expect(document.activeElement).toBe(preferred);
    controller.dispose();
  });

  it('adds temporary tabindex to an otherwise unfocusable map root', () => {
    const { map } = mountRegions();
    expect(map.hasAttribute('tabindex')).toBe(false);
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    controller.focusRegion('map');

    expect(map.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(map);
    controller.dispose();
  });

  it('restores temporary tabindex after blur', () => {
    const { map, help } = mountRegions();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    controller.focusRegion('map');
    expect(map.getAttribute('tabindex')).toBe('-1');
    help.focus();

    expect(map.hasAttribute('tabindex')).toBe(false);
    controller.dispose();
  });

  it('preserves an existing tabindex when a temporary focus target blurs', () => {
    const { map, help } = mountRegions();
    map.setAttribute('tabindex', '-1');
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    controller.focusRegion('map');
    help.focus();

    expect(map.getAttribute('tabindex')).toBe('-1');
    controller.dispose();
  });

  it('returns false for unavailable regions and records rejection', () => {
    mountRegions();
    const sidebar = document.getElementById('sidebar')!;
    sidebar.style.display = 'none';
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();

    expect(controller.focusRegion('sidebar')).toBe(false);
    expect(controller.snapshot().rejectedFocusCount).toBe(1);
    controller.dispose();
  });

  it('refreshes availability when a previously hidden region becomes visible', () => {
    const { sidebar } = mountRegions();
    sidebar.style.display = 'none';
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();
    expect(model.getSnapshot().availableRegionIds).not.toContain('sidebar');

    sidebar.style.display = '';
    controller.refreshAvailability();

    expect(model.getSnapshot().availableRegionIds).toContain('sidebar');
    controller.dispose();
  });

  it('coalesces resize refreshes behind requestAnimationFrame', () => {
    mountRegions();
    let callback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => {
      callback = next;
      return 42;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();
    const before = controller.snapshot().refreshCount;

    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    callback?.(16);
    expect(controller.snapshot().refreshCount).toBe(before + 1);
    controller.dispose();
  });

  it('refreshes after map mode changes', () => {
    mountRegions();
    let callback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => {
      callback = next;
      return 7;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();
    const before = controller.snapshot().refreshCount;

    window.dispatchEvent(new CustomEvent('kentrehberi:map-mode-changed'));
    callback?.(20);

    expect(controller.snapshot().refreshCount).toBe(before + 1);
    controller.dispose();
  });

  it('removes event listeners on dispose', () => {
    mountRegions();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    controller.install();
    controller.dispose();
    const revision = model.getSnapshot().revision;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true }));
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));

    expect(model.getSnapshot().revision).toBe(revision);
    expect(controller.snapshot().installed).toBe(false);
  });

  it('makes install idempotent', () => {
    mountRegions();
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model });
    const releaseA = controller.install();
    const releaseB = controller.install();

    expect(controller.snapshot().refreshCount).toBe(1);
    releaseB();
    expect(controller.snapshot().installed).toBe(false);
    releaseA();
  });

  it('supports a scoped root for embedded map shells', () => {
    const host = document.createElement('section');
    host.innerHTML = '<div id="esri-map-container"></div><div id="toolbar-widget"><button>Tool</button></div>';
    document.body.append(host);
    const map = host.querySelector<HTMLElement>('#esri-map-container')!;
    const toolbar = host.querySelector<HTMLElement>('#toolbar-widget')!;
    makeVisible(map);
    makeVisible(toolbar);
    const outsideSidebar = document.createElement('aside');
    outsideSidebar.id = 'sidebar';
    document.body.append(outsideSidebar);
    makeVisible(outsideSidebar);
    const model = createMapWorkspaceShellModel();
    const controller = createMapWorkspaceShellController({ model, root: host });

    controller.install();

    expect(model.getSnapshot().availableRegionIds).toEqual(['map', 'toolbar']);
    controller.dispose();
  });
});
