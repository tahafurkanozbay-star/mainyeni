import { describe, expect, it } from 'vitest';
import { createResultDetailExperienceModel } from './ArcGisResultDetailExperiencePolicy';
import { createArcGisResultWorkspaceAccessibilityContract } from './ArcGisResultWorkspaceAccessibilityExperiencePolicy';
import {
  createArcGisResultWorkspaceDetailAccessibilityContract,
  resolveArcGisResultWorkspaceDetailAccessibilityKey,
  shouldTrapArcGisResultWorkspaceDetailFocus,
} from './ArcGisResultWorkspaceDetailAccessibilityExperiencePolicy';
import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';

const workspace = (overrides: Partial<ResultWorkspaceSnapshot> = {}): ResultWorkspaceSnapshot => ({
  model: { status: 'ready', heading: 'Sonuçlar' },
  interaction: {
    resultIds: ['row-1', 'row-2'],
    selectedIds: [],
    focusedId: 'row-1',
    activeId: 'row-1',
    detailOpen: true,
    filterOpen: false,
    viewport: 'desktop',
  },
  presentation: { panel: 'detail', collectionVisible: true, mapVisible: true, splitView: true, filtersOverlay: false },
  accessibility: { minimumTargetSize: 44, reducedMotion: false, forcedColors: false, mapLabel: 'Harita' },
  modality: 'keyboard',
  revision: 0,
  ...overrides,
} as ResultWorkspaceSnapshot);

const detail = (width = 1280, selectedSectionId: string | null = 'identity') => createResultDetailExperienceModel({
  resultId: 'row-1',
  title: 'Belediye Hizmet Noktası',
  viewportWidth: width,
  selectedSectionId,
  canClose: true,
  sections: [
    { id: 'identity', label: 'Kimlik', fields: [{ id: 'name', label: 'Ad', value: 'Merkez' }] },
    { id: 'location', label: 'Konum', fields: [{ id: 'district', label: 'İlçe', value: 'Çankaya' }] },
    { id: 'contact', label: 'İletişim', fields: [{ id: 'phone', label: 'Telefon', value: '0312' }] },
  ],
});

const create = (width = 1280, previous = null as ReturnType<typeof createArcGisResultWorkspaceDetailAccessibilityContract> | null) => {
  const current = workspace();
  return createArcGisResultWorkspaceDetailAccessibilityContract(
    current,
    createArcGisResultWorkspaceAccessibilityContract(current),
    detail(width),
    'results',
    previous,
  );
};

describe('ArcGisResultWorkspaceDetailAccessibilityExperiencePolicy', () => {
  it('uses complementary semantics for persistent desktop detail', () => {
    const contract = create();
    expect(contract.role).toBe('complementary');
    expect(contract.modal).toBe(false);
    expect(contract.hidden).toBe(false);
    expect(contract.ariaLabelledBy).toBe('results-detail-heading');
    expect(contract.ariaDescribedBy).toBe('results-detail-status');
    expect(contract.focusAction).toBe('focus-heading');
    expect(contract.focusTarget).toBe('results-detail-heading');
    expect(shouldTrapArcGisResultWorkspaceDetailFocus(contract)).toBe(false);
  });

  it.each([390, 800])('uses modal dialog semantics for overlay detail at %ipx', (width) => {
    const contract = create(width);
    expect(contract.role).toBe('dialog');
    expect(contract.presentation).toBe('dialog');
    expect(contract.modal).toBe(true);
    expect(shouldTrapArcGisResultWorkspaceDetailFocus(contract)).toBe(true);
  });

  it('inherits workspace accessibility preferences instead of inventing parallel settings', () => {
    const current = workspace({
      accessibility: { minimumTargetSize: 48, reducedMotion: true, forcedColors: true, mapLabel: 'Harita' },
      modality: 'pointer',
    } as Partial<ResultWorkspaceSnapshot>);
    const contract = createArcGisResultWorkspaceDetailAccessibilityContract(
      current,
      createArcGisResultWorkspaceAccessibilityContract(current),
      detail(),
    );
    expect(contract.minimumTargetSize).toBe(48);
    expect(contract.reducedMotion).toBe(true);
    expect(contract.forcedColors).toBe(true);
    expect(contract.focusVisible).toBe(false);
  });

  it('publishes bounded deterministic section ids and selected section focus', () => {
    const current = workspace();
    const contract = createArcGisResultWorkspaceDetailAccessibilityContract(
      current,
      createArcGisResultWorkspaceAccessibilityContract(current),
      detail(1280, 'location'),
      'unsafe scope\u0000',
    );
    expect(contract.sectionIds).toEqual([
      'unsafe-scope-detail-section-identity',
      'unsafe-scope-detail-section-location',
      'unsafe-scope-detail-section-contact',
    ]);
    expect(contract.activeSectionId).toBe('unsafe-scope-detail-section-location');
  });

  it('moves focus when the selected section changes', () => {
    const initial = create();
    const current = workspace();
    const next = createArcGisResultWorkspaceDetailAccessibilityContract(
      current,
      createArcGisResultWorkspaceAccessibilityContract(current),
      detail(1280, 'location'),
      'results',
      initial,
    );
    expect(next.focusAction).toBe('focus-section');
    expect(next.focusTarget).toBe('results-detail-section-location');
    expect(next.revision).toBe(1);
  });

  it('restores result focus when detail closes', () => {
    const initial = create();
    const closed = workspace({
      interaction: { ...workspace().interaction, detailOpen: false, activeId: null },
      presentation: { ...workspace().presentation, panel: 'collection' },
    } as Partial<ResultWorkspaceSnapshot>);
    const next = createArcGisResultWorkspaceDetailAccessibilityContract(
      closed,
      createArcGisResultWorkspaceAccessibilityContract(closed),
      detail(),
      'results',
      initial,
    );
    expect(next.hidden).toBe(true);
    expect(next.focusAction).toBe('restore-result');
    expect(next.focusTarget).toBe('result-option-row-1');
  });

  it('falls back to collection focus when the focused result is gone', () => {
    const initial = create();
    const closed = workspace({
      interaction: { ...workspace().interaction, resultIds: [], focusedId: null, activeId: null, detailOpen: false },
      presentation: { ...workspace().presentation, panel: 'collection' },
    } as Partial<ResultWorkspaceSnapshot>);
    const accessibility = createArcGisResultWorkspaceAccessibilityContract(closed, {}, 'results');
    const next = createArcGisResultWorkspaceDetailAccessibilityContract(closed, accessibility, detail(), 'results', initial);
    expect(next.restoreFocusTarget).toBe('results-collection');
    expect(next.focusTarget).toBe('results-collection');
  });

  it('uses assertive live semantics for bounded errors', () => {
    const current = workspace();
    const model = createResultDetailExperienceModel({
      resultId: 'row-1',
      title: 'Sonuç',
      error: `Sunucu yanıt vermedi ${'x'.repeat(500)}`,
    });
    const contract = createArcGisResultWorkspaceDetailAccessibilityContract(
      current,
      createArcGisResultWorkspaceAccessibilityContract(current),
      model,
    );
    expect(contract.liveRegion.role).toBe('alert');
    expect(contract.liveRegion.ariaLive).toBe('assertive');
    expect(contract.liveRegion.message.length).toBeLessThanOrEqual(240);
  });

  it('cycles section focus with arrow keys and wraps deterministically', () => {
    const contract = create();
    const first = contract.sectionIds[0];
    const last = contract.sectionIds.at(-1);
    expect(resolveArcGisResultWorkspaceDetailAccessibilityKey(contract, { key: 'ArrowDown' }, first).focusTarget).toBe(contract.sectionIds[1]);
    expect(resolveArcGisResultWorkspaceDetailAccessibilityKey(contract, { key: 'ArrowDown' }, last).focusTarget).toBe(first);
    expect(resolveArcGisResultWorkspaceDetailAccessibilityKey(contract, { key: 'ArrowUp' }, first).focusTarget).toBe(last);
  });

  it('supports Home and End without consuming keys when no section exists', () => {
    const contract = create();
    expect(resolveArcGisResultWorkspaceDetailAccessibilityKey(contract, { key: 'Home' }).focusTarget).toBe(contract.sectionIds[0]);
    expect(resolveArcGisResultWorkspaceDetailAccessibilityKey(contract, { key: 'End' }).focusTarget).toBe(contract.sectionIds.at(-1));

    const current = workspace();
    const empty = createArcGisResultWorkspaceDetailAccessibilityContract(
      current,
      createArcGisResultWorkspaceAccessibilityContract(current),
      createResultDetailExperienceModel({ resultId: 'row-1', title: 'Boş' }),
    );
    expect(resolveArcGisResultWorkspaceDetailAccessibilityKey(empty, { key: 'Home' }).handled).toBe(false);
  });

  it('maps Escape to close and explicit result focus restoration', () => {
    const contract = create(390);
    const resolution = resolveArcGisResultWorkspaceDetailAccessibilityKey(contract, { key: 'Escape' });
    expect(resolution).toEqual({
      handled: true,
      preventDefault: true,
      focusTarget: 'result-option-row-1',
      action: 'close',
    });
  });

  it('fails closed for editable, IME, repeat, prevented and modified key contexts', () => {
    const contract = create();
    for (const event of [
      { key: 'ArrowDown', editable: true },
      { key: 'ArrowDown', composing: true },
      { key: 'ArrowDown', repeat: true },
      { key: 'ArrowDown', defaultPrevented: true },
      { key: 'ArrowDown', ctrlKey: true },
      { key: 'ArrowDown', altKey: true },
      { key: 'ArrowDown', metaKey: true },
    ]) {
      expect(resolveArcGisResultWorkspaceDetailAccessibilityKey(contract, event)).toEqual({
        handled: false,
        preventDefault: false,
        focusTarget: null,
        action: 'none',
      });
    }
  });

  it('does not intercept keyboard commands while detail is hidden', () => {
    const current = workspace({ interaction: { ...workspace().interaction, detailOpen: false, activeId: null } } as Partial<ResultWorkspaceSnapshot>);
    const contract = createArcGisResultWorkspaceDetailAccessibilityContract(
      current,
      createArcGisResultWorkspaceAccessibilityContract(current),
      detail(),
    );
    expect(resolveArcGisResultWorkspaceDetailAccessibilityKey(contract, { key: 'Escape' }).handled).toBe(false);
  });
});
