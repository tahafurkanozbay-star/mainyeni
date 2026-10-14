import { afterEach, describe, expect, it, vi } from 'vitest';
import { applySelectedBasemap, releaseDetachedBasemap, type SelectableBasemap } from './basemapSelection';

const diagnostics = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../../platform/runtime/runtimeDiagnostics', () => ({ runtimeDiagnostics: { captureError: diagnostics.capture } }));
const operation = (controller = new AbortController()) => ({ generation: 1, signal: controller.signal, startedAt: 0, isCurrent: () => !controller.signal.aborted });
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => { vi.restoreAllMocks(); diagnostics.capture.mockReset(); });

describe('selected basemap ownership', () => {
  it('keeps the original basemap until the owned candidate has loaded', async () => {
    const pending = deferred(); const previous = { id: 'osm', destroy: vi.fn() };
    const candidate = { id: 'topo', load: vi.fn(() => pending.promise), destroy: vi.fn() };
    const map = { basemap: previous as SelectableBasemap | null };
    const result = applySelectedBasemap(candidate, map, operation());
    expect(map.basemap).toBe(previous); pending.resolve(); await result;
    expect(map.basemap).toBe(candidate); expect(previous.destroy).not.toHaveBeenCalled();
    expect(candidate.destroy).not.toHaveBeenCalled();
  });

  it('rejects a candidate if a foreign basemap replaced the original during loading', async () => {
    const pending = deferred(); const foreign = { id: 'gray', destroy: vi.fn() };
    const candidate = { id: 'topo', load: () => pending.promise, cancelLoad: vi.fn(), destroy: vi.fn() };
    const map = { basemap: { id: 'osm' } as SelectableBasemap | null };
    const result = applySelectedBasemap(candidate, map, operation());
    map.basemap = foreign; pending.resolve();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(map.basemap).toBe(foreign); expect(foreign.destroy).not.toHaveBeenCalled();
    expect(candidate.cancelLoad).toHaveBeenCalledOnce(); expect(candidate.destroy).toHaveBeenCalledOnce();
  });

  it('releases a cancelled uncooperative candidate and ignores its late completion', async () => {
    const pending = deferred(); const controller = new AbortController();
    const candidate = { id: 'topo', load: () => pending.promise, cancelLoad: vi.fn(), destroy: vi.fn() };
    const previous = { id: 'osm' }; const map = { basemap: previous };
    const result = applySelectedBasemap(candidate, map, operation(controller));
    controller.abort(); await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve(); await Promise.resolve();
    expect(map.basemap).toBe(previous); expect(candidate.cancelLoad).toHaveBeenCalledOnce(); expect(candidate.destroy).toHaveBeenCalledOnce();
  });

  it('destroys a never-started stale candidate without loading or changing the map', async () => {
    const candidate = { id: 'topo', load: vi.fn(), cancelLoad: vi.fn(), destroy: vi.fn() };
    const previous = { id: 'osm' }; const map = { basemap: previous };
    await expect(applySelectedBasemap(candidate, map, { ...operation(), isCurrent: () => false })).rejects.toMatchObject({ name: 'AbortError' });
    expect(candidate.load).not.toHaveBeenCalled(); expect(candidate.destroy).toHaveBeenCalledOnce(); expect(map.basemap).toBe(previous);
  });

  it('continues destruction when cancellation and its diagnostics reporter both throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    diagnostics.capture.mockImplementation(() => { throw new Error('reporter unavailable'); });
    const primary = new Error('provider refused load');
    const candidate = { id: 'topo', load: vi.fn().mockRejectedValue(primary), cancelLoad: vi.fn(() => { throw new Error('private cleanup data'); }), destroy: vi.fn() };
    const previous = { id: 'osm' }; const map = { basemap: previous };
    await expect(applySelectedBasemap(candidate, map, operation())).rejects.toBe(primary);
    expect(candidate.destroy).toHaveBeenCalledOnce(); expect(map.basemap).toBe(previous);
    expect(diagnostics.capture).toHaveBeenCalledWith(expect.objectContaining({ message: 'Basemap resource cleanup failed.' }), { source: 'experience.basemap.cancel', failureKind: 'Error' }, 'warn');
    expect(warn).toHaveBeenCalledWith('Altlık kaynak temizliği raporlanamadı.');
  });

  it('preserves the original load error even when destruction and reporting fail', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    diagnostics.capture.mockImplementation(() => { throw new Error('reporter unavailable'); });
    const primary = new Error('load rejected');
    const candidate = { load: vi.fn().mockRejectedValue(primary), destroy: vi.fn(() => { throw new Error('destroy rejected'); }) };
    const previous = { id: 'osm' }; const map = { basemap: previous };
    await expect(applySelectedBasemap(candidate, map, operation())).rejects.toBe(primary);
    expect(map.basemap).toBe(previous);
  });
  it('releases only a known detached basemap and leaves an attached one alive', () => {
    const current = { id: 'current', destroy: vi.fn() };
    const detached = { id: 'old', destroy: vi.fn() };
    const map = { basemap: current };
    expect(releaseDetachedBasemap(null)).toBe(false);
    expect(releaseDetachedBasemap({ map, basemap: current })).toBe(false);
    expect(current.destroy).not.toHaveBeenCalled();
    expect(releaseDetachedBasemap({ map, basemap: detached })).toBe(true);
    expect(detached.destroy).toHaveBeenCalledOnce();
  });

});
