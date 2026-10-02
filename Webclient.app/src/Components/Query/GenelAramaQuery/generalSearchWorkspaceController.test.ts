import { describe, expect, test, vi } from 'vitest';
import { normalizeSearchCollection } from '../_Common/QuerySearchRuntime';
import {
  createGeneralSearchWorkspaceController,
  type GeneralSearchWorkspaceController,
} from './generalSearchWorkspaceController';

const records = normalizeSearchCollection([
  {
    ObjectId: 1,
    Title: 'Gençlik Parkı',
    Address: 'Altındağ Ankara',
    Category: 'Park',
    Type: 'Kent Parkı',
  },
  {
    ObjectId: 2,
    Title: 'Seğmenler Parkı',
    Address: 'Çankaya Ankara',
    Category: 'Park',
    Type: 'Semt Parkı',
  },
  {
    ObjectId: 3,
    Title: 'Ankara Büyükşehir Belediyesi',
    Address: 'Yenimahalle Ankara',
    Category: 'Kamu',
    Type: 'Hizmet Binası',
  },
  {
    ObjectId: 4,
    Title: 'Zafer Çarşısı',
    Address: 'Kızılay Ankara',
    Category: 'Kültür',
    Type: 'Kültür Merkezi',
  },
  {
    ObjectId: 5,
    Title: 'Mavi Göl',
    Address: 'Mamak Ankara',
    Category: 'Park',
    Type: 'Rekreasyon Alanı',
  },
]);

const ready = (
  options: ConstructorParameters<typeof import('./generalSearchWorkspaceController').GeneralSearchWorkspaceController>[0] = {},
): GeneralSearchWorkspaceController => {
  const controller = createGeneralSearchWorkspaceController(options);
  controller.replaceRecords(records);
  return controller;
};

describe('GeneralSearchWorkspaceController lifecycle', () => {
  test('starts idle with no records', () => {
    const controller = createGeneralSearchWorkspaceController();
    const snapshot = controller.getSnapshot();
    expect(snapshot.workspace.phase).toBe('idle');
    expect(snapshot.workspace.totalCount).toBe(0);
    expect(snapshot.errorMessage).toBe('');
  });

  test('transitions to loading', () => {
    const controller = createGeneralSearchWorkspaceController();
    controller.beginLoading();
    const snapshot = controller.getSnapshot();
    expect(snapshot.workspace.phase).toBe('loading');
    expect(snapshot.announcement).toContain('yükleniyor');
  });

  test('can begin loading with local query', () => {
    const controller = createGeneralSearchWorkspaceController();
    controller.beginLoading('park');
    expect(controller.getSnapshot().workspace.filters.text).toBe('park');
  });

  test('transitions to ready after records arrive', () => {
    const controller = createGeneralSearchWorkspaceController();
    controller.beginLoading();
    controller.replaceRecords(records);
    const snapshot = controller.getSnapshot();
    expect(snapshot.workspace.phase).toBe('ready');
    expect(snapshot.workspace.totalCount).toBe(5);
  });

  test('transitions to empty for empty records', () => {
    const controller = createGeneralSearchWorkspaceController();
    controller.replaceRecords([]);
    expect(controller.getSnapshot().workspace.phase).toBe('empty');
  });

  test('transitions to error and retains bounded message', () => {
    const controller = createGeneralSearchWorkspaceController();
    controller.setError(new Error('Service unavailable'));
    expect(controller.getSnapshot().workspace.phase).toBe('error');
    expect(controller.getSnapshot().errorMessage).toBe('Service unavailable');
  });

  test('clears error back to ready when records exist', () => {
    const controller = ready();
    controller.setError('Temporary');
    controller.clearError();
    expect(controller.getSnapshot().workspace.phase).toBe('ready');
    expect(controller.getSnapshot().errorMessage).toBe('');
  });

  test('clears error back to empty without records', () => {
    const controller = createGeneralSearchWorkspaceController();
    controller.setError('Temporary');
    controller.clearError();
    expect(controller.getSnapshot().workspace.phase).toBe('empty');
  });

  test('reset clears records and UI state', () => {
    const controller = ready();
    controller.setText('park');
    controller.toggleFilterPanel();
    controller.reset();
    const snapshot = controller.getSnapshot();
    expect(snapshot.workspace.phase).toBe('idle');
    expect(snapshot.workspace.totalCount).toBe(0);
    expect(snapshot.workspace.filters.text).toBe('');
    expect(snapshot.filterPanelOpen).toBe(false);
  });
});

describe('GeneralSearchWorkspaceController subscriptions', () => {
  test('publishes once for state mutation', () => {
    const controller = ready();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.setText('park');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test('unsubscribe stops publication', () => {
    const controller = ready();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    unsubscribe();
    controller.setText('park');
    expect(listener).not.toHaveBeenCalled();
  });

  test('isolates subscriber failure from later listeners', () => {
    const controller = ready();
    const second = vi.fn();
    controller.subscribe(() => { throw new Error('listener'); });
    controller.subscribe(second);
    expect(() => controller.setText('park')).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('enforces listener budget', () => {
    const controller = createGeneralSearchWorkspaceController({ maximumListeners: 2 });
    controller.subscribe(() => undefined);
    controller.subscribe(() => undefined);
    expect(() => controller.subscribe(() => undefined)).toThrow(/listener limit/i);
  });

  test('dispose clears subscriptions and blocks new subscription', () => {
    const controller = ready();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.dispose();
    expect(() => controller.subscribe(() => undefined)).toThrow(/disposed/i);
  });

  test('dispose is idempotent', () => {
    const controller = ready();
    controller.dispose();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe('GeneralSearchWorkspaceController local refinement', () => {
  test('sets text and refines records', () => {
    const controller = ready();
    controller.setText('park');
    const snapshot = controller.getSnapshot();
    expect(snapshot.workspace.filters.text).toBe('park');
    expect(snapshot.workspace.matchedCount).toBe(2);
  });

  test('opens suggestions when non-empty text is set', () => {
    const controller = ready();
    controller.setText('park');
    expect(controller.getSnapshot().suggestionOpen).toBe(true);
  });

  test('does not keep suggestions open for blank text', () => {
    const controller = ready();
    controller.setText('');
    expect(controller.getSnapshot().suggestionOpen).toBe(false);
  });

  test('clearText restores all results', () => {
    const controller = ready();
    controller.setText('park');
    controller.clearText();
    const snapshot = controller.getSnapshot();
    expect(snapshot.workspace.filters.text).toBe('');
    expect(snapshot.workspace.matchedCount).toBe(5);
  });

  test('sets title sort', () => {
    const controller = ready();
    controller.setSort('title');
    const snapshot = controller.getSnapshot();
    expect(snapshot.workspace.filters.sort).toBe('title');
    expect(snapshot.workspace.page.items[0]?.record.title).toBe('Ankara Büyükşehir Belediyesi');
  });

  test('sets address sort', () => {
    const controller = ready();
    controller.setSort('address');
    expect(controller.getSnapshot().workspace.filters.sort).toBe('address');
  });

  test('category facet narrows records', () => {
    const controller = ready();
    controller.toggleCategory('Park');
    expect(controller.getSnapshot().workspace.matchedCount).toBe(3);
  });

  test('category facet toggles back off', () => {
    const controller = ready();
    controller.toggleCategory('Park');
    controller.toggleCategory('PARK');
    expect(controller.getSnapshot().workspace.matchedCount).toBe(5);
  });

  test('type facet narrows records', () => {
    const controller = ready();
    controller.toggleType('Kent Parkı');
    expect(controller.getSnapshot().workspace.matchedCount).toBe(1);
  });

  test('clearFilters removes text and facets', () => {
    const controller = ready();
    controller.setText('park');
    controller.toggleCategory('Park');
    controller.clearFilters();
    const filters = controller.getSnapshot().workspace.filters;
    expect(filters.text).toBe('');
    expect(filters.categories).toEqual([]);
    expect(filters.types).toEqual([]);
  });

  test('clearFilters can preserve text and sort', () => {
    const controller = ready();
    controller.setText('park');
    controller.setSort('title');
    controller.toggleCategory('Park');
    controller.clearFilters({ keepText: true, keepSort: true });
    const filters = controller.getSnapshot().workspace.filters;
    expect(filters.text).toBe('park');
    expect(filters.sort).toBe('title');
    expect(filters.categories).toEqual([]);
  });
});

describe('GeneralSearchWorkspaceController filter panel', () => {
  test('opens filter panel', () => {
    const controller = ready();
    controller.setFilterPanelOpen(true);
    expect(controller.getSnapshot().filterPanelOpen).toBe(true);
  });

  test('closes filter panel', () => {
    const controller = ready();
    controller.setFilterPanelOpen(true);
    controller.setFilterPanelOpen(false);
    expect(controller.getSnapshot().filterPanelOpen).toBe(false);
  });

  test('toggles filter panel', () => {
    const controller = ready();
    controller.toggleFilterPanel();
    expect(controller.getSnapshot().filterPanelOpen).toBe(true);
    controller.toggleFilterPanel();
    expect(controller.getSnapshot().filterPanelOpen).toBe(false);
  });

  test('opening filter panel closes suggestions', () => {
    const controller = ready();
    controller.setText('park');
    expect(controller.getSnapshot().suggestionOpen).toBe(true);
    controller.setFilterPanelOpen(true);
    expect(controller.getSnapshot().suggestionOpen).toBe(false);
  });
});

describe('GeneralSearchWorkspaceController result keyboard navigation', () => {
  test('moves active record down', () => {
    const controller = ready();
    controller.moveActive('ArrowDown');
    expect(controller.getSnapshot().workspace.activeIndex).toBe(1);
  });

  test('moves active record up', () => {
    const controller = ready();
    controller.moveActive('ArrowDown');
    controller.moveActive('ArrowUp');
    expect(controller.getSnapshot().workspace.activeIndex).toBe(0);
  });

  test('moves active record to end', () => {
    const controller = ready();
    controller.moveActive('End');
    expect(controller.getSnapshot().workspace.activeIndex).toBe(4);
  });

  test('moves active record home', () => {
    const controller = ready();
    controller.moveActive('End');
    controller.moveActive('Home');
    expect(controller.getSnapshot().workspace.activeIndex).toBe(0);
  });

  test('returns active record', () => {
    const controller = ready();
    controller.moveActive('ArrowDown');
    expect(controller.activeRecord()?.title).toBe('Seğmenler Parkı');
  });

  test('returns stable active result DOM id', () => {
    const controller = ready();
    expect(controller.activeRecordDomId()).toMatch(/^general-search-result-/);
  });

  test('returns null active record for empty projection', () => {
    const controller = createGeneralSearchWorkspaceController();
    controller.replaceRecords([]);
    expect(controller.activeRecord()).toBeNull();
    expect(controller.activeRecordDomId()).toBeNull();
  });
});

describe('GeneralSearchWorkspaceController pagination', () => {
  const many = normalizeSearchCollection(Array.from({ length: 35 }, (_, index) => ({
    ObjectId: index,
    Title: `Kayıt ${index}`,
    Category: 'Test',
  })));

  test('changes page and resets active item', () => {
    const controller = createGeneralSearchWorkspaceController({ pageSize: 10 });
    controller.replaceRecords(many);
    controller.moveActive('End');
    controller.setPage(2);
    const snapshot = controller.getSnapshot();
    expect(snapshot.workspace.page.page).toBe(2);
    expect(snapshot.workspace.activeIndex).toBe(0);
  });

  test('clamps requested page to page count', () => {
    const controller = createGeneralSearchWorkspaceController({ pageSize: 10 });
    controller.replaceRecords(many);
    controller.setPage(999);
    expect(controller.getSnapshot().workspace.page.page).toBe(4);
  });

  test('announces current page', () => {
    const controller = createGeneralSearchWorkspaceController({ pageSize: 10 });
    controller.replaceRecords(many);
    controller.setPage(2);
    expect(controller.getSnapshot().announcement).toContain('Sayfa 2 / 4');
  });

  test('local filter resets page one', () => {
    const controller = createGeneralSearchWorkspaceController({ pageSize: 10 });
    controller.replaceRecords(many);
    controller.setPage(3);
    controller.setText('Kayıt');
    expect(controller.getSnapshot().workspace.page.page).toBe(1);
  });
});

describe('GeneralSearchWorkspaceController suggestions', () => {
  test('opens suggestions after local query', () => {
    const controller = ready({ maximumSuggestions: 8 });
    controller.setText('park');
    expect(controller.getSnapshot().workspace.suggestions.length).toBeGreaterThan(0);
  });

  test('closes suggestions explicitly', () => {
    const controller = ready();
    controller.setText('park');
    controller.closeSuggestions();
    expect(controller.getSnapshot().suggestionOpen).toBe(false);
  });

  test('opens existing suggestions explicitly', () => {
    const controller = ready();
    controller.setText('park');
    controller.closeSuggestions();
    controller.openSuggestions();
    expect(controller.getSnapshot().suggestionOpen).toBe(true);
  });

  test('moves active suggestion', () => {
    const controller = ready({ maximumSuggestions: 8 });
    controller.setText('park');
    controller.moveSuggestion('next');
    expect(controller.getSnapshot().activeSuggestionIndex).toBe(1);
  });

  test('does not move active suggestion below zero', () => {
    const controller = ready();
    controller.setText('park');
    controller.moveSuggestion('previous');
    expect(controller.getSnapshot().activeSuggestionIndex).toBe(0);
  });

  test('moves active suggestion to last', () => {
    const controller = ready();
    controller.setText('park');
    controller.moveSuggestion('last');
    const snapshot = controller.getSnapshot();
    expect(snapshot.activeSuggestionIndex).toBe(snapshot.workspace.suggestions.length - 1);
  });

  test('moves active suggestion to first', () => {
    const controller = ready();
    controller.setText('park');
    controller.moveSuggestion('last');
    controller.moveSuggestion('first');
    expect(controller.getSnapshot().activeSuggestionIndex).toBe(0);
  });

  test('activeSuggestion returns selected suggestion', () => {
    const controller = ready();
    controller.setText('park');
    expect(controller.activeSuggestion()).not.toBeNull();
  });

  test('record suggestion returns record and closes popup', () => {
    const controller = ready({ maximumSuggestions: 8 });
    controller.setText('park');
    const suggestion = controller.getSnapshot().workspace.suggestions.find((item) => item.kind === 'record');
    expect(suggestion).toBeDefined();
    const record = suggestion ? controller.applySuggestion(suggestion) : null;
    expect(record?.title).toContain('Park');
    expect(controller.getSnapshot().suggestionOpen).toBe(false);
  });

  test('category suggestion applies category facet', () => {
    const controller = ready({ maximumSuggestions: 12 });
    controller.setText('park');
    const suggestion = controller.getSnapshot().workspace.suggestions.find((item) => item.kind === 'category');
    expect(suggestion).toBeDefined();
    if (suggestion) controller.applySuggestion(suggestion);
    expect(controller.getSnapshot().workspace.filters.categories.length).toBe(1);
  });

  test('applyActiveSuggestion is safe with no suggestions', () => {
    const controller = ready();
    expect(controller.applyActiveSuggestion()).toBeNull();
  });
});

describe('GeneralSearchWorkspaceController announcements and revisions', () => {
  test('increments revision after mutations', () => {
    const controller = ready();
    const before = controller.getSnapshot().revision;
    controller.setText('park');
    expect(controller.getSnapshot().revision).toBeGreaterThan(before);
  });

  test('announces category update', () => {
    const controller = ready();
    controller.toggleCategory('Park');
    expect(controller.getSnapshot().announcement).toContain('Kategori');
  });

  test('announces type update', () => {
    const controller = ready();
    controller.toggleType('Kent Parkı');
    expect(controller.getSnapshot().announcement).toContain('Tür');
  });

  test('announces sort update', () => {
    const controller = ready();
    controller.setSort('title');
    expect(controller.getSnapshot().announcement).toContain('sıralaması');
  });

  test('announces filters cleared', () => {
    const controller = ready();
    controller.toggleCategory('Park');
    controller.clearFilters();
    expect(controller.getSnapshot().announcement).toContain('temizlendi');
  });

  test('announces no matches', () => {
    const controller = ready();
    controller.setText('not-found-xyz');
    expect(controller.getSnapshot().workspace.matchedCount).toBe(0);
  });
});
