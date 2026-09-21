import { describe, expect, it, vi } from 'vitest';
import { watchArcgisProperty } from './arcgisReactiveRuntime';

describe('arcgisReactiveRuntime', () => {
  it('prefers the injected reactiveUtils-backed watcher', () => {
    const legacyWatch = vi.fn();
    const target = { watch: legacyWatch };
    const remove = vi.fn();
    const accessorWatch = vi.fn(() => ({ remove }));
    const callback = vi.fn();

    const handle = watchArcgisProperty(target, 'updating', callback, accessorWatch);

    expect(handle).toEqual({ remove });
    expect(accessorWatch).toHaveBeenCalledWith(target, 'updating', callback);
    expect(legacyWatch).not.toHaveBeenCalled();
  });

  it('retains a bounded legacy fallback for isolated compatibility callers', () => {
    const remove = vi.fn();
    const legacyWatch = vi.fn(() => ({ remove }));
    const target = { watch: legacyWatch };
    const callback = vi.fn();

    const handle = watchArcgisProperty(target, 'scale', callback);

    expect(handle).toEqual({ remove });
    expect(legacyWatch).toHaveBeenCalledWith('scale', callback);
  });

  it('returns null when the target has no observable property contract', () => {
    expect(watchArcgisProperty({}, 'scale', vi.fn())).toBeNull();
    expect(watchArcgisProperty(null, 'scale', vi.fn())).toBeNull();
  });
});
