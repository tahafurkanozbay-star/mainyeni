import { describe, expect, it } from 'vitest';
import type { SearchRequest } from './contracts';
import { createSearchWorkspaceRuntimeV10 } from './searchWorkspaceRuntimeV10';
import { createWorkspaceExperienceV10, createWorkspaceRuntimeV10 } from './searchWorkspaceV10.testFixtures';

describe('SearchWorkspaceRuntimeV10 orchestration', () => {
  it('runs a user search once through v9 and composes v10 facts', () => {
    const { experience, workspace } = createWorkspaceRuntimeV10();
    const before = experience.snapshot().searches;
    const page = workspace.search('ankara', { query: 'park' });
    expect(experience.snapshot().searches).toBe(before + 1);
    expect(workspace.snapshot().searches).toBe(1);
    expect(page.handoff.results.length).toBeGreaterThan(0);
  });

  it('adopts a precomputed v9 model without executing the search again', () => {
    const experience = createWorkspaceExperienceV10();
    const workspace = createSearchWorkspaceRuntimeV10(experience);
    const model = experience.search('ankara', { query: 'park' });
    const searches = experience.snapshot().searches;
    const page = workspace.adoptExperienceModel(model, { query: 'park' });
    expect(experience.snapshot().searches).toBe(searches);
    expect(workspace.snapshot().adoptedModels).toBe(1);
    expect(page.experience.fingerprint).toBe(model.fingerprint);
  });

  it('turns next-page action into a new request and then a new workspace page', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: '', limit: 2 });
    const next = page.handoff.actions.find(action => action.kind === 'next-page');
    expect(next).toBeTruthy();
    const result = workspace.runAction('ankara', page.request, next!);
    expect(result.outcome.kind).toBe('request-updated');
    expect(result.outcome.shouldSearch).toBe(true);
    expect(result.outcome.request.offset).toBe(2);
    expect(result.page?.handoff.pagination.currentPage).toBe(2);
  });

  it('updates selection without executing another search', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const searchesBefore = workspace.snapshot().searches;
    const select = page.handoff.actions.find(action => action.kind === 'select-result');
    expect(select).toBeTruthy();
    const result = workspace.runAction('ankara', page.request, select!);
    expect(result.outcome.kind).toBe('state-updated');
    expect(result.outcome.shouldSearch).toBe(false);
    expect(result.page?.state.selectedResultKeys).toContain(select?.resultKey);
    expect(workspace.snapshot().searches).toBe(searchesBefore);
  });

  it('returns map handoff data without running GIS navigation', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const show = page.handoff.actions.find(action => action.kind === 'show-result-on-map');
    const result = workspace.runAction('ankara', page.request, show!);
    expect(result.outcome.kind).toBe('handoff-ready');
    expect(result.outcome.resultHandoff?.hasCoordinates).toBe(true);
    expect(workspace.mapHandoff()?.key).toBe(show?.resultKey);
    expect(workspace.snapshot().mapHandoffs).toBe(1);
  });

  it('returns detail handoff data without creating a second details datastore', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'hastane' });
    const open = page.handoff.actions.find(action => action.kind === 'open-details');
    const result = workspace.runAction('ankara', page.request, open!);
    expect(result.outcome.resultHandoff?.recordFingerprint).toBeTruthy();
    expect(workspace.detailHandoff()?.key).toBe(open?.resultKey);
    expect(workspace.snapshot().detailHandoffs).toBe(1);
  });

  it('applies guidance action immutably and schedules a fresh query', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const request = {
      query: 'olmayan iki kelime',
      filters: [{ field: 'category', operator: 'eq', values: ['Olmayan'] }],
      district: 'Olmayan',
    } satisfies SearchRequest;
    const page = workspace.search('ankara', request);
    const clear = page.handoff.actions.find(action => action.kind === 'clear-filters');
    const outcome = workspace.executeAction(request, clear!);
    expect(outcome.shouldSearch).toBe(true);
    expect(outcome.request.filters).toEqual([]);
    expect(outcome.request.query).toBe(request.query);
    expect(request.filters).toHaveLength(1);
  });

  it('preserves explicit user request object contents', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const request: SearchRequest = {
      query: 'park',
      filters: [{ field: 'district', operator: 'eq', values: ['Çankaya'] }],
      facetFields: ['category'],
      limit: 2,
    };
    const copy = JSON.parse(JSON.stringify(request)) as SearchRequest;
    workspace.search('ankara', request);
    expect(request).toEqual(copy);
  });

  it('bounds action and model history separately', () => {
    const experience = createWorkspaceExperienceV10();
    const workspace = createSearchWorkspaceRuntimeV10(experience, { maxActionHistory: 2, maxModelHistory: 2 });
    for (const query of ['park', 'hastane', 'kültür']) workspace.search('ankara', { query });
    const current = workspace.current()!;
    const select = current.handoff.actions.find(action => action.kind === 'select-result');
    if (select) {
      workspace.executeAction(current.request, select);
      workspace.executeAction(current.request, select);
      workspace.executeAction(current.request, select);
    }
    expect(workspace.modelHistory()).toHaveLength(2);
    expect(workspace.actionHistory().length).toBeLessThanOrEqual(2);
  });

  it('reset removes transient workspace state but does not mutate v9 search authority', () => {
    const { experience, workspace } = createWorkspaceRuntimeV10();
    workspace.search('ankara', { query: 'park' });
    const v9Before = experience.snapshot();
    workspace.reset();
    expect(workspace.current()).toBeNull();
    expect(workspace.snapshot().state.datasetKey).toBeNull();
    expect(experience.snapshot().searches).toBe(v9Before.searches);
  });
});
