import { describe, expect, it } from 'vitest';
import { createArcGisResultWorkspaceExperience, applyArcGisResultWorkspaceIntent } from './ArcGisResultWorkspaceExperiencePolicy';
import { createArcGisResultWorkspaceNavigationPlan, resolveArcGisResultWorkspaceF6Intent, resolveArcGisResultWorkspaceLandmarkFocus, resolveArcGisResultWorkspacePanelFocus, shouldSuppressWorkspaceNavigationShortcut } from './ArcGisResultWorkspaceNavigationExperiencePolicy';

const input = { status: 'ready' as const, heading: 'Yakındaki sonuçlar', rows: [{ key: '1', title: 'Park' }, { key: '2', title: 'Müze' }] } as any;
const desktop = { viewportWidth: 1440, viewportHeight: 900 };
const phone = { viewportWidth: 390, viewportHeight: 760, coarsePointer: true };

describe('ArcGisResultWorkspaceNavigationExperiencePolicy', () => {
  it('orders desktop landmarks around view controls, collection and map', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot);
    expect(plan.targets.map((item) => item.landmark)).toEqual(['view-controls', 'collection', 'map', 'filters', 'status']);
    expect(plan.cycleEnabled).toBe(true);
  });

  it('puts the map first on the initial phone workspace', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, phone);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot);
    expect(plan.targets.map((item) => item.landmark)).toEqual(['view-controls', 'map', 'status']);
  });

  it('moves the collection into the phone cycle after results are shown', () => {
    const initial = createArcGisResultWorkspaceExperience(input, phone);
    const shown = applyArcGisResultWorkspaceIntent(initial, { type: 'show-results' }, phone).next;
    const plan = createArcGisResultWorkspaceNavigationPlan(shown);
    expect(plan.targets.map((item) => item.landmark)).toEqual(['view-controls', 'collection', 'status']);
  });

  it('adds filter landmark only while the phone filter overlay is visible', () => {
    const initial = createArcGisResultWorkspaceExperience(input, phone);
    const filtered = applyArcGisResultWorkspaceIntent(initial, { type: 'toggle-filters' }, phone).next;
    const plan = createArcGisResultWorkspaceNavigationPlan(filtered);
    expect(plan.targets.map((item) => item.landmark)).toContain('filters');
    expect(plan.targets.find((item) => item.landmark === 'filters')?.focusable).toBe(true);
  });

  it('adds detail landmark only while detail is actually open', () => {
    const initial = createArcGisResultWorkspaceExperience(input, desktop);
    const opened = applyArcGisResultWorkspaceIntent(initial, { type: 'open-detail', resultId: '1' }, desktop).next;
    expect(createArcGisResultWorkspaceNavigationPlan(opened).targets.map((item) => item.landmark)).toContain('detail');
    const closed = applyArcGisResultWorkspaceIntent(opened, { type: 'close-detail' }, desktop).next;
    expect(createArcGisResultWorkspaceNavigationPlan(closed).targets.map((item) => item.landmark)).not.toContain('detail');
  });

  it('tracks an active connected landmark without retaining DOM nodes', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot, { activeElementId: 'arcgis-result-workspace-map' });
    expect(plan.activeTarget?.landmark).toBe('map');
    expect(plan.activeIndex).toBeGreaterThanOrEqual(0);
  });

  it('treats a disconnected target as non-focusable when a connection inventory is supplied', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot, { connectedElementIds: ['arcgis-result-workspace-map', 'arcgis-result-workspace-status'] });
    expect(plan.targets.find((item) => item.landmark === 'collection')?.focusable).toBe(false);
    expect(plan.targets.find((item) => item.landmark === 'map')?.focusable).toBe(true);
  });

  it('bounds hostile connected-id inventories', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const ids = Array.from({ length: 1000 }, (_, index) => `node-${index}`);
    ids[0] = 'arcgis-result-workspace-map';
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot, { connectedElementIds: ids });
    expect(plan.targets.find((item) => item.landmark === 'map')?.focusable).toBe(true);
    expect(plan.targets.find((item) => item.landmark === 'collection')?.focusable).toBe(false);
  });

  it('removes control characters from active element identifiers', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot, { activeElementId: '\u0000arcgis-result-workspace-map\u0007' });
    expect(plan.activeTarget?.landmark).toBe('map');
  });

  it('does not cycle while the document is hidden', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    expect(createArcGisResultWorkspaceNavigationPlan(snapshot, { documentVisible: false }).cycleEnabled).toBe(false);
  });

  it('skips disabled landmarks during forward cycling', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot, { activeElementId: 'arcgis-result-workspace-view-controls', disabledElementIds: ['arcgis-result-workspace-collection'] });
    expect(resolveArcGisResultWorkspaceLandmarkFocus(plan, 'next').targetId).toBe('arcgis-result-workspace-map');
  });

  it('skips inert landmarks during reverse cycling', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot, { activeElementId: 'arcgis-result-workspace-map', inertElementIds: ['arcgis-result-workspace-collection'] });
    expect(resolveArcGisResultWorkspaceLandmarkFocus(plan, 'previous').targetId).toBe('arcgis-result-workspace-view-controls');
  });

  it('wraps forward focus at the end', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot, { activeElementId: 'arcgis-result-workspace-status' });
    expect(resolveArcGisResultWorkspaceLandmarkFocus(plan, 'next').targetId).toBe('arcgis-result-workspace-view-controls');
  });

  it('wraps reverse focus at the beginning', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot, { activeElementId: 'arcgis-result-workspace-view-controls' });
    expect(resolveArcGisResultWorkspaceLandmarkFocus(plan, 'previous').targetId).toBe('arcgis-result-workspace-status');
  });

  it('resolves first and last focus explicitly', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot);
    expect(resolveArcGisResultWorkspaceLandmarkFocus(plan, 'first').targetId).toBe('arcgis-result-workspace-view-controls');
    expect(resolveArcGisResultWorkspaceLandmarkFocus(plan, 'last').targetId).toBe('arcgis-result-workspace-status');
  });

  it('returns no target when every visible landmark is disabled', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, phone);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot, { disabledElementIds: ['arcgis-result-workspace-view-controls', 'arcgis-result-workspace-map', 'arcgis-result-workspace-status'] });
    expect(resolveArcGisResultWorkspaceLandmarkFocus(plan, 'next').targetId).toBeNull();
  });

  it('resolves exact panel focus when the requested panel is available', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot);
    expect(resolveArcGisResultWorkspacePanelFocus(plan, 'map', 'panel-open').targetId).toBe('arcgis-result-workspace-map');
  });

  it('falls back safely when requested panel is not visible', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, phone);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot);
    expect(resolveArcGisResultWorkspacePanelFocus(plan, 'detail', 'panel-open').targetId).toBe('arcgis-result-workspace-view-controls');
  });

  it('preserves the workspace collection accessible label', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input, desktop);
    const plan = createArcGisResultWorkspaceNavigationPlan(snapshot);
    expect(plan.targets.find((item) => item.landmark === 'collection')?.label).toBe('Yakındaki sonuçlar');
  });

  it('maps unmodified F6 to forward cycling', () => expect(resolveArcGisResultWorkspaceF6Intent('F6', false)).toBe('next'));
  it('maps Shift+F6 to reverse cycling', () => expect(resolveArcGisResultWorkspaceF6Intent('F6', true)).toBe('previous'));
  it('does not steal modified F6 shortcuts', () => {
    expect(resolveArcGisResultWorkspaceF6Intent('F6', false, true)).toBeNull();
    expect(resolveArcGisResultWorkspaceF6Intent('F6', false, false, true)).toBeNull();
    expect(resolveArcGisResultWorkspaceF6Intent('F6', false, false, false, true)).toBeNull();
  });
  it('does not treat other keys as workspace cycling', () => expect(resolveArcGisResultWorkspaceF6Intent('F5', false)).toBeNull());
  it('suppresses shortcuts while IME composition is active', () => expect(shouldSuppressWorkspaceNavigationShortcut('div', false, true)).toBe(true));
  it('suppresses shortcuts for contenteditable targets', () => expect(shouldSuppressWorkspaceNavigationShortcut('div', true, false)).toBe(true));
  it('suppresses shortcuts in form fields', () => {
    expect(shouldSuppressWorkspaceNavigationShortcut('INPUT', false, false)).toBe(true);
    expect(shouldSuppressWorkspaceNavigationShortcut('textarea', false, false)).toBe(true);
    expect(shouldSuppressWorkspaceNavigationShortcut('select', false, false)).toBe(true);
  });
  it('allows workspace shortcuts on non-editable controls', () => expect(shouldSuppressWorkspaceNavigationShortcut('button', false, false)).toBe(false));
});
