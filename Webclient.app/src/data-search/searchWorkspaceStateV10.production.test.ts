import { describe, expect, it } from 'vitest';
import { createWorkspaceRuntimeV10 } from './searchWorkspaceV10.testFixtures';
import { createSearchWorkspaceStateRuntimeV10 } from './searchWorkspaceStateRuntimeV10';

describe('SearchWorkspaceStateRuntimeV10', () => {
  it('adopts canonical selection and active result from a handoff model', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    expect(page.state.datasetKey).toBe('ankara');
    expect(page.state.datasetRevision).toBe(page.handoff.dataset.revision);
    expect(page.state.activeResultKey).toBe(page.handoff.activeResultKey);
    expect(page.state.resultCount).toBe(page.handoff.results.length);
  });

  it('opens details as state only and returns a revision-bound handoff', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const action = page.handoff.actions.find(item => item.kind === 'open-details');
    expect(action).toBeTruthy();
    const outcome = workspace.executeAction(page.request, action!);
    expect(outcome.kind).toBe('handoff-ready');
    expect(outcome.accepted).toBe(true);
    expect(outcome.resultHandoff?.datasetKey).toBe('ankara');
    expect(outcome.resultHandoff?.datasetRevision).toBe(page.handoff.dataset.revision);
    expect(outcome.resultHandoff?.modelFingerprint).toBe(page.handoff.fingerprint);
    expect(outcome.shouldSearch).toBe(false);
  });

  it('requests map focus only for coordinate-bearing results', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const action = page.handoff.actions.find(item => item.kind === 'show-result-on-map');
    expect(action).toBeTruthy();
    const outcome = workspace.executeAction(page.request, action!);
    expect(outcome.kind).toBe('handoff-ready');
    expect(outcome.resultHandoff?.hasCoordinates).toBe(true);
    expect(outcome.resultHandoff?.latitude).not.toBeNull();
    expect(outcome.resultHandoff?.longitude).not.toBeNull();
    expect(workspace.mapHandoff()?.key).toBe(action?.resultKey);
  });

  it('keeps multi-selection bounded and deterministic', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: '' });
    const state = createSearchWorkspaceStateRuntimeV10({ maxSelected: 2 });
    state.replaceModel(page.handoff);
    const keys = page.handoff.results.slice(0, 3).map(result => result.key);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(state.select(keys[0]).selectedResultKeys).toEqual([keys[0]]);
    expect(state.select(keys[1]).selectedResultKeys).toEqual([keys[0], keys[1]]);
    const refused = state.select(keys[2]);
    expect(refused.selectedResultKeys).toEqual([keys[0], keys[1]]);
    expect(refused.selectionLimitDrops).toBe(1);
  });

  it('drops stale selection, detail and map identities when result set changes', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const all = workspace.search('ankara', { query: '' });
    const state = createSearchWorkspaceStateRuntimeV10();
    state.replaceModel(all.handoff);
    const target = all.handoff.results.find(result => result.category === 'Park')!;
    state.select(target.key);
    state.openDetails(target.key);
    state.requestMapFocus(target.key);

    const hospitals = workspace.search('ankara', { query: 'hastane' });
    const next = state.replaceModel(hospitals.handoff);
    expect(next.selectedResultKeys).not.toContain(target.key);
    expect(next.detailResultKey).toBeNull();
    expect(next.mapResultKey).toBeNull();
    expect(next.staleSelectionDrops).toBeGreaterThanOrEqual(1);
    expect(next.staleDetailDrops).toBeGreaterThanOrEqual(1);
    expect(next.staleMapDrops).toBeGreaterThanOrEqual(1);
  });

  it('preserves selection when only an equivalent model refresh occurs', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const first = workspace.search('ankara', { query: 'park' });
    const state = createSearchWorkspaceStateRuntimeV10();
    state.replaceModel(first.handoff);
    const selected = first.handoff.results[0]!.key;
    state.select(selected);
    const equivalent = workspace.search('ankara', { query: 'park' });
    const snapshot = state.replaceModel(equivalent.handoff);
    expect(snapshot.datasetRevision).toBe(first.handoff.dataset.revision);
    expect(snapshot.datasetFingerprint).toBe(first.handoff.dataset.fingerprint);
    expect(snapshot.selectedResultKeys).toContain(selected);
  });

  it('rejects unknown result identities without inventing handoff data', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const state = createSearchWorkspaceStateRuntimeV10();
    state.replaceModel(page.handoff);
    const before = state.snapshot();
    const after = state.openDetails('does-not-exist');
    expect(after.detailResultKey).toBeNull();
    expect(state.resultHandoff('does-not-exist')).toBeNull();
    expect(after.transitionSequence).toBe(before.transitionSequence + 1);
  });

  it('prevents map surface focus when the model has no mappable results', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'definitely-no-result-value' });
    const state = createSearchWorkspaceStateRuntimeV10();
    state.replaceModel(page.handoff);
    const snapshot = state.focusSurface('map');
    expect(snapshot.surface).not.toBe('map');
  });

  it('returns immutable bounded transition history', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: '' });
    const state = createSearchWorkspaceStateRuntimeV10({ maxHistory: 3 });
    state.replaceModel(page.handoff);
    state.focusSurface('results');
    state.setActive(page.handoff.results[0]!.key);
    state.select(page.handoff.results[0]!.key);
    state.clearSelection();
    const history = state.history();
    expect(history).toHaveLength(3);
    expect(Object.isFrozen(history)).toBe(true);
    expect(history.every(entry => entry.nextFingerprint)).toBe(true);
  });

  it('reset clears request-bound identities without altering counters unexpectedly', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const state = createSearchWorkspaceStateRuntimeV10();
    state.replaceModel(page.handoff);
    state.select(page.handoff.results[0]!.key);
    const reset = state.reset();
    expect(reset.datasetKey).toBeNull();
    expect(reset.modelFingerprint).toBeNull();
    expect(reset.selectedResultKeys).toEqual([]);
    expect(reset.activeResultKey).toBeNull();
    expect(reset.surface).toBe('query');
  });
});
