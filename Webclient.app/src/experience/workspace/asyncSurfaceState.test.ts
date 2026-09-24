import { describe, expect, it, vi } from 'vitest';
import { AsyncSurfaceState } from './asyncSurfaceState';

describe('AsyncSurfaceState', () => {
  it('models idle and loading aria-busy state', () => {
    const model = new AsyncSurfaceState();
    expect(model.snapshot.phase).toBe('idle');
    model.loading('Katmanlar yükleniyor');
    expect(model.snapshot).toMatchObject({ phase: 'loading', busy: true, message: 'Katmanlar yükleniyor', ariaLive: 'off' });
  });

  it('models ready results and maps zero results to empty', () => {
    const model = new AsyncSurfaceState();
    model.ready(12, '12 sonuç hazır.');
    expect(model.snapshot).toMatchObject({ phase: 'ready', resultCount: 12, ariaLive: 'polite' });
    model.ready(0);
    expect(model.snapshot).toMatchObject({ phase: 'empty', resultCount: 0 });
  });

  it('models recoverable assertive errors without scheduling automatic work', () => {
    const model = new AsyncSurfaceState();
    model.error('Bağlantı kurulamadı.');
    expect(model.snapshot).toMatchObject({ phase: 'error', recoverable: true, errorMessage: 'Bağlantı kurulamadı.', ariaLive: 'assertive' });
  });

  it('announces empty, ready and error outcomes with correct priority', () => {
    const announce = vi.fn();
    const model = new AsyncSurfaceState({ onAnnouncement: announce });
    model.empty(); model.ready(2, 'İki sonuç hazır.'); model.error('Hata', false);
    expect(announce.mock.calls.map((call) => call[0].priority)).toEqual(['polite', 'polite', 'assertive']);
  });

  it('exposes reduced-motion and coarse-pointer facts', () => {
    const model = new AsyncSurfaceState({ reducedMotion: true, coarsePointer: true });
    expect(model.snapshot.reducedMotion).toBe(true);
    expect(model.snapshot.targetSize).toBe(48);
  });

  it('resets transient state', () => {
    const model = new AsyncSurfaceState();
    model.error('Hata'); model.reset();
    expect(model.snapshot).toMatchObject({ phase: 'idle', errorMessage: undefined, recoverable: false, resultCount: undefined });
  });

  it('rejects invalid counts and blank errors', () => {
    const model = new AsyncSurfaceState();
    expect(() => model.ready(-1)).toThrow(/resultCount/);
    expect(() => model.ready(1.5)).toThrow(/resultCount/);
    expect(() => model.error(' ')).toThrow(/non-empty/);
  });

  it('isolates observer, announcement and reporter failures', () => {
    const healthy = vi.fn();
    const model = new AsyncSurfaceState({ onAnnouncement: () => { throw new Error('announce'); }, onObserverError: () => { throw new Error('report'); } });
    model.subscribe(() => { throw new Error('observer'); }); model.subscribe(healthy);
    expect(() => model.empty()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it('keeps snapshots immutable', () => {
    const model = new AsyncSurfaceState();
    expect(Object.isFrozen(model.snapshot)).toBe(true);
    model.loading();
    expect(Object.isFrozen(model.snapshot)).toBe(true);
  });
});
