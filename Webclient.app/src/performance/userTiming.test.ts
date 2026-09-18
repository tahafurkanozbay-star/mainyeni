import { describe, expect, it, vi } from 'vitest';
import { createUserTimingProfiler } from './userTiming';

describe('native user timing profiler', () => {
  it('uses native mark/measure when available and clears retained entries', () => {
    let now = 10;
    const mark = vi.fn();
    const measure = vi.fn(() => ({
      name: 'kent-rehberi:bootstrap',
      entryType: 'measure',
      startTime: 10,
      duration: 40,
      detail: null,
      toJSON: () => ({}),
    } as PerformanceMeasure));
    const clearMarks = vi.fn();
    const clearMeasures = vi.fn();

    const profiler = createUserTimingProfiler({
      now: () => now,
      mark,
      measure,
      clearMarks,
      clearMeasures,
    }, 4);

    expect(profiler.begin('bootstrap')).toBe('kent-rehberi:bootstrap:start');
    now = 60;
    expect(profiler.end('bootstrap')).toBe(40);
    expect(mark).toHaveBeenCalledWith('kent-rehberi:bootstrap:start');
    expect(measure).toHaveBeenCalledWith(
      'kent-rehberi:bootstrap',
      'kent-rehberi:bootstrap:start',
    );
    expect(clearMarks).toHaveBeenCalled();
    expect(clearMeasures).toHaveBeenCalled();
    expect(profiler.snapshot()[0]).toMatchObject({
      name: 'bootstrap',
      count: 1,
    });
  });

  it('falls back to monotonic duration when native User Timing fails', () => {
    let now = 100;
    const profiler = createUserTimingProfiler({
      now: () => now,
      mark: () => { throw new Error('unsupported'); },
      measure: () => { throw new Error('unsupported'); },
    });

    profiler.begin('fallback');
    now = 175;
    expect(profiler.end('fallback')).toBe(75);
    expect(profiler.snapshot()[0]?.duration.maximum).toBe(75);
    expect(profiler.nativeFailureCount()).toBe(2);
  });

  it('rejects duplicate active marks and invalid direct samples', () => {
    const profiler = createUserTimingProfiler({ now: () => 0 });
    expect(profiler.begin('query')).not.toBeNull();
    expect(profiler.begin('query')).toBeNull();
    expect(profiler.record('', 10)).toBe(false);
    expect(profiler.record('query', -1)).toBe(false);
    expect(profiler.activeMarks()).toBe(1);
  });

  it('bounds retained samples and destroys active native marks on dispose', () => {
    const clearMarks = vi.fn();
    const clearMeasures = vi.fn();
    const profiler = createUserTimingProfiler({
      now: () => 0,
      clearMarks,
      clearMeasures,
    }, 2);

    profiler.record('search', 10);
    profiler.record('search', 20);
    profiler.record('search', 30);
    profiler.begin('active');

    expect(profiler.snapshot()[0]?.duration.minimum).toBe(20);
    profiler.dispose();
    expect(profiler.activeMarks()).toBe(0);
    expect(profiler.snapshot()).toEqual([]);
    expect(profiler.record('after-dispose', 1)).toBe(false);
    expect(profiler.nativeFailureCount()).toBe(0);
    expect(clearMarks).toHaveBeenCalled();
    expect(clearMeasures).toHaveBeenCalled();
  });
});
