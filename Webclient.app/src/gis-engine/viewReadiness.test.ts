import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForArcgisView } from './viewReadiness';

afterEach(() => vi.useRealTimers());
const deferred = () => {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('owned ArcGIS view readiness', () => {
  it('does not confuse construction with readiness', async () => {
    const ready = deferred();
    let finished = false;
    const result = waitForArcgisView({ ready: false, when: () => ready.promise }).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    ready.resolve();
    await result;
    expect(finished).toBe(true);
  });
  it('never resolves with the SDK thenable view', async () => {
    // oxlint-disable-next-line unicorn/no-thenable -- Model the SDK thenable for a promise-assimilation regression.
    const view = { ready: true, then: vi.fn(() => { throw new Error('thenable assimilation'); }) };
    await expect(waitForArcgisView(view)).resolves.toBeUndefined();
    expect(view.then).not.toHaveBeenCalled();
  });
  it.each(['missing-map', 'missing-container', 'empty-map', 'map-content-error', 'rendering-error'])('rejects %s without pretending success', async (readyState) => {
    await expect(waitForArcgisView({ readyState, when: () => new Promise(() => undefined) })).rejects.toMatchObject({ name: 'ArcgisViewReadinessError', state: readyState });
  });
  it('observes rendering errors and releases the modern watcher', async () => {
    const ready = deferred();
    const view = { readyState: 'loading', when: () => ready.promise };
    const remove = vi.fn();
    let changed: () => void = () => undefined;
    const accessorWatch = vi.fn((_view, _property, callback) => { changed = callback; return { remove }; });
    const rejected = expect(waitForArcgisView(view, { accessorWatch })).rejects.toMatchObject({ state: 'rendering-error' });
    await Promise.resolve();
    view.readyState = 'rendering-error';
    changed();
    await rejected;
    expect(remove).toHaveBeenCalledTimes(1);
    ready.reject(new Error('late SDK failure'));
    await Promise.resolve();
  });
  it('releases observers even when an injected watcher calls synchronously', async () => {
    const view = { readyState: 'loading' };
    const remove = vi.fn();
    await waitForArcgisView(view, { accessorWatch: (_view, _property, callback) => {
      view.readyState = 'ready'; callback('ready'); return { remove };
    } });
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('cancels a stalled SDK wait and ignores its late completion', async () => {
    const controller = new AbortController();
    const ready = deferred();
    const remove = vi.fn();
    const rejected = expect(waitForArcgisView({ when: () => ready.promise }, { signal: controller.signal, accessorWatch: () => ({ remove }) })).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await rejected;
    ready.resolve();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('bounds a never-ready SDK view and removes retained listeners', async () => {
    vi.useFakeTimers();
    const remove = vi.fn();
    const rejected = expect(waitForArcgisView({ when: () => new Promise(() => undefined) }, { timeoutMs: 100, accessorWatch: () => ({ remove }) })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not enter the SDK on an already cancelled wait', async () => {
    const controller = new AbortController(); controller.abort();
    const when = vi.fn();
    await expect(waitForArcgisView({ when }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(when).not.toHaveBeenCalled();
  });
  it('rejects a destroyed view even when the SDK resolves successfully', async () => {
    const ready = deferred();
    const view = { destroyed: false, when: () => ready.promise };
    const rejected = expect(waitForArcgisView(view)).rejects.toMatchObject({ name: 'ArcgisViewReadinessError' });
    await Promise.resolve(); view.destroyed = true; ready.resolve(); await rejected;
  });
});
