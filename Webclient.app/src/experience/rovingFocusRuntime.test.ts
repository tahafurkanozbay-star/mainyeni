import { describe, expect, it } from 'vitest';
import {
  createRovingTabIndex,
  focusRovingTarget,
  getAvailableRovingIndices,
  getInitialRovingIndex,
  reconcileRovingIndex,
  resolveRovingFocusMove,
  resolveRovingTypeaheadMove,
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

  it('normalizes Turkish labels for typeahead and skips unavailable entries', () => {
    const entries = [
      { id: 'a', label: 'Işık Parkı' },
      { id: 'disabled', label: 'İzmir', disabled: true },
      { id: 'b', label: 'Çevre' },
    ];
    expect(resolveRovingTypeaheadMove(entries, 2, 'isik')).toEqual({ index: 0, id: 'a' });
    expect(resolveRovingTypeaheadMove(entries, 0, 'ce')).toEqual({ index: 2, id: 'b' });
    expect(resolveRovingTypeaheadMove(entries, 0, 'iz')).toBeNull();
  });

  it('cycles repeated letters and safely ignores empty lists', () => {
    const entries = [
      { id: 'a', label: 'Bilgi' },
      { id: 'b', label: 'Bölge' },
      { id: 'c', label: 'Başlangıç' },
    ];
    expect(resolveRovingTypeaheadMove(entries, 0, 'b')).toEqual({ index: 1, id: 'b' });
    expect(resolveRovingTypeaheadMove(entries, 1, 'bb')).toEqual({ index: 2, id: 'c' });
    expect(resolveRovingTypeaheadMove([], 0, 'b')).toBeNull();
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

  it('refuses to focus a target inside hidden, inert or disabled ancestors', () => {
    const root = document.createElement('div');
    const fieldset = document.createElement('fieldset');
    const button = document.createElement('button');
    button.dataset.rovingFocusId = 'map-control';
    fieldset.append(button);
    root.append(fieldset);
    document.body.append(root);
    try {
      root.setAttribute('aria-hidden', 'true');
      expect(focusRovingTarget(root, 'map-control')).toBe(false);
      root.removeAttribute('aria-hidden');
      root.setAttribute('inert', '');
      expect(focusRovingTarget(root, 'map-control')).toBe(false);
      root.removeAttribute('inert');
      fieldset.disabled = true;
      expect(focusRovingTarget(root, 'map-control')).toBe(false);
      fieldset.disabled = false;
      expect(focusRovingTarget(root, 'map-control')).toBe(true);
      expect(document.activeElement).toBe(button);
    } finally {
      root.remove();
    }
  });
});
