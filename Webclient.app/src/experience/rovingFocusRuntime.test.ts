import { describe, expect, it } from 'vitest';
import {
  createRovingTabIndex,
  focusRovingTarget,
  getAvailableRovingIndices,
  getInitialRovingIndex,
  reconcileRovingIndex,
  resolveRovingFocusMove,
} from './rovingFocusRuntime';

const items = [
  { id: 'first' },
  { id: 'disabled', disabled: true },
  { id: 'third' },
  { id: 'hidden', hidden: true },
  { id: 'last' },
] as const;

describe('rovingFocusRuntime', () => {
  it('tracks only available items', () => {
    expect(getAvailableRovingIndices(items)).toEqual([0, 2, 4]);
  });

  it('chooses the preferred item when it is available', () => {
    expect(getInitialRovingIndex(items, 2)).toBe(2);
  });

  it('skips disabled items when choosing an initial item', () => {
    expect(getInitialRovingIndex(items, 1)).toBe(2);
  });

  it('returns -1 for an empty toolbar', () => {
    expect(getInitialRovingIndex([], 0)).toBe(-1);
  });

  it('moves right and skips unavailable items', () => {
    expect(resolveRovingFocusMove(items, 0, 'ArrowRight', {
      orientation: 'horizontal',
    })).toEqual({ index: 2, id: 'third' });
  });

  it('wraps horizontal navigation by default', () => {
    expect(resolveRovingFocusMove(items, 4, 'ArrowRight', {
      orientation: 'horizontal',
    })).toEqual({ index: 0, id: 'first' });
  });

  it('does not wrap when loop is disabled', () => {
    expect(resolveRovingFocusMove(items, 4, 'ArrowRight', {
      orientation: 'horizontal',
      loop: false,
    })).toEqual({ index: 4, id: 'last' });
  });

  it('reverses horizontal arrows for rtl direction', () => {
    expect(resolveRovingFocusMove(items, 2, 'ArrowRight', {
      orientation: 'horizontal',
      direction: 'rtl',
    })).toEqual({ index: 0, id: 'first' });
  });

  it('uses vertical arrow keys for vertical toolbars', () => {
    expect(resolveRovingFocusMove(items, 0, 'ArrowDown', {
      orientation: 'vertical',
    })).toEqual({ index: 2, id: 'third' });
    expect(resolveRovingFocusMove(items, 2, 'ArrowUp', {
      orientation: 'vertical',
    })).toEqual({ index: 0, id: 'first' });
  });

  it('ignores unrelated keys', () => {
    expect(resolveRovingFocusMove(items, 0, 'PageDown')).toBeNull();
  });

  it('moves to Home and End boundaries', () => {
    expect(resolveRovingFocusMove(items, 2, 'Home')).toEqual({ index: 0, id: 'first' });
    expect(resolveRovingFocusMove(items, 2, 'End')).toEqual({ index: 4, id: 'last' });
  });

  it('creates exactly one tab stop', () => {
    expect(createRovingTabIndex(items, 2)).toEqual([-1, -1, 0, -1, -1]);
  });

  it('repairs an invalid active index', () => {
    expect(createRovingTabIndex(items, 1)).toEqual([-1, -1, 0, -1, -1]);
  });

  it('preserves the active identity after reordering', () => {
    const next = [
      { id: 'last' },
      { id: 'first' },
      { id: 'third' },
    ];
    expect(reconcileRovingIndex(items, next, 2)).toBe(2);
  });

  it('repairs active identity when an item disappears', () => {
    const next = [
      { id: 'first' },
      { id: 'last' },
    ];
    expect(reconcileRovingIndex(items, next, 2)).toBe(1);
  });

  it('focuses a matching available target without selector interpolation', () => {
    const root = document.createElement('div');
    const button = document.createElement('button');
    button.dataset.rovingFocusId = 'a"b\\c';
    root.append(button);
    document.body.append(root);

    expect(focusRovingTarget(root, 'a"b\\c')).toBe(true);
    expect(document.activeElement).toBe(button);
    root.remove();
  });

  it('does not focus disabled targets', () => {
    const root = document.createElement('div');
    const button = document.createElement('button');
    button.dataset.rovingFocusId = 'disabled';
    button.disabled = true;
    root.append(button);
    document.body.append(root);

    expect(focusRovingTarget(root, 'disabled')).toBe(false);
    root.remove();
  });
});
