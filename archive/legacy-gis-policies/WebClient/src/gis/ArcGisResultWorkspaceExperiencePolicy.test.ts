import { describe, expect, it } from 'vitest';
import {
  applyArcGisResultWorkspaceIntent,
  createArcGisResultWorkspaceExperience,
  reconcileArcGisResultWorkspaceEnvironment,
  resolveArcGisResultWorkspaceKeyboardIntent,
  type ResultWorkspaceEnvironment,
} from './ArcGisResultWorkspaceExperiencePolicy';
import type { ArcGisResultExperienceInput } from './ArcGisResultExperiencePolicy';

const desktop: ResultWorkspaceEnvironment = { viewportWidth: 1440, viewportHeight: 720 };
const phone: ResultWorkspaceEnvironment = { viewportWidth: 390, viewportHeight: 700, coarsePointer: true };
const input = (count = 4): ArcGisResultExperienceInput => ({
  status: 'ready',
  records: Array.from({ length: count }, (_, index) => ({
    objectId: index + 1,
    title: `Kayıt ${index + 1}`,
    category: index % 2 ? 'Park' : 'Kamu',
    attributes: { name: `Kayıt ${index + 1}`, score: index * 10 },
  })),
  columns: [
    { id: 'title', label: 'Ad', sortable: true, priority: 1 },
    { id: 'score', label: 'Puan', attribute: 'score', sortable: true, priority: 2 },
  ],
  totalCount: count,
  pageSize: 25,
});

describe('ArcGisResultWorkspaceExperiencePolicy', () => {
  it('creates a desktop split workspace with bounded accessibility defaults', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop, 'keyboard');
    expect(snapshot.presentation).toMatchObject({ viewport: 'desktop', splitView: true, mapVisible: true, collectionVisible: true, panel: 'collection' });
    expect(snapshot.accessibility).toMatchObject({ focusVisible: true, minimumTargetSize: 44, motionDurationMs: 160, collectionRole: 'region' });
    expect(snapshot.interaction.resultIds).toHaveLength(4);
    expect(snapshot.revision).toBe(0);
  });

  it('starts phone workspace map-first and forces comfortable list presentation', () => {
    const snapshot = createArcGisResultWorkspaceExperience({ ...input(), layout: 'table', density: 'compact' }, phone, 'touch');
    expect(snapshot.presentation).toMatchObject({ viewport: 'phone', panel: 'map', mapVisible: true, collectionVisible: false, layout: 'list', density: 'comfortable', compactChrome: true });
    expect(snapshot.accessibility.minimumTargetSize).toBe(48);
    expect(snapshot.accessibility.focusVisible).toBe(false);
  });

  it('honors reduced motion and forced colors without changing information structure', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), { ...desktop, reducedMotion: true, forcedColors: true }, 'keyboard');
    expect(snapshot.accessibility.motionDurationMs).toBe(0);
    expect(snapshot.accessibility.forcedColors).toBe(true);
    expect(snapshot.model.rows).toHaveLength(4);
  });

  it('moves focus and keeps the collection surface authoritative', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop, 'keyboard');
    const transition = applyArcGisResultWorkspaceIntent(snapshot, { type: 'move-focus', delta: 1 }, desktop, 'keyboard');
    expect(transition.focusTarget).toBe(snapshot.interaction.resultIds[0]);
    expect(transition.next.presentation.panel).toBe('collection');
    expect(transition.next.accessibility.focusVisible).toBe(true);
    expect(transition.next.revision).toBe(1);
  });

  it('opens and closes detail while returning focus to the active result', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop, 'keyboard');
    const id = snapshot.interaction.resultIds[1];
    const opened = applyArcGisResultWorkspaceIntent(snapshot, { type: 'open-detail', resultId: id }, desktop, 'keyboard');
    expect(opened.next.interaction.detailOpen).toBe(true);
    expect(opened.next.presentation.panel).toBe('detail');
    expect(opened.focusTarget).toBe(id);
    const closed = applyArcGisResultWorkspaceIntent(opened.next, { type: 'close-detail' }, desktop, 'keyboard');
    expect(closed.next.interaction.detailOpen).toBe(false);
    expect(closed.next.presentation.panel).toBe('collection');
    expect(closed.focusTarget).toBe(id);
  });

  it('uses overlay detail presentation on phones', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), phone, 'touch');
    const id = snapshot.interaction.resultIds[0];
    const opened = applyArcGisResultWorkspaceIntent(snapshot, { type: 'open-detail', resultId: id }, phone, 'touch');
    expect(opened.next.presentation.detailOverlay).toBe(true);
    expect(opened.next.presentation.splitView).toBe(false);
    expect(opened.next.presentation.mapVisible).toBe(false);
  });

  it('toggles mobile filters as an overlay', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), phone, 'touch');
    const opened = applyArcGisResultWorkspaceIntent(snapshot, { type: 'toggle-filters' }, phone, 'touch');
    expect(opened.next.interaction.filterOpen).toBe(true);
    expect(opened.next.presentation.filtersOverlay).toBe(true);
    expect(opened.announcement).toBe('Filtreler açıldı');
    const closed = applyArcGisResultWorkspaceIntent(opened.next, { type: 'close-filters' }, phone, 'touch');
    expect(closed.next.interaction.filterOpen).toBe(false);
    expect(closed.next.presentation.panel).toBe('collection');
  });

  it('keeps desktop filters non-overlay', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop);
    const transition = applyArcGisResultWorkspaceIntent(snapshot, { type: 'toggle-filters' }, desktop);
    expect(transition.next.presentation.panel).toBe('filters');
    expect(transition.next.presentation.filtersOverlay).toBe(false);
    expect(transition.next.interaction.filterOpen).toBe(false);
  });

  it('switches map and collection panels on compact viewports', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), phone);
    const results = applyArcGisResultWorkspaceIntent(snapshot, { type: 'show-results' }, phone);
    expect(results.next.presentation.collectionVisible).toBe(true);
    expect(results.next.presentation.mapVisible).toBe(false);
    const map = applyArcGisResultWorkspaceIntent(results.next, { type: 'show-map' }, phone);
    expect(map.next.presentation.mapVisible).toBe(true);
    expect(map.next.presentation.collectionVisible).toBe(false);
  });

  it('updates layout preference while phone presentation remains list-safe', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), phone);
    const transition = applyArcGisResultWorkspaceIntent(snapshot, { type: 'set-layout', layout: 'table' }, phone);
    expect(transition.next.model.layout).toBe('table');
    expect(transition.next.presentation.layout).toBe('list');
    expect(transition.announcement).toBe('Tablo görünümü');
  });

  it('updates density and interaction row height together', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop);
    const compact = applyArcGisResultWorkspaceIntent(snapshot, { type: 'set-density', density: 'compact' }, desktop);
    expect(compact.next.model.density).toBe('compact');
    expect(compact.next.interaction.rowHeight).toBe(44);
    const comfortable = applyArcGisResultWorkspaceIntent(compact.next, { type: 'set-density', density: 'comfortable' }, desktop);
    expect(comfortable.next.interaction.rowHeight).toBe(56);
  });

  it('reconciles disappearing active results and restores map focus signal', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop, 'keyboard');
    const id = snapshot.interaction.resultIds[0];
    const opened = applyArcGisResultWorkspaceIntent(snapshot, { type: 'open-detail', resultId: id }, desktop, 'keyboard');
    const remaining = opened.next.interaction.resultIds.slice(1);
    const refreshed = applyArcGisResultWorkspaceIntent(opened.next, { type: 'refresh', resultIds: remaining, reason: 'result-refresh' }, desktop, 'keyboard');
    expect(refreshed.next.interaction.detailOpen).toBe(false);
    expect(refreshed.restoreMapFocus).toBe(true);
    expect(refreshed.announcement).toContain('artık listede değil');
  });

  it('reconciles selected results after filter changes', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop);
    const id = snapshot.interaction.resultIds[0];
    const selected = applyArcGisResultWorkspaceIntent(snapshot, { type: 'toggle-selection', resultId: id }, desktop);
    expect(selected.next.interaction.selectedIds).toContain(id);
    const filtered = applyArcGisResultWorkspaceIntent(selected.next, { type: 'refresh', resultIds: snapshot.interaction.resultIds.slice(1), reason: 'filter-change' }, desktop);
    expect(filtered.next.interaction.selectedIds).not.toContain(id);
    expect(filtered.announcement).toContain('seçili sonuç');
  });

  it('deduplicates and sanitizes refresh identifiers', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop);
    const refreshed = applyArcGisResultWorkspaceIntent(snapshot, { type: 'refresh', resultIds: [' alpha ', 'alpha', '\u0000beta', '', '   '] }, desktop);
    expect(refreshed.next.interaction.resultIds).toEqual(['alpha', 'beta']);
  });

  it('bounds refresh identifiers to the interaction contract maximum', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop);
    const ids = Array.from({ length: 20_100 }, (_, index) => `id-${index}`);
    const refreshed = applyArcGisResultWorkspaceIntent(snapshot, { type: 'refresh', resultIds: ids }, desktop);
    expect(refreshed.next.interaction.resultIds).toHaveLength(20_000);
  });

  it('reconciles desktop to phone without retaining desktop-only split assumptions', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop);
    const compact = reconcileArcGisResultWorkspaceEnvironment(snapshot, phone);
    expect(compact.next.presentation.viewport).toBe('phone');
    expect(compact.next.presentation.splitView).toBe(false);
    expect(compact.next.accessibility.minimumTargetSize).toBe(48);
  });

  it('closes mobile filter state when returning to desktop', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), phone);
    const filters = applyArcGisResultWorkspaceIntent(snapshot, { type: 'toggle-filters' }, phone);
    expect(filters.next.interaction.filterOpen).toBe(true);
    const wide = reconcileArcGisResultWorkspaceEnvironment(filters.next, desktop);
    expect(wide.next.interaction.filterOpen).toBe(false);
    expect(wide.next.presentation.filtersOverlay).toBe(false);
  });

  it('keeps detail authoritative through responsive transitions', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop);
    const id = snapshot.interaction.resultIds[2];
    const opened = applyArcGisResultWorkspaceIntent(snapshot, { type: 'open-detail', resultId: id }, desktop);
    const compact = reconcileArcGisResultWorkspaceEnvironment(opened.next, phone);
    expect(compact.next.interaction.activeId).toBe(id);
    expect(compact.next.presentation.panel).toBe('detail');
    expect(compact.next.presentation.detailOverlay).toBe(true);
  });

  it('handles malformed environment dimensions deterministically', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), { viewportWidth: Number.NaN, viewportHeight: Number.POSITIVE_INFINITY });
    expect(snapshot.presentation.viewport).toBe('desktop');
    expect(snapshot.interaction.viewportHeight).toBe(0);
  });

  it('increments revision monotonically across user-visible transitions', () => {
    let snapshot = createArcGisResultWorkspaceExperience(input(), desktop);
    for (let index = 1; index <= 5; index += 1) {
      const transition = applyArcGisResultWorkspaceIntent(snapshot, { type: 'show-results' }, desktop);
      expect(transition.next.revision).toBe(index);
      snapshot = transition.next;
    }
  });

  it('does not expose pointer focus rings after pointer modality transition', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop, 'keyboard');
    expect(snapshot.accessibility.focusVisible).toBe(true);
    const transition = applyArcGisResultWorkspaceIntent(snapshot, { type: 'show-results' }, desktop, 'pointer');
    expect(transition.next.accessibility.focusVisible).toBe(false);
  });

  it('maps workspace keyboard shortcuts without stealing plain text keys', () => {
    expect(resolveArcGisResultWorkspaceKeyboardIntent('ArrowDown')).toEqual({ type: 'move-focus', delta: 1 });
    expect(resolveArcGisResultWorkspaceKeyboardIntent('PageUp')).toEqual({ type: 'move-focus', delta: -10 });
    expect(resolveArcGisResultWorkspaceKeyboardIntent('f', true)).toEqual({ type: 'toggle-filters' });
    expect(resolveArcGisResultWorkspaceKeyboardIntent('m', true)).toEqual({ type: 'show-map' });
    expect(resolveArcGisResultWorkspaceKeyboardIntent('r', true)).toEqual({ type: 'show-results' });
    expect(resolveArcGisResultWorkspaceKeyboardIntent('f', false)).toBeNull();
    expect(resolveArcGisResultWorkspaceKeyboardIntent('a', false)).toBeNull();
  });

  it('ignores attempts to open unknown result detail', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(), desktop);
    const transition = applyArcGisResultWorkspaceIntent(snapshot, { type: 'open-detail', resultId: 'unknown' }, desktop);
    expect(transition.next.interaction.detailOpen).toBe(false);
    expect(transition.focusTarget).toBeNull();
  });

  it('preserves bounded target sizes independently of viewport class', () => {
    const tablet = { viewportWidth: 800, viewportHeight: 600, coarsePointer: true };
    const snapshot = createArcGisResultWorkspaceExperience(input(), tablet);
    expect(snapshot.presentation.viewport).toBe('tablet');
    expect(snapshot.accessibility.minimumTargetSize).toBe(48);
    expect(snapshot.presentation.compactChrome).toBe(true);
  });

  it('keeps announcements bounded to policy-generated copy', () => {
    const snapshot = createArcGisResultWorkspaceExperience(input(100), desktop);
    const moved = applyArcGisResultWorkspaceIntent(snapshot, { type: 'move-focus', delta: 50 }, desktop, 'keyboard');
    expect(moved.announcement.length).toBeLessThan(100);
    expect(moved.announcement).not.toContain('undefined');
  });
});
