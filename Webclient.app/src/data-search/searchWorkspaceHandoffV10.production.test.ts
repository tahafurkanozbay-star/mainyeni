import { describe, expect, it } from 'vitest';
import type { SearchRequest } from './contracts';
import { createWorkspaceRuntimeV10 } from './searchWorkspaceV10.testFixtures';

describe('Search workspace v10 handoff', () => {
  it('builds one bounded immutable page handoff from canonical v9 search', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', {
      query: 'park',
      facetFields: ['category', 'district'],
      limit: 4,
    });
    expect(page.version).toBe('search-workspace-runtime-v10');
    expect(page.handoff.version).toBe('search-workspace-handoff-v10');
    expect(page.handoff.dataset.key).toBe('ankara');
    expect(page.handoff.results.length).toBeGreaterThan(0);
    expect(page.handoff.results.length).toBe(page.experience.cards.length);
    expect(page.handoff.facets.map(facet => facet.field)).toEqual(['category', 'district']);
    expect(Object.isFrozen(page.handoff)).toBe(true);
    expect(Object.isFrozen(page.handoff.results)).toBe(true);
    expect(Object.isFrozen(page.accessibility)).toBe(true);
  });

  it('preserves dataset revision and result identity facts for downstream surfaces', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'hastane' });
    const card = page.experience.cards[0]!;
    const result = page.handoff.results[0]!;
    expect(page.handoff.dataset.revision).toBe(page.experience.datasetRevision);
    expect(page.handoff.dataset.fingerprint).toBe(page.experience.datasetFingerprint);
    expect(result.key).toBe(card.key);
    expect(result.recordFingerprint).toBe(card.recordFingerprint);
    expect(result.sourceIndex).toBe(card.sourceIndex);
    expect(result.fingerprint).toBeTruthy();
  });

  it('exposes map intents only for results with verified coordinates', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const mappable = page.handoff.results.filter(result => result.hasCoordinates);
    expect(mappable.length).toBeGreaterThan(0);
    for (const result of mappable) {
      expect(result.canShowOnMap).toBe(true);
      expect(page.handoff.actions.some(action => action.kind === 'show-result-on-map' && action.resultKey === result.key)).toBe(true);
    }
    expect('navigate' in page.handoff).toBe(false);
    expect('mapView' in page.handoff).toBe(false);
    expect('endpoint' in page.handoff).toBe(false);
  });

  it('exposes detail intents without retaining raw source records in the top-level handoff', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'kütüphane' });
    expect(page.handoff.hasDetails).toBe(true);
    expect(page.handoff.actions.some(action => action.kind === 'open-details')).toBe(true);
    expect('records' in page.handoff).toBe(false);
    expect('source' in page.handoff).toBe(false);
  });

  it('turns pagination facts into explicit previous next and first-page actions', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const first = workspace.search('ankara', { query: '', limit: 2 });
    expect(first.handoff.pagination.currentPage).toBe(1);
    expect(first.handoff.pagination.pageCount).toBeGreaterThanOrEqual(1);
    if (first.handoff.pagination.hasNext) {
      const next = first.handoff.actions.find(action => action.kind === 'next-page');
      expect(next?.offset).toBe(2);
      const outcome = workspace.runAction('ankara', first.request, next!);
      expect(outcome.outcome.shouldSearch).toBe(true);
      expect(outcome.page?.handoff.pagination.currentPage).toBe(2);
      expect(outcome.page?.handoff.actions.some(action => action.kind === 'previous-page')).toBe(true);
      expect(outcome.page?.handoff.actions.some(action => action.kind === 'first-page')).toBe(true);
    }
  });

  it('converts v9 empty guidance into request-changing recovery actions', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const request = {
      query: 'kesinlikleolmayanbenzersizsorgu',
      filters: [{ field: 'category', operator: 'eq', values: ['Olmayan'] }],
      district: 'Olmayan',
    } satisfies SearchRequest;
    const page = workspace.search('ankara', request);
    expect(page.handoff.status.status).toBe('empty');
    const clearFilters = page.handoff.actions.find(action => action.kind === 'clear-filters');
    expect(clearFilters).toBeTruthy();
    const outcome = workspace.executeAction(request, clearFilters!);
    expect(outcome.shouldSearch).toBe(true);
    expect(outcome.request.filters).toEqual([]);
    expect(request.filters).toHaveLength(1);
  });

  it('keeps blocked execution blocked and presents assertive accessibility status', () => {
    const { workspace } = createWorkspaceRuntimeV10({ blockedWindow: true });
    const page = workspace.search('ankara', { query: 'park', offset: 100 });
    expect(page.handoff.status.status).toBe('blocked');
    expect(page.handoff.results).toHaveLength(0);
    expect(page.accessibility.statusRole).toBe('alert');
    expect(page.accessibility.announcements.some(item => item.priority === 'assertive')).toBe(true);
    expect(page.handoff.preferredSurface).toBe('guidance');
  });

  it('keeps recovered query facts visible without mutating the user request', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const request = { query: 'hastne' } satisfies SearchRequest;
    const page = workspace.search('ankara', request);
    expect(page.handoff.status.recovered).toBe(true);
    expect(page.handoff.status.status).toBe('recovered');
    expect(request.query).toBe('hastne');
    expect(page.request.query).toBe('hastne');
    expect(page.accessibility.announcements.some(item => item.text.includes('kurtarma'))).toBe(true);
  });

  it('bounds result and action surfaces by policy', () => {
    const { experience } = createWorkspaceRuntimeV10();
    const { createSearchWorkspaceRuntimeV10 } = require('./searchWorkspaceRuntimeV10') as typeof import('./searchWorkspaceRuntimeV10');
    const bounded = createSearchWorkspaceRuntimeV10(experience, {
      handoff: { maxResults: 2, maxActions: 4, maxFacets: 1, maxFacetBuckets: 1 },
      accessibility: { maxResultFacts: 2, maxActionFacts: 4 },
    });
    const page = bounded.search('ankara', { query: '', facetFields: ['category', 'district'] });
    expect(page.handoff.results.length).toBeLessThanOrEqual(2);
    expect(page.handoff.actions.length).toBeLessThanOrEqual(4);
    expect(page.handoff.facets.length).toBeLessThanOrEqual(1);
    expect(page.accessibility.results.length).toBeLessThanOrEqual(2);
    expect(page.accessibility.actions.length).toBeLessThanOrEqual(4);
  });

  it('does not expose network or GIS execution authority', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const serialized = JSON.stringify(page.handoff);
    expect(serialized).not.toContain('http://');
    expect(serialized).not.toContain('https://');
    expect('fetch' in workspace).toBe(false);
    expect('navigate' in workspace).toBe(false);
    expect('goTo' in workspace).toBe(false);
  });
});
