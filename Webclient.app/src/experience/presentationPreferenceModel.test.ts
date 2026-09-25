import { describe, expect, test, vi } from 'vitest';
import {
  createPresentationPreferenceModel,
  presentationDataAttributes,
} from './presentationPreferenceModel';

describe('presentationPreferenceModel', () => {
  test('starts with a stable desktop fine-pointer profile', () => {
    const model = createPresentationPreferenceModel();

    expect(model.snapshot()).toMatchObject({
      revision: 0,
      changeCount: 0,
      changedAt: null,
      motion: 'full',
      contrast: 'standard',
      colorMode: 'normal',
      pointer: 'fine',
      viewport: 'wide',
      viewportWidth: 1280,
      viewportHeight: 720,
      targetSizePx: 44,
      density: 'compact',
      canAnimate: true,
      shouldUseLargeTargets: false,
      shouldPreferSingleColumnPanels: false,
      shouldAvoidDecorativeTransparency: false,
    });
  });

  test('derives compact coarse-pointer accessibility facts', () => {
    const model = createPresentationPreferenceModel({
      initial: {
        reducedMotion: true,
        highContrast: true,
        forcedColors: true,
        coarsePointer: true,
        viewportWidth: 390,
        viewportHeight: 844,
      },
    });

    expect(model.snapshot()).toMatchObject({
      motion: 'reduced',
      contrast: 'more',
      colorMode: 'forced',
      pointer: 'coarse',
      viewport: 'compact',
      targetSizePx: 48,
      density: 'comfortable',
      canAnimate: false,
      shouldUseLargeTargets: true,
      shouldPreferSingleColumnPanels: true,
      shouldAvoidDecorativeTransparency: true,
    });
  });

  test.each([
    [767, 'compact'],
    [768, 'regular'],
    [1279, 'regular'],
    [1280, 'wide'],
  ] as const)('classifies viewport width %s as %s', (viewportWidth, viewport) => {
    const model = createPresentationPreferenceModel({ initial: { viewportWidth } });
    expect(model.snapshot().viewport).toBe(viewport);
  });

  test('clamps invalid viewport dimensions into a bounded safe range', () => {
    const model = createPresentationPreferenceModel({
      initial: {
        viewportWidth: Number.NaN,
        viewportHeight: Number.POSITIVE_INFINITY,
      },
    });

    expect(model.snapshot().viewportWidth).toBe(1280);
    expect(model.snapshot().viewportHeight).toBe(720);

    model.replace({
      reducedMotion: false,
      highContrast: false,
      forcedColors: false,
      coarsePointer: false,
      viewportWidth: 1,
      viewportHeight: 99_999,
    });

    expect(model.snapshot().viewportWidth).toBe(240);
    expect(model.snapshot().viewportHeight).toBe(16_384);
  });

  test('partial updates preserve unspecified environment facts', () => {
    const model = createPresentationPreferenceModel({
      initial: {
        viewportWidth: 900,
        viewportHeight: 700,
        coarsePointer: true,
      },
    });

    model.update({ reducedMotion: true });

    expect(model.snapshot()).toMatchObject({
      motion: 'reduced',
      pointer: 'coarse',
      viewport: 'regular',
      viewportWidth: 900,
      viewportHeight: 700,
    });
  });

  test('no-op updates preserve revision, timestamp and observer count', () => {
    const now = vi.fn(() => 1234);
    const observer = vi.fn();
    const model = createPresentationPreferenceModel({ now });
    model.subscribe(observer);
    observer.mockClear();

    const before = model.snapshot();
    const after = model.update({ viewportWidth: 1280 });

    expect(after).toBe(before);
    expect(after.revision).toBe(0);
    expect(after.changedAt).toBeNull();
    expect(observer).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  test('meaningful updates advance monotonic presentation state', () => {
    let clock = 10;
    const model = createPresentationPreferenceModel({ now: () => clock });

    model.update({ viewportWidth: 700 });
    expect(model.snapshot()).toMatchObject({
      revision: 1,
      changeCount: 1,
      changedAt: 10,
      viewport: 'compact',
    });

    clock = 20;
    model.update({ highContrast: true });
    expect(model.snapshot()).toMatchObject({
      revision: 2,
      changeCount: 2,
      changedAt: 20,
      contrast: 'more',
    });
  });

  test('replace normalizes a complete browser environment', () => {
    const model = createPresentationPreferenceModel({
      initial: {
        reducedMotion: true,
        coarsePointer: true,
        viewportWidth: 400,
      },
    });

    model.replace({
      reducedMotion: false,
      highContrast: false,
      forcedColors: false,
      coarsePointer: false,
      viewportWidth: 1440,
      viewportHeight: 900,
    });

    expect(model.snapshot()).toMatchObject({
      motion: 'full',
      contrast: 'standard',
      colorMode: 'normal',
      pointer: 'fine',
      viewport: 'wide',
      density: 'compact',
      targetSizePx: 44,
    });
  });

  test('notifies observers immediately and after meaningful updates', () => {
    const model = createPresentationPreferenceModel();
    const revisions: number[] = [];

    const unsubscribe = model.subscribe((snapshot) => revisions.push(snapshot.revision));
    model.update({ coarsePointer: true });
    model.update({ highContrast: true });
    unsubscribe();
    model.update({ reducedMotion: true });

    expect(revisions).toEqual([0, 1, 2]);
  });

  test('isolates observer failures from healthy observers', () => {
    const report = vi.fn();
    const healthy = vi.fn();
    const model = createPresentationPreferenceModel({ onObserverError: report });

    model.subscribe(() => {
      throw new Error('broken presentation observer');
    });
    model.subscribe(healthy);
    healthy.mockClear();

    expect(() => model.update({ reducedMotion: true })).not.toThrow();
    expect(report).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  test('isolates failures thrown by the observer error reporter', () => {
    const model = createPresentationPreferenceModel({
      onObserverError: () => {
        throw new Error('reporter failed');
      },
    });
    model.subscribe(() => {
      throw new Error('observer failed');
    });

    expect(() => model.update({ forcedColors: true })).not.toThrow();
  });

  test('records bounded transition history with only derived presentation facts', () => {
    let now = 0;
    const model = createPresentationPreferenceModel({
      historyLimit: 2,
      now: () => ++now,
    });

    model.update({ reducedMotion: true });
    model.update({ highContrast: true });
    model.update({ coarsePointer: true });

    expect(model.history()).toHaveLength(2);
    expect(model.history().map((entry) => entry.revision)).toEqual([2, 3]);
    expect(model.history()[0]).toMatchObject({
      changedAt: 2,
      from: { contrast: 'standard' },
      to: { contrast: 'more' },
    });
    expect(JSON.stringify(model.history())).not.toContain('viewportWidth');
    expect(JSON.stringify(model.history())).not.toContain('viewportHeight');
  });

  test('clamps history capacity to a safe minimum', () => {
    const model = createPresentationPreferenceModel({ historyLimit: 0 });

    model.update({ reducedMotion: true });
    model.update({ highContrast: true });

    expect(model.history()).toHaveLength(1);
    expect(model.history()[0]?.revision).toBe(2);
  });

  test('clamps history capacity to a safe maximum', () => {
    const model = createPresentationPreferenceModel({ historyLimit: 10_000 });

    for (let index = 0; index < 100; index += 1) {
      model.update({ viewportWidth: 300 + index });
    }

    expect(model.history()).toHaveLength(64);
    expect(model.history()[0]?.revision).toBe(37);
    expect(model.history()[63]?.revision).toBe(100);
  });

  test('resetHistory clears diagnostic transitions without mutating live state', () => {
    const model = createPresentationPreferenceModel();
    model.update({ coarsePointer: true });
    const live = model.snapshot();

    model.resetHistory();

    expect(model.history()).toEqual([]);
    expect(model.snapshot()).toBe(live);
    expect(model.snapshot().pointer).toBe('coarse');
  });

  test('maps snapshot state into deterministic root data attributes', () => {
    const model = createPresentationPreferenceModel({
      initial: {
        reducedMotion: true,
        highContrast: true,
        forcedColors: true,
        coarsePointer: true,
        viewportWidth: 600,
      },
    });

    expect(presentationDataAttributes(model.snapshot())).toEqual({
      'data-exp-motion': 'reduced',
      'data-exp-contrast': 'more',
      'data-exp-color-mode': 'forced',
      'data-exp-pointer': 'coarse',
      'data-exp-viewport': 'compact',
      'data-exp-density': 'comfortable',
    });
  });

  test('keeps forced colors independent from high-contrast media state', () => {
    const model = createPresentationPreferenceModel({
      initial: { forcedColors: true, highContrast: false },
    });

    expect(model.snapshot()).toMatchObject({
      colorMode: 'forced',
      contrast: 'standard',
      shouldAvoidDecorativeTransparency: true,
    });
  });

  test('uses comfortable density for coarse pointers even on wide screens', () => {
    const model = createPresentationPreferenceModel({
      initial: { coarsePointer: true, viewportWidth: 1920 },
    });

    expect(model.snapshot()).toMatchObject({
      viewport: 'wide',
      pointer: 'coarse',
      density: 'comfortable',
      targetSizePx: 48,
    });
  });
});
