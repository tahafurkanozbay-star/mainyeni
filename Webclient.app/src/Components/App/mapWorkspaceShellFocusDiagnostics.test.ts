import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MapWorkspaceShellBrowserRuntime } from './mapWorkspaceShellBrowserRuntime';
import { MapWorkspaceShellModel } from './mapWorkspaceShellModel';

const mountTarget = (id = 'sidebar'): HTMLDivElement => {
  const target = document.createElement('div');
  target.id = id;
  document.body.appendChild(target);
  return target;
};

describe('MapWorkspaceShellBrowserRuntime focus diagnostics', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('counts a throwing focus attempt exactly once and reports its bounded failure kind', () => {
    const target = mountTarget();
    const reporter = vi.fn();
    vi.spyOn(target, 'focus').mockImplementation(() => {
      throw new TypeError('synthetic focus failure');
    });
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model, { onError: reporter });

    expect(runtime.focus('sidebar')).toEqual({ ok: false, id: 'sidebar', reason: 'focus-failed' });
    expect(runtime.getDiagnostics()).toMatchObject({
      focusFailureCount: 1,
      lastFocusFailureKind: 'TypeError',
    });
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(target).not.toHaveAttribute('tabindex');
  });

  it('counts a silent focus mismatch once and removes temporary tabindex state', () => {
    const target = mountTarget();
    vi.spyOn(target, 'focus').mockImplementation(() => undefined);
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);

    expect(runtime.focus('sidebar')).toEqual({ ok: false, id: 'sidebar', reason: 'focus-failed' });
    expect(runtime.getDiagnostics()).toMatchObject({
      focusFailureCount: 1,
      lastFocusFailureKind: 'focus-mismatch',
    });
    expect(target).not.toHaveAttribute('tabindex');
  });

  it('contains reporter failures without double-counting the original focus failure', () => {
    const target = mountTarget();
    vi.spyOn(target, 'focus').mockImplementation(() => {
      throw new TypeError('synthetic focus failure');
    });
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model, {
      onError: () => {
        throw new RangeError('synthetic reporter failure');
      },
    });

    expect(runtime.focus('sidebar').reason).toBe('focus-failed');
    expect(runtime.getDiagnostics()).toMatchObject({
      focusFailureCount: 1,
      lastFocusFailureKind: 'reporter:RangeError',
    });
    expect(target).not.toHaveAttribute('tabindex');
  });

  it('does not count missing or hidden landmarks as focus execution failures', () => {
    const model = new MapWorkspaceShellModel();
    const runtime = new MapWorkspaceShellBrowserRuntime(model);

    expect(runtime.focus('sidebar').reason).toBe('missing');
    const hidden = mountTarget();
    hidden.hidden = true;
    expect(runtime.focus('sidebar').reason).toBe('hidden');
    expect(runtime.getDiagnostics().focusFailureCount).toBe(0);
  });
});
