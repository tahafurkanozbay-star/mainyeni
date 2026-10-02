import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShellPlacementRuntime } from './mapWorkspaceShellPlacementRuntime';

const setRect = (element: HTMLElement, values: Partial<DOMRect>): void => {
  const rect = {
    x: values.left ?? 0,
    y: values.top ?? 0,
    left: values.left ?? 0,
    top: values.top ?? 0,
    width: values.width ?? 0,
    height: values.height ?? 0,
    right: values.right ?? (values.left ?? 0) + (values.width ?? 0),
    bottom: values.bottom ?? (values.top ?? 0) + (values.height ?? 0),
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
};

const flushFrame = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

describe('MapWorkspaceShellPlacementRuntime', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1600 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
  });

  it('starts with bottom-left when the page has no collisions', () => {
    const root = document.createElement('aside');
    document.body.appendChild(root);
    setRect(root, { left: 14, top: 760, width: 600, height: 126 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root);
    runtime.start();
    expect(root.dataset.anchor).toBe('bottom-left');
    expect(runtime.getDiagnostics()).toMatchObject({ started: true, refreshCount: 1, anchorChangeCount: 1, currentAnchor: 'bottom-left' });
    runtime.dispose();
  });

  it('moves away from a colliding left sidebar', () => {
    const root = document.createElement('aside');
    const sidebar = document.createElement('div');
    sidebar.id = 'sidebar';
    document.body.append(root, sidebar);
    setRect(root, { width: 600, height: 126 });
    setRect(sidebar, { left: 0, top: 650, width: 850, height: 250 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root);
    runtime.start();
    expect(root.dataset.anchor).not.toBe('bottom-left');
    runtime.dispose();
  });

  it('chooses right when left and center are blocked', () => {
    const root = document.createElement('aside');
    const sidebar = document.createElement('div');
    sidebar.id = 'sidebar';
    document.body.append(root, sidebar);
    setRect(root, { width: 420, height: 110 });
    setRect(sidebar, { left: 0, top: 680, width: 1000, height: 220 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root);
    runtime.start();
    expect(root.dataset.anchor).toBe('bottom-right');
    runtime.dispose();
  });

  it('uses center placement for compact screens', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 });
    const root = document.createElement('aside');
    document.body.appendChild(root);
    setRect(root, { width: 360, height: 180 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root);
    runtime.start();
    expect(root.dataset.anchor).toBe('bottom-center');
    runtime.dispose();
  });

  it('ignores hidden occluders', () => {
    const root = document.createElement('aside');
    const sidebar = document.createElement('div');
    sidebar.id = 'sidebar';
    sidebar.hidden = true;
    document.body.append(root, sidebar);
    setRect(root, { width: 500, height: 110 });
    setRect(sidebar, { left: 0, top: 650, width: 1000, height: 250 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root);
    runtime.start();
    expect(root.dataset.anchor).toBe('bottom-left');
    runtime.dispose();
  });

  it('ignores aria-hidden occluders', () => {
    const root = document.createElement('aside');
    const toolbar = document.createElement('div');
    toolbar.id = 'toolbar-widget';
    toolbar.setAttribute('aria-hidden', 'true');
    document.body.append(root, toolbar);
    setRect(root, { width: 500, height: 110 });
    setRect(toolbar, { left: 0, top: 650, width: 1000, height: 250 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root);
    runtime.start();
    expect(root.dataset.anchor).toBe('bottom-left');
    runtime.dispose();
  });

  it('coalesces window resize refresh work', async () => {
    const root = document.createElement('aside');
    document.body.appendChild(root);
    setRect(root, { width: 500, height: 110 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root);
    runtime.start();
    const before = runtime.getDiagnostics().refreshCount;
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    expect(runtime.getDiagnostics().resizeCount).toBe(3);
    expect(runtime.getDiagnostics().refreshCount).toBe(before);
    await flushFrame();
    expect(runtime.getDiagnostics().refreshCount).toBe(before + 1);
    runtime.dispose();
  });

  it('responds to occluder mutations', async () => {
    const root = document.createElement('aside');
    document.body.appendChild(root);
    setRect(root, { width: 500, height: 110 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root);
    runtime.start();
    const sidebar = document.createElement('div');
    sidebar.id = 'sidebar';
    setRect(sidebar, { left: 0, top: 650, width: 1000, height: 250 });
    document.body.appendChild(sidebar);
    await flushFrame();
    expect(runtime.getDiagnostics().mutationCount).toBeGreaterThan(0);
    expect(root.dataset.anchor).not.toBe('bottom-left');
    runtime.dispose();
  });

  it('supports a custom occluder selector list', () => {
    const root = document.createElement('aside');
    const custom = document.createElement('div');
    custom.className = 'custom-occluder';
    document.body.append(root, custom);
    setRect(root, { width: 500, height: 110 });
    setRect(custom, { left: 0, top: 650, width: 1000, height: 250 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root, { occluderSelectors: ['.custom-occluder'] });
    runtime.start();
    expect(root.dataset.anchor).not.toBe('bottom-left');
    runtime.dispose();
  });

  it('deduplicates elements matched by multiple selectors', () => {
    const root = document.createElement('aside');
    const custom = document.createElement('div');
    custom.id = 'sidebar';
    custom.className = 'custom-occluder';
    document.body.append(root, custom);
    setRect(root, { width: 500, height: 110 });
    setRect(custom, { left: 0, top: 650, width: 1000, height: 250 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root, { occluderSelectors: ['#sidebar', '.custom-occluder'] });
    runtime.start();
    expect(runtime.getDiagnostics().currentAnchor).not.toBeNull();
    runtime.dispose();
  });

  it('start is idempotent', () => {
    const root = document.createElement('aside');
    document.body.appendChild(root);
    setRect(root, { width: 500, height: 110 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root);
    runtime.start();
    const before = runtime.getDiagnostics().refreshCount;
    runtime.start();
    expect(runtime.getDiagnostics().refreshCount).toBe(before);
    runtime.dispose();
  });

  it('dispose is idempotent and removes resize handling', async () => {
    const root = document.createElement('aside');
    document.body.appendChild(root);
    setRect(root, { width: 500, height: 110 });
    const runtime = new MapWorkspaceShellPlacementRuntime(root);
    runtime.start();
    runtime.dispose();
    runtime.dispose();
    const before = runtime.getDiagnostics().refreshCount;
    window.dispatchEvent(new Event('resize'));
    await flushFrame();
    expect(runtime.getDiagnostics().refreshCount).toBe(before);
    expect(runtime.getDiagnostics().started).toBe(false);
  });
});
