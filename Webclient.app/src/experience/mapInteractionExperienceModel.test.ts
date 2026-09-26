import { describe, expect, test, vi } from 'vitest';
import { createMapInteractionExperienceModel } from './mapInteractionExperienceModel';

describe('mapInteractionExperienceModel', () => {
  test('starts neutral without exposing keyboard guidance', () => {
    const model = createMapInteractionExperienceModel();
    expect(model.snapshot()).toMatchObject({
      revision: 0,
      modality: 'unknown',
      mapFocused: false,
      keyboardHintsVisible: false,
      interactionCount: 0,
      lastIntent: null,
      lastChangedAt: null,
      announcement: '',
    });
  });

  test.each([
    ['Tab', false, 'focus-next'],
    ['Tab', true, 'focus-previous'],
    ['ArrowUp', false, 'pan'],
    ['ArrowDown', false, 'pan'],
    ['ArrowLeft', false, 'pan'],
    ['ArrowRight', false, 'pan'],
    ['+', false, 'zoom-in'],
    ['=', false, 'zoom-in'],
    ['-', false, 'zoom-out'],
    ['Escape', false, 'escape'],
    ['Enter', false, 'activate'],
    [' ', false, 'activate'],
    ['x', false, 'other'],
  ] as const)('normalizes keyboard %s into %s intent', (key, shiftKey, intent) => {
    const model = createMapInteractionExperienceModel();
    model.recordKeyboard(key, shiftKey);
    expect(model.snapshot()).toMatchObject({ modality: 'keyboard', lastIntent: intent });
  });

  test('shows guidance only while keyboard modality owns map focus', () => {
    const model = createMapInteractionExperienceModel();
    model.recordKeyboard('Tab');
    expect(model.snapshot().keyboardHintsVisible).toBe(false);

    model.setMapFocused(true);
    expect(model.snapshot()).toMatchObject({
      keyboardHintsVisible: true,
      announcement: 'Tab tuşlarıyla harita kontrolleri arasında ilerleyebilirsiniz.',
    });

    model.setMapFocused(false);
    expect(model.snapshot().keyboardHintsVisible).toBe(false);
    expect(model.snapshot().announcement).toBe('');
  });

  test('switches to pointer modality and hides keyboard guidance immediately', () => {
    const model = createMapInteractionExperienceModel();
    model.recordKeyboard('ArrowLeft');
    model.setMapFocused(true);
    expect(model.snapshot().keyboardHintsVisible).toBe(true);

    model.recordPointer();
    expect(model.snapshot()).toMatchObject({
      modality: 'pointer',
      keyboardHintsVisible: false,
      announcement: '',
      interactionCount: 2,
    });
  });

  test('describes pan, zoom and escape keyboard intents without echoing raw keys', () => {
    const model = createMapInteractionExperienceModel();
    model.setMapFocused(true);

    model.recordKeyboard('ArrowRight');
    expect(model.snapshot().announcement).toContain('yön tuşlarıyla gezinme');

    model.recordKeyboard('+');
    expect(model.snapshot().announcement).toContain('yakınlaştırma');

    model.recordKeyboard('-');
    expect(model.snapshot().announcement).toContain('uzaklaştırma');

    model.recordKeyboard('Escape');
    expect(model.snapshot().announcement).toContain('Escape');

    model.recordKeyboard('sensitive-user-text');
    expect(model.snapshot().lastIntent).toBe('other');
    expect(model.snapshot().announcement).not.toContain('sensitive-user-text');
  });

  test('records monotonic revisions and injected timestamps', () => {
    let now = 10;
    const model = createMapInteractionExperienceModel({ now: () => now });

    model.recordKeyboard('Tab');
    expect(model.snapshot()).toMatchObject({ revision: 1, lastChangedAt: 10 });

    now = 20;
    model.setMapFocused(true);
    expect(model.snapshot()).toMatchObject({ revision: 2, lastChangedAt: 20 });

    now = 30;
    model.recordPointer();
    expect(model.snapshot()).toMatchObject({ revision: 3, lastChangedAt: 30 });
  });

  test('focus no-ops preserve revision and clock work', () => {
    const now = vi.fn(() => 99);
    const model = createMapInteractionExperienceModel({ now });

    const before = model.snapshot();
    const after = model.setMapFocused(false);

    expect(after).toBe(before);
    expect(after.revision).toBe(0);
    expect(now).not.toHaveBeenCalled();
  });

  test('counts interactions but not focus bookkeeping as user interactions', () => {
    const model = createMapInteractionExperienceModel();
    model.setMapFocused(true);
    model.setMapFocused(false);
    model.recordKeyboard('Tab');
    model.recordPointer();

    expect(model.snapshot().interactionCount).toBe(2);
  });

  test('notifies observers immediately and after state transitions', () => {
    const model = createMapInteractionExperienceModel();
    const revisions: number[] = [];
    const unsubscribe = model.subscribe((snapshot) => revisions.push(snapshot.revision));

    model.recordKeyboard('Tab');
    model.setMapFocused(true);
    unsubscribe();
    model.recordPointer();

    expect(revisions).toEqual([0, 1, 2]);
  });

  test('isolates observer failures from healthy observers', () => {
    const report = vi.fn();
    const healthy = vi.fn();
    const model = createMapInteractionExperienceModel({ onObserverError: report });

    model.subscribe(() => {
      throw new Error('observer failed');
    });
    model.subscribe(healthy);
    healthy.mockClear();

    expect(() => model.recordKeyboard('Tab')).not.toThrow();
    expect(report).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  test('isolates observer reporter failures', () => {
    const model = createMapInteractionExperienceModel({
      onObserverError: () => {
        throw new Error('reporter failed');
      },
    });
    model.subscribe(() => {
      throw new Error('observer failed');
    });

    expect(() => model.recordPointer()).not.toThrow();
  });

  test('bounds transition history to the configured capacity', () => {
    const model = createMapInteractionExperienceModel({ historyLimit: 2 });
    model.recordKeyboard('Tab');
    model.setMapFocused(true);
    model.recordPointer();

    expect(model.history()).toHaveLength(2);
    expect(model.history().map((entry) => entry.revision)).toEqual([2, 3]);
  });

  test('clamps history to a safe minimum', () => {
    const model = createMapInteractionExperienceModel({ historyLimit: 0 });
    model.recordKeyboard('Tab');
    model.recordPointer();
    expect(model.history()).toHaveLength(1);
    expect(model.history()[0]?.revision).toBe(2);
  });

  test('clamps history to a safe maximum', () => {
    const model = createMapInteractionExperienceModel({ historyLimit: 10_000 });
    for (let index = 0; index < 60; index += 1) {
      model.recordKeyboard(index % 2 === 0 ? 'Tab' : 'ArrowLeft');
    }

    expect(model.history()).toHaveLength(48);
    expect(model.history()[0]?.revision).toBe(13);
    expect(model.history()[47]?.revision).toBe(60);
  });

  test('history contains normalized intent only, never raw keyboard content', () => {
    const model = createMapInteractionExperienceModel();
    model.recordKeyboard('private-address-fragment');

    const serialized = JSON.stringify(model.history());
    expect(serialized).toContain('other');
    expect(serialized).not.toContain('private-address-fragment');
  });

  test('resetHistory does not mutate live interaction state', () => {
    const model = createMapInteractionExperienceModel();
    model.recordKeyboard('Tab');
    model.setMapFocused(true);
    const live = model.snapshot();

    model.resetHistory();

    expect(model.history()).toEqual([]);
    expect(model.snapshot()).toBe(live);
    expect(model.snapshot().keyboardHintsVisible).toBe(true);
  });
});
