import { describe, expect, it } from 'vitest';
import {
  createQueryResultAnnouncement,
  createQueryResultFocusRequest,
  createQueryResultInteractionState,
  createQueryResultListboxAria,
  createQueryResultOptionAria,
  createQueryResultOptionId,
  createQueryResultPositionInSet,
  createQueryResultSelectionAnnouncement,
  createQueryResultSetSize,
  createQueryResultTabIndex,
  findEnabledIndexFrom,
  findFirstEnabledIndex,
  findLastEnabledIndex,
  getQueryResultMotionBehavior,
  getQueryResultScrollAlignment,
  getQueryResultTouchTargetClassName,
  isQueryResultActivationKey,
  isQueryResultNavigationKey,
  moveQueryResultActiveIndex,
  normalizeQueryResultActiveIndex,
  normalizeResultKeyForId,
  normalizeResultOwnerId,
  reconcileQueryResultInteractionState,
  shouldAnnounceQueryResultChange,
  shouldScrollQueryResultIntoView,
  type QueryResultInteractionItem,
} from './QueryResultInteractionRuntime';

const items: readonly QueryResultInteractionItem[] = [
  { key: 'alpha' },
  { key: 'disabled', disabled: true },
  { key: 'charlie' },
  { key: 'delta' },
  { key: 'echo', disabled: true },
  { key: 'foxtrot' },
];

describe('QueryResultInteractionRuntime identifiers', () => {
  it('normalizes owner ids deterministically', () => {
    expect(normalizeResultOwnerId('  Kent Rehberi / Arama  ')).toBe('kent-rehberi-arama');
    expect(normalizeResultOwnerId('')).toBe('query-results');
    expect(normalizeResultOwnerId(null)).toBe('query-results');
  });

  it('normalizes record keys for safe DOM ids', () => {
    expect(normalizeResultKeyForId('id:42 / Çankaya')).toBe('id-42-ankaya');
    expect(normalizeResultKeyForId('***')).toBe('item');
  });

  it('creates stable option ids with a bounded non-negative index', () => {
    expect(createQueryResultOptionId('search', 'id:42', 3)).toBe('search-option-id-42-3');
    expect(createQueryResultOptionId('search', 'id:42', -9)).toBe('search-option-id-42-0');
  });
});

describe('QueryResultInteractionRuntime enabled-item discovery', () => {
  it('finds the first and last enabled items', () => {
    expect(findFirstEnabledIndex(items)).toBe(0);
    expect(findLastEnabledIndex(items)).toBe(5);
  });

  it('returns -1 when every item is disabled', () => {
    const disabled = [{ key: 'a', disabled: true }, { key: 'b', disabled: true }];
    expect(findFirstEnabledIndex(disabled)).toBe(-1);
    expect(findLastEnabledIndex(disabled)).toBe(-1);
  });

  it('moves forward while skipping disabled options', () => {
    expect(findEnabledIndexFrom(items, 0, 1)).toBe(2);
    expect(findEnabledIndexFrom(items, 3, 1)).toBe(5);
  });

  it('moves backward while skipping disabled options', () => {
    expect(findEnabledIndexFrom(items, 5, -1)).toBe(3);
    expect(findEnabledIndexFrom(items, 2, -1)).toBe(0);
  });

  it('does not wrap unless requested', () => {
    expect(findEnabledIndexFrom(items, 5, 1, false)).toBe(-1);
    expect(findEnabledIndexFrom(items, 5, 1, true)).toBe(0);
    expect(findEnabledIndexFrom(items, 0, -1, true)).toBe(5);
  });

  it('terminates when wrapped input has no enabled items', () => {
    const disabled = [{ key: 'a', disabled: true }, { key: 'b', disabled: true }];
    expect(findEnabledIndexFrom(disabled, 0, 1, true)).toBe(-1);
  });
});

describe('QueryResultInteractionRuntime active state', () => {
  it('normalizes an enabled active index', () => {
    expect(normalizeQueryResultActiveIndex(items, 3)).toBe(3);
  });

  it('moves a disabled active index to the next enabled item', () => {
    expect(normalizeQueryResultActiveIndex(items, 1)).toBe(2);
  });

  it('falls backward when no later enabled item exists', () => {
    const trailingDisabled = [
      { key: 'a' },
      { key: 'b', disabled: true },
    ];
    expect(normalizeQueryResultActiveIndex(trailingDisabled, 1)).toBe(0);
  });

  it('returns -1 for an empty result collection', () => {
    expect(normalizeQueryResultActiveIndex([], 0)).toBe(-1);
  });

  it('creates immutable interaction state metadata', () => {
    const state = createQueryResultInteractionState(items, 2);
    expect(state).toEqual({
      activeIndex: 2,
      activeKey: 'charlie',
      count: 6,
      enabledCount: 4,
    });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('retains the active key when refreshed results reorder', () => {
    const previous = createQueryResultInteractionState(items, 3);
    const reordered = [items[3]!, items[0]!, items[2]!];
    expect(reconcileQueryResultInteractionState(previous, reordered)).toEqual({
      activeIndex: 0,
      activeKey: 'delta',
      count: 3,
      enabledCount: 3,
    });
  });

  it('falls back safely when the previous active key disappears', () => {
    const previous = createQueryResultInteractionState(items, 5);
    const reduced = [items[0]!, items[2]!];
    expect(reconcileQueryResultInteractionState(previous, reduced).activeIndex).toBe(1);
  });
});

describe('QueryResultInteractionRuntime keyboard navigation', () => {
  it('supports ArrowDown without wrapping by default', () => {
    expect(moveQueryResultActiveIndex(items, 0, 'ArrowDown')).toBe(2);
    expect(moveQueryResultActiveIndex(items, 5, 'ArrowDown')).toBe(5);
  });

  it('supports ArrowUp without wrapping by default', () => {
    expect(moveQueryResultActiveIndex(items, 5, 'ArrowUp')).toBe(3);
    expect(moveQueryResultActiveIndex(items, 0, 'ArrowUp')).toBe(0);
  });

  it('supports optional arrow-key wrapping', () => {
    expect(moveQueryResultActiveIndex(items, 5, 'ArrowDown', { wrap: true })).toBe(0);
    expect(moveQueryResultActiveIndex(items, 0, 'ArrowUp', { wrap: true })).toBe(5);
  });

  it('supports Home and End', () => {
    expect(moveQueryResultActiveIndex(items, 3, 'Home')).toBe(0);
    expect(moveQueryResultActiveIndex(items, 3, 'End')).toBe(5);
  });

  it('supports PageDown with disabled-target recovery', () => {
    expect(moveQueryResultActiveIndex(items, 0, 'PageDown', { pageSize: 4 })).toBe(5);
  });

  it('supports PageUp with disabled-target recovery', () => {
    expect(moveQueryResultActiveIndex(items, 5, 'PageUp', { pageSize: 4 })).toBe(0);
  });

  it('bounds page size to a positive value', () => {
    expect(moveQueryResultActiveIndex(items, 0, 'PageDown', { pageSize: 0 })).toBe(2);
  });

  it('returns -1 when navigating an empty result collection', () => {
    expect(moveQueryResultActiveIndex([], 0, 'ArrowDown')).toBe(-1);
  });

  it('recognizes supported navigation keys only', () => {
    expect(isQueryResultNavigationKey('ArrowDown')).toBe(true);
    expect(isQueryResultNavigationKey('PageUp')).toBe(true);
    expect(isQueryResultNavigationKey('Tab')).toBe(false);
    expect(isQueryResultNavigationKey('Enter')).toBe(false);
  });

  it('recognizes keyboard activation keys', () => {
    expect(isQueryResultActivationKey('Enter')).toBe(true);
    expect(isQueryResultActivationKey(' ')).toBe(true);
    expect(isQueryResultActivationKey('Spacebar')).toBe(false);
  });
});

describe('QueryResultInteractionRuntime focus model', () => {
  it('creates a focus request for the normalized active option', () => {
    expect(createQueryResultFocusRequest('search', items, 1)).toEqual({
      index: 2,
      key: 'charlie',
      optionId: 'search-option-charlie-2',
    });
  });

  it('returns null when no option can receive focus', () => {
    expect(createQueryResultFocusRequest('search', [], 0)).toBeNull();
  });

  it('calculates enabled set size', () => {
    expect(createQueryResultSetSize(items)).toBe(4);
  });

  it('calculates one-based enabled position', () => {
    expect(createQueryResultPositionInSet(items, 0)).toBe(1);
    expect(createQueryResultPositionInSet(items, 2)).toBe(2);
    expect(createQueryResultPositionInSet(items, 5)).toBe(4);
  });

  it('returns zero position for disabled items', () => {
    expect(createQueryResultPositionInSet(items, 1)).toBe(0);
  });

  it('implements roving tabindex', () => {
    expect(createQueryResultTabIndex(2, 2)).toBe(0);
    expect(createQueryResultTabIndex(2, 3)).toBe(-1);
    expect(createQueryResultTabIndex(2, 2, true)).toBe(-1);
  });
});

describe('QueryResultInteractionRuntime announcements', () => {
  it('announces loading independently of result counts', () => {
    expect(createQueryResultAnnouncement({
      totalCount: 20,
      visibleCount: 10,
      loading: true,
    })).toBe('Arama sonuçları yükleniyor.');
  });

  it('announces recoverable error state', () => {
    expect(createQueryResultAnnouncement({
      totalCount: 0,
      visibleCount: 0,
      error: true,
    })).toBe('Arama sonuçları yüklenemedi. Lütfen yeniden deneyin.');
  });

  it('announces an empty query result', () => {
    expect(createQueryResultAnnouncement({
      query: 'park',
      totalCount: 0,
      visibleCount: 0,
    })).toBe('“park” için sonuç bulunamadı.');
  });

  it('announces a generic empty state without query text', () => {
    expect(createQueryResultAnnouncement({
      totalCount: 0,
      visibleCount: 0,
    })).toBe('Gösterilecek arama sonucu bulunamadı.');
  });

  it('announces visible subset and category count', () => {
    expect(createQueryResultAnnouncement({
      query: 'metro',
      totalCount: 25,
      visibleCount: 10,
      categoryCount: 3,
    })).toBe('“metro” için 25 sonuçtan 10 tanesi gösteriliyor. 3 kategori bulundu.');
  });

  it('announces all results when no truncation exists', () => {
    expect(createQueryResultAnnouncement({
      totalCount: 4,
      visibleCount: 4,
    })).toBe('4 sonuç gösteriliyor.');
  });

  it('announces selection position and category', () => {
    expect(createQueryResultSelectionAnnouncement({
      title: 'Kızılay Metro',
      category: 'Metro',
      position: 2,
      totalCount: 9,
    })).toBe('Kızılay Metro, Metro, 2/9.');
  });

  it('normalizes missing selection title', () => {
    expect(createQueryResultSelectionAnnouncement({
      title: '',
      position: 1,
      totalCount: 1,
    })).toBe('İsimsiz sonuç, 1/1.');
  });

  it('detects meaningful announcement changes', () => {
    const previous = { query: 'park', totalCount: 3, visibleCount: 3 };
    expect(shouldAnnounceQueryResultChange(previous, previous)).toBe(false);
    expect(shouldAnnounceQueryResultChange(previous, {
      ...previous,
      totalCount: 4,
    })).toBe(true);
    expect(shouldAnnounceQueryResultChange(null, previous)).toBe(true);
  });
});

describe('QueryResultInteractionRuntime ARIA metadata', () => {
  it('creates listbox metadata with active descendant', () => {
    expect(createQueryResultListboxAria('Yakındaki sonuçlar', 'search-option-a-0')).toEqual({
      role: 'listbox',
      'aria-label': 'Yakındaki sonuçlar',
      'aria-activedescendant': 'search-option-a-0',
    });
  });

  it('uses a safe fallback listbox label', () => {
    expect(createQueryResultListboxAria('')).toEqual({
      role: 'listbox',
      'aria-label': 'Arama sonuçları',
    });
  });

  it('creates enabled option metadata', () => {
    expect(createQueryResultOptionAria(true, 2, 5)).toEqual({
      role: 'option',
      'aria-selected': true,
      'aria-posinset': 2,
      'aria-setsize': 5,
    });
  });

  it('marks disabled option metadata explicitly', () => {
    expect(createQueryResultOptionAria(false, 1, 5, true)).toEqual({
      role: 'option',
      'aria-selected': false,
      'aria-disabled': true,
      'aria-posinset': 1,
      'aria-setsize': 5,
    });
  });
});

describe('QueryResultInteractionRuntime viewport behavior', () => {
  it('detects an item above the visible container', () => {
    expect(shouldScrollQueryResultIntoView(100, 400, 80, 130)).toBe(true);
    expect(getQueryResultScrollAlignment(100, 400, 80, 130)).toBe('start');
  });

  it('detects an item below the visible container', () => {
    expect(shouldScrollQueryResultIntoView(100, 400, 380, 430)).toBe(true);
    expect(getQueryResultScrollAlignment(100, 400, 380, 430)).toBe('end');
  });

  it('does not request scrolling for a fully visible item', () => {
    expect(shouldScrollQueryResultIntoView(100, 400, 150, 200)).toBe(false);
    expect(getQueryResultScrollAlignment(100, 400, 150, 200)).toBe('nearest');
  });

  it('provides touch-target utility contracts for compact and regular layouts', () => {
    expect(getQueryResultTouchTargetClassName(true)).toContain('min-h-11');
    expect(getQueryResultTouchTargetClassName(false)).toContain('min-h-12');
  });

  it('respects reduced-motion preference for focus scrolling', () => {
    expect(getQueryResultMotionBehavior(true)).toBe('auto');
    expect(getQueryResultMotionBehavior(false)).toBe('smooth');
  });
});
