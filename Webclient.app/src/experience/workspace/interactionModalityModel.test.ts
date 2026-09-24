import { describe, expect, it, vi } from 'vitest';
import { InteractionModalityModel } from './interactionModalityModel';

describe('InteractionModalityModel', () => {
  it('shows focus-visible only for keyboard modality', () => {
    const model = new InteractionModalityModel();
    expect(model.snapshot.focusVisible).toBe(false);
    model.keyboard();
    expect(model.snapshot).toMatchObject({ modality: 'keyboard', focusVisible: true });
    model.pointer();
    expect(model.snapshot).toMatchObject({ modality: 'pointer', focusVisible: false });
  });

  it('maps coarse pointer interactions to touch and 48px targets', () => {
    const model = new InteractionModalityModel({ coarsePointer: true });
    model.pointer();
    expect(model.snapshot).toMatchObject({ modality: 'touch', targetSize: 48, coarsePointer: true });
  });

  it('ignores modifier-only key presses', () => {
    const model = new InteractionModalityModel();
    const revision = model.snapshot.revision;
    model.handleKey('Shift'); model.handleKey('Control'); model.handleKey('Alt'); model.handleKey('Meta');
    expect(model.snapshot.revision).toBe(revision);
    model.handleKey('Tab');
    expect(model.snapshot.modality).toBe('keyboard');
  });

  it('supports explicit touch and programmatic transitions', () => {
    const model = new InteractionModalityModel();
    model.touch(); expect(model.snapshot.modality).toBe('touch');
    model.programmatic(); expect(model.snapshot.modality).toBe('programmatic');
  });

  it('does not emit redundant transitions', () => {
    const listener = vi.fn();
    const model = new InteractionModalityModel({ initialModality: 'keyboard' });
    model.subscribe(listener);
    model.keyboard();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates observer and reporter failures', () => {
    const healthy = vi.fn();
    const model = new InteractionModalityModel({ onObserverError: () => { throw new Error('reporter'); } });
    model.subscribe(() => { throw new Error('observer'); });
    model.subscribe(healthy);
    expect(() => model.keyboard()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it('keeps snapshots immutable', () => {
    const model = new InteractionModalityModel();
    expect(Object.isFrozen(model.snapshot)).toBe(true);
    model.keyboard();
    expect(Object.isFrozen(model.snapshot)).toBe(true);
  });
});
