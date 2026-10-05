import { describe, expect, it } from 'vitest';
import { createSearchWorkspaceAccessibilityRuntimeV10 } from './searchWorkspaceAccessibilityRuntimeV10';
import { createSearchWorkspaceStateRuntimeV10 } from './searchWorkspaceStateRuntimeV10';
import { createWorkspaceRuntimeV10 } from './searchWorkspaceV10.testFixtures';

describe('Search workspace v10 accessibility facts', () => {
  it('exposes result option position set-size and stable active descendant facts', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: '' });
    expect(page.accessibility.results.length).toBe(page.handoff.results.length);
    expect(page.accessibility.results[0]?.position).toBe(1);
    expect(page.accessibility.results[0]?.setSize).toBe(page.handoff.results.length);
    expect(page.accessibility.activeDescendantId).toBeTruthy();
    expect(page.accessibility.results.find(item => item.active)?.id).toBe(page.accessibility.activeDescendantId);
  });

  it('announces blocked search as assertive alert', () => {
    const { workspace } = createWorkspaceRuntimeV10({ blockedWindow: true });
    const page = workspace.search('ankara', { query: 'park', offset: 100 });
    expect(page.accessibility.statusRole).toBe('alert');
    expect(page.accessibility.announcements.some(item => item.priority === 'assertive')).toBe(true);
    expect(page.accessibility.surfaces.some(item => item.surface === 'guidance')).toBe(true);
  });

  it('announces selection count changes without duplicate raw records', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const state = createSearchWorkspaceStateRuntimeV10();
    state.replaceModel(page.handoff);
    const a11y = createSearchWorkspaceAccessibilityRuntimeV10();
    const first = a11y.build(page.handoff, state.snapshot());
    expect(first.selectedCount).toBe(0);
    state.select(page.handoff.results[0]!.key);
    const second = a11y.build(page.handoff, state.snapshot());
    expect(second.selectedCount).toBe(1);
    expect(second.announcements.some(item => item.text.includes('1 sonuç seçili'))).toBe(true);
    expect('records' in second).toBe(false);
  });

  it('marks current workspace surface from revision-bound state', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const state = createSearchWorkspaceStateRuntimeV10();
    state.replaceModel(page.handoff);
    state.focusSurface('results');
    const a11y = createSearchWorkspaceAccessibilityRuntimeV10();
    const model = a11y.build(page.handoff, state.snapshot());
    expect(model.surfaces.find(surface => surface.surface === 'results')?.current).toBe(true);
    expect(model.surfaces.filter(surface => surface.current)).toHaveLength(1);
  });

  it('describes map handoff as delegated behavior rather than navigation authority', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const instruction = page.accessibility.instructions.find(item => item.surface === 'map');
    expect(instruction?.text).toContain('GIS');
    expect(instruction?.text).toContain('handoff');
    expect('navigate' in page.accessibility).toBe(false);
  });

  it('bounds result action instruction and announcement facts independently', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: '' });
    const a11y = createSearchWorkspaceAccessibilityRuntimeV10({
      maxResultFacts: 2,
      maxActionFacts: 3,
      maxInstructions: 2,
      maxAnnouncements: 2,
    });
    const model = a11y.build(page.handoff, page.state);
    expect(model.results.length).toBeLessThanOrEqual(2);
    expect(model.actions.length).toBeLessThanOrEqual(3);
    expect(model.instructions.length).toBeLessThanOrEqual(2);
    expect(model.announcements.length).toBeLessThanOrEqual(2);
  });

  it('uses polite status for normal and recovered result sets', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const normal = workspace.search('ankara', { query: 'park' });
    expect(normal.accessibility.statusRole).toBe('status');
    const recovered = workspace.search('ankara', { query: 'hastne' });
    expect(recovered.accessibility.statusRole).toBe('status');
    expect(recovered.accessibility.announcements.some(item => item.text.includes('kurtarma'))).toBe(true);
  });

  it('does not announce an unchanged page label repeatedly', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    const page = workspace.search('ankara', { query: 'park' });
    const a11y = createSearchWorkspaceAccessibilityRuntimeV10();
    const first = a11y.build(page.handoff, page.state);
    const second = a11y.build(page.handoff, page.state);
    expect(first.announcements.some(item => item.text.includes(page.handoff.pagination.label))).toBe(true);
    expect(second.announcements.some(item => item.text.includes(page.handoff.pagination.label))).toBe(false);
  });

  it('keeps snapshot diagnostic-only and bounded', () => {
    const { workspace } = createWorkspaceRuntimeV10();
    workspace.search('ankara', { query: 'park' });
    workspace.search('ankara', { query: 'hastane' });
    const snapshot = workspace.snapshot().accessibility;
    expect(snapshot.modelsBuilt).toBeGreaterThanOrEqual(2);
    expect(snapshot.resultFactsBuilt).toBeGreaterThan(0);
    expect(snapshot.actionFactsBuilt).toBeGreaterThan(0);
    expect(snapshot.lastModelFingerprint).toBeTruthy();
    expect('results' in snapshot).toBe(false);
  });
});
