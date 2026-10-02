import { describe, expect, it } from 'vitest';
import type { DatasetSnapshot, SearchRequest } from './contracts';
import { createDataSearchRuntime } from './searchRuntime';
import { createSearchRecoveryRuntimeV8 } from './searchRecoveryRuntimeV8';
import {
  SearchExperienceRuntimeV9,
  createSearchExperienceRuntimeV9,
} from './searchExperienceRuntimeV9';
import { createSearchExperienceSessionV9 } from './searchExperienceSessionV9';

const baseRows = () => [
  {
    id: 'hospital-cankaya',
    name: 'Çankaya Devlet Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    address: 'Atatürk Bulvarı No 10 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9208,
    lon: 32.8541,
  },
  {
    id: 'hospital-altindag',
    name: 'Altındağ Şehir Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    address: 'Anafartalar Caddesi No 28 Altındağ Ankara',
    postalCode: '06050',
    lat: 39.9421,
    lon: 32.856,
  },
  {
    id: 'park-kizilay',
    name: 'Atatürk Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Karanfil Sokak',
    address: 'Karanfil Sokak No 3 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9198,
    lon: 32.8529,
  },
  {
    id: 'park-seymenler',
    name: 'Seğmenler Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Çankaya',
    street: 'İran Caddesi',
    address: 'İran Caddesi Çankaya Ankara',
    postalCode: '06680',
    lat: 39.9026,
    lon: 32.8604,
  },
  {
    id: 'municipality-cankaya',
    name: 'Çankaya Belediyesi',
    category: 'Kamu',
    type: 'Belediye',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Ziya Gökalp Caddesi',
    address: 'Ziya Gökalp Caddesi No 7 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9212,
    lon: 32.8537,
  },
  {
    id: 'culture-ulus',
    name: 'Ulus Kültür Merkezi',
    category: 'Kültür',
    type: 'Kültür Merkezi',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    address: 'Anafartalar Caddesi No 15 Altındağ Ankara',
    postalCode: '06050',
    lat: 39.941,
    lon: 32.855,
  },
] as const;

const dataset = (key = 'ankara'): DatasetSnapshot =>
  createDataSearchRuntime().register(key, baseRows());

const createRecovery = (blockedWindow = false) => {
  const recovery = createSearchRecoveryRuntimeV8({
    correction: {
      minimumAutoApplyScore: 100,
      minimumAutoApplyMargin: 5,
      maximumAutoEditDistance: 2,
    },
    registry: blockedWindow
      ? { execution: { maximumResultWindow: 100 } }
      : {},
  });
  recovery.register(dataset());
  return recovery;
};

const createExperience = (blockedWindow = false) => createSearchExperienceRuntimeV9(
  createRecovery(blockedWindow),
  {
    defaultGrouping: 'category',
    history: { maxEntries: 16, maxSuggestions: 8 },
    selection: { pageStep: 2 },
  },
);

describe('SearchExperienceRuntimeV9 page model', () => {
  it('builds one immutable UI model from the canonical v8 result', () => {
    const experience = createExperience();
    const model = experience.search('ankara', { query: 'park' });
    expect(model.version).toBe('search-experience-v9');
    expect(model.datasetKey).toBe('ankara');
    expect(model.cards.length).toBeGreaterThan(0);
    expect(model.cards.length).toBe(model.recovery.response.results.length);
    expect(model.grouping.mode).toBe('category');
    expect(model.guidance.status).not.toBe('blocked');
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.cards)).toBe(true);
  });

  it('keeps search truth and page cards aligned by record fingerprint', () => {
    const model = createExperience().search('ankara', { query: 'hastane' });
    expect(model.cards.map(card => card.recordFingerprint))
      .toEqual(model.recovery.response.results.map(hit => hit.record.fingerprint));
  });

  it('preserves ranking order inside the page model', () => {
    const model = createExperience().search('ankara', { query: 'çankaya' });
    const sourceOrder = model.recovery.response.results.map(hit => hit.record.fingerprint);
    expect(model.cards.map(card => card.recordFingerprint)).toEqual(sourceOrder);
  });

  it('exposes pagination facts without creating an alternate cursor authority', () => {
    const model = createExperience().search('ankara', { query: '', limit: 2 });
    expect(model.pagination.limit).toBe(2);
    expect(model.pagination.count).toBe(2);
    expect(model.pagination.total).toBeGreaterThanOrEqual(2);
    expect(model.pagination.hasPrevious).toBe(false);
    if (model.pagination.total > 2) {
      expect(model.pagination.hasNext).toBe(true);
      expect(model.pagination.nextOffset).toBe(2);
    }
  });

  it('exposes bounded facet models from canonical response facets', () => {
    const model = createExperience().search('ankara', {
      query: '',
      facetFields: ['category', 'district'],
    });
    expect(model.facets.map(facet => facet.field)).toEqual(['category', 'district']);
    expect(model.facets.every(facet => facet.buckets.length > 0)).toBe(true);
  });

  it('supports per-search grouping without changing the runtime default', () => {
    const experience = createExperience();
    const district = experience.search('ankara', { query: '' }, { grouping: 'district' });
    const category = experience.search('ankara', { query: '' });
    expect(district.grouping.mode).toBe('district');
    expect(category.grouping.mode).toBe('category');
  });

  it('updates selection from the visible result identities', () => {
    const experience = createExperience();
    const model = experience.search('ankara', { query: '' });
    expect(model.selection.resultCount).toBe(model.cards.length);
    expect(model.selection.activeKey).toBe(model.cards[0]?.key);
    experience.next();
    expect(experience.snapshot().selection.activeIndex).toBe(Math.min(1, model.cards.length - 1));
  });

  it('supports selection handoff without owning map navigation', () => {
    const experience = createExperience();
    const model = experience.search('ankara', { query: 'park' });
    const selected = experience.select(model.cards[0]?.key);
    expect(selected.selectedKeys).toContain(model.cards[0]?.key);
    const card = model.cards.find(item => item.key === selected.selectedKeys[0]);
    expect(card?.hasCoordinates).toBe(true);
    expect('navigate' in experience).toBe(false);
  });

  it('records only query history facts and returns recent suggestions', () => {
    const experience = createExperience();
    experience.search('ankara', { query: 'park' });
    experience.search('ankara', { query: 'hastane' });
    experience.search('ankara', { query: 'park' });
    const suggestions = experience.historySuggestions('ankara', 'pa');
    expect(suggestions[0]?.query).toBe('park');
    expect(suggestions[0]?.uses).toBeGreaterThanOrEqual(2);
  });

  it('can disable history recording for non-user or diagnostic searches', () => {
    const experience = createExperience();
    experience.search('ankara', { query: 'park' }, { recordHistory: false });
    expect(experience.snapshot().history.entries).toBe(0);
  });

  it('can keep existing selection when building a background model', () => {
    const experience = createExperience();
    const first = experience.search('ankara', { query: '' });
    experience.select(first.cards[1]?.key);
    const selectedBefore = experience.snapshot().selection.selectedKeys;
    experience.search('ankara', { query: 'park' }, { updateSelection: false });
    expect(experience.snapshot().selection.selectedKeys).toEqual(selectedBefore);
  });
});

describe('SearchExperienceRuntimeV9 recovery and guidance', () => {
  it('turns v8 typo recovery into explicit page guidance', () => {
    const model = createExperience().search('ankara', { query: 'hastne' });
    expect(model.recovered).toBe(true);
    expect(model.guidance.status).toBe('recovered');
    expect(model.guidance.executedQuery).toContain('hastane');
    expect(model.cards[0]?.explanation.recovered).toBe(true);
  });

  it('does not mutate the user request when recovery uses another query', () => {
    const request = { query: 'hastne' } satisfies SearchRequest;
    const model = createExperience().search('ankara', request);
    expect(request.query).toBe('hastne');
    expect(model.request.query).toBe('hastne');
    expect(model.recovery.diagnostics.executedQuery).not.toBe(request.query);
  });

  it('builds empty-state guidance for unmatched terms', () => {
    const model = createExperience().search('ankara', { query: 'kesinlikleolmayanbenzersizsorgu' });
    expect(model.resultCount).toBe(0);
    expect(model.guidance.status).toBe('empty');
    expect(model.guidance.actions.some(action => action.kind === 'show-all-results')).toBe(true);
  });

  it('keeps blocked execution blocked in the page model', () => {
    const model = createExperience(true).search('ankara', { query: 'park', offset: 100 });
    expect(model.blocked).toBe(true);
    expect(model.resultCount).toBe(0);
    expect(model.guidance.status).toBe('blocked');
    expect(model.guidance.severity).toBe('error');
  });

  it('applies an explicit guidance action as a new immutable request', () => {
    const experience = createExperience();
    const request = {
      query: 'olmayan iki kelime',
      filters: [{ field: 'category', operator: 'eq', values: ['Olmayan'] }],
      district: 'Olmayan',
    } satisfies SearchRequest;
    const model = experience.search('ankara', request);
    const action = model.guidance.actions.find(item => item.kind === 'clear-filters');
    expect(action).toBeTruthy();
    const next = experience.applyAction(request, action!);
    expect(next.filters).toEqual([]);
    expect(next.query).toBe(request.query);
    expect(request.filters).toHaveLength(1);
  });
});

describe('SearchExperienceRuntimeV9 address and spatial usability', () => {
  it('builds address explanations from the canonical address scorer', () => {
    const model = createExperience().search('ankara', {
      query: 'Atatürk Bulvarı 10 Çankaya',
    });
    expect(model.cards.length).toBeGreaterThan(0);
    expect(model.cards.some(card => card.explanation.details.some(detail => detail.includes('Adres')))).toBe(true);
  });

  it('provides distance grouping for location-constrained results', () => {
    const model = createExperience().search('ankara', {
      query: '',
      center: [32.8541, 39.9208],
      radiusMeters: 50_000,
      sort: 'distance',
    }, { grouping: 'distance' });
    expect(model.cards.length).toBeGreaterThan(0);
    expect(model.grouping.mode).toBe('distance');
    expect(model.cards[0]?.distanceMeters).not.toBeNull();
  });

  it('does not expose a network operation in the page model', () => {
    const model = createExperience().search('ankara', { query: 'park' });
    expect('fetch' in model).toBe(false);
    expect('endpoint' in model).toBe(false);
    expect('provider' in model).toBe(false);
  });
});

describe('SearchExperienceRuntimeV9 snapshots', () => {
  it('aggregates diagnostics from all v9 authorities', () => {
    const experience = createExperience();
    experience.search('ankara', { query: 'park' });
    const snapshot = experience.snapshot();
    expect(snapshot.searches).toBe(1);
    expect(snapshot.modelsBuilt).toBe(1);
    expect(snapshot.presentation.cardsBuilt).toBeGreaterThan(0);
    expect(snapshot.grouping.executions).toBe(1);
    expect(snapshot.guidance.evaluations).toBe(1);
    expect(snapshot.selection.resultCount).toBeGreaterThan(0);
    expect(snapshot.history.entries).toBe(1);
    expect(snapshot.fingerprint).toBeTruthy();
  });

  it('counts recovered blocked and empty models separately', () => {
    const experience = createExperience();
    experience.search('ankara', { query: 'hastne' });
    experience.search('ankara', { query: 'kesinlikleolmayanbenzersizsorgu' });
    const snapshot = experience.snapshot();
    expect(snapshot.recoveredModels).toBeGreaterThanOrEqual(1);
    expect(snapshot.emptyModels).toBeGreaterThanOrEqual(1);
  });

  it('does not retain raw result records in top-level diagnostics', () => {
    const experience = createExperience();
    experience.search('ankara', { query: 'park' });
    const snapshot = experience.snapshot();
    expect('records' in snapshot).toBe(false);
    expect('results' in snapshot).toBe(false);
  });
});

describe('SearchExperienceSessionV9 debounce and cancellation reuse', () => {
  it('maps immediate canonical session execution back to one v9 model', async () => {
    const experience = createExperience();
    const session = createSearchExperienceSessionV9(experience, { debounceMs: 0 });
    const envelope = await session.searchNow('ankara', { query: 'park' });
    expect(envelope.model.cards.length).toBeGreaterThan(0);
    expect(envelope.model.request.query).toBe('park');
    expect(envelope.stale).toBe(false);
    expect(session.snapshot().completedModels).toBe(1);
    expect(session.snapshot().missingModels).toBe(0);
    session.dispose();
  });

  it('uses the canonical SearchSession debounce path rather than a second timer authority', async () => {
    const experience = createExperience();
    const session = createSearchExperienceSessionV9(experience, { debounceMs: 1 });
    const envelope = await session.schedule('ankara', { query: 'hastane' });
    expect(envelope.model.resultCount).toBeGreaterThan(0);
    expect(session.state().status).toBe('success');
    expect(session.history()).toHaveLength(1);
    session.dispose();
  });

  it('supports external abort for scheduled searches', async () => {
    const experience = createExperience();
    const session = createSearchExperienceSessionV9(experience, { debounceMs: 50 });
    const controller = new AbortController();
    const pending = session.schedule('ankara', { query: 'park' }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.state().status).toBe('cancelled');
    session.dispose();
  });

  it('loads subsequent pages through the existing SearchSession page contract', async () => {
    const experience = createExperience();
    const session = createSearchExperienceSessionV9(experience, { debounceMs: 0 });
    const first = await session.searchNow('ankara', { query: '', limit: 2 });
    if (first.model.pagination.hasNext) {
      const second = await session.loadMore();
      expect(second.model.pagination.offset).toBe(first.model.pagination.nextOffset);
      expect(second.model.cards.map(card => card.key)).not.toEqual(first.model.cards.map(card => card.key));
    }
    session.dispose();
  });

  it('bounds pending model retention', async () => {
    const experience = createExperience();
    const session = createSearchExperienceSessionV9(experience, {
      debounceMs: 0,
      maxPendingModels: 2,
    });
    await session.searchNow('ankara', { query: 'park' });
    await session.searchNow('ankara', { query: 'hastane' });
    await session.searchNow('ankara', { query: 'belediye' });
    expect(session.snapshot().pendingModels).toBe(0);
    expect(session.snapshot().completedModels).toBe(3);
    session.dispose();
  });

  it('rejects use after disposal', async () => {
    const session = createSearchExperienceSessionV9(createExperience(), { debounceMs: 0 });
    session.dispose();
    await expect(session.searchNow('ankara', { query: 'park' })).rejects.toThrow(/disposed/);
  });
});

describe('SearchExperienceRuntimeV9 scale boundaries', () => {
  const scaleDataset = (count: number): DatasetSnapshot => {
    const rows = Array.from({ length: count }, (_value, index) => ({
      id: `place-${index}`,
      name: `Ankara Hizmet Noktası ${index}`,
      category: index % 3 === 0 ? 'Sağlık' : index % 3 === 1 ? 'Park' : 'Kamu',
      type: index % 2 === 0 ? 'Merkez' : 'Birim',
      district: index % 2 === 0 ? 'Çankaya' : 'Altındağ',
      neighborhood: `Mahalle ${index % 20}`,
      street: `Sokak ${index % 50}`,
      address: `Sokak ${index % 50} No ${index + 1} Ankara`,
      lat: 39.9 + (index % 50) * 0.0001,
      lon: 32.8 + (index % 50) * 0.0001,
    }));
    return createDataSearchRuntime({ maxLimit: 1_000 }).register('scale', rows);
  };

  it('bounds visible cards groups facets and selection state on a larger dataset', () => {
    const recovery = createSearchRecoveryRuntimeV8();
    recovery.register(scaleDataset(600));
    const experience = new SearchExperienceRuntimeV9(recovery, {
      presentation: { maxCards: 120 },
      grouping: { maxGroups: 8, maxCardsPerGroup: 30, maxCards: 120 },
      selection: { maxResults: 120, maxSelected: 10, multiSelect: true },
      maxFacetFields: 3,
      maxFacetBucketsPerField: 10,
      defaultGrouping: 'district',
    });
    const model = experience.search('scale', {
      query: 'ankara',
      limit: 250,
      facetFields: ['category', 'district', 'type'],
    });
    expect(model.cards.length).toBeLessThanOrEqual(120);
    expect(model.grouping.groups.length).toBeLessThanOrEqual(8);
    expect(model.grouping.groups.every(group => group.cards.length <= 30)).toBe(true);
    expect(model.facets.length).toBeLessThanOrEqual(3);
    expect(model.facets.every(facet => facet.buckets.length <= 10)).toBe(true);
    expect(model.selection.resultCount).toBeLessThanOrEqual(120);
  });

  it('keeps model and diagnostic collections immutable at scale', () => {
    const recovery = createSearchRecoveryRuntimeV8();
    recovery.register(scaleDataset(300));
    const experience = new SearchExperienceRuntimeV9(recovery, {
      presentation: { maxCards: 80 },
      defaultGrouping: 'category',
    });
    const model = experience.search('scale', { query: 'hizmet', limit: 100 });
    expect(Object.isFrozen(model.cards)).toBe(true);
    expect(Object.isFrozen(model.grouping.groups)).toBe(true);
    expect(Object.isFrozen(model.guidance.actions)).toBe(true);
    expect(Object.isFrozen(model.selection.selectedKeys)).toBe(true);
  });
});
