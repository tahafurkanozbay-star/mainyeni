import { describe, expect, it } from 'vitest';
import {
  applyArcGisResultWorkspaceIntent,
  createArcGisResultWorkspaceExperience,
  type ResultWorkspaceSnapshot,
} from './ArcGisResultWorkspaceExperiencePolicy';
import {
  createArcGisResultWorkspaceAccessibilityContract,
  reconcileArcGisResultWorkspaceAccessibilityContract,
  resolveWorkspaceAccessibilityEscapeTarget,
  shouldSuppressWorkspaceAccessibilityShortcut,
} from './ArcGisResultWorkspaceAccessibilityExperiencePolicy';

const input = {
  status: 'ready' as const,
  heading: 'Adres sonuçları',
  totalCount: 3,
  rows: [
    { key: 'a', title: 'A' },
    { key: 'b', title: 'B' },
    { key: 'c', title: 'C' },
  ],
};

const desktop = { viewportWidth: 1440, viewportHeight: 900 };
const phone = { viewportWidth: 390, viewportHeight: 740, coarsePointer: true };

const workspace = (environment = desktop): ResultWorkspaceSnapshot =>
  createArcGisResultWorkspaceExperience(input, environment, 'keyboard');

describe('ArcGisResultWorkspaceAccessibilityExperiencePolicy', () => {
  it('creates deterministic semantic ids from a bounded scope', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), {}, 'kent rehberi sonuçları');
    expect(contract.ids.workspace).toBe('kent-rehberi-sonu-lar-workspace');
    expect(contract.ids.collection).toBe('kent-rehberi-sonu-lar-collection');
    expect(contract.collection.ariaDescribedBy).toContain(contract.ids.collectionStatus);
  });

  it('exposes listbox semantics and a bounded initial announcement', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), { totalCount: 3, visibleCount: 3 });
    expect(contract.collection.role).toBe('listbox');
    expect(contract.collection.ariaRowCount).toBe(3);
    expect(contract.collection.ariaBusy).toBe(false);
    expect(contract.liveRegion.role).toBe('status');
    expect(contract.liveRegion.ariaLive).toBe('polite');
    expect(contract.liveRegion.message).toContain('3 sonuç');
  });

  it('maps workspace loading state to aria-busy', () => {
    const loading = createArcGisResultWorkspaceExperience({ ...input, status: 'loading' }, desktop, 'keyboard');
    const contract = createArcGisResultWorkspaceAccessibilityContract(loading);
    expect(contract.collection.ariaBusy).toBe(true);
    expect(contract.liveRegion.message).toBe('Sonuçlar yükleniyor.');
  });

  it('maps errors to an assertive alert without leaking control characters', () => {
    const failed = createArcGisResultWorkspaceExperience({ ...input, status: 'error' }, desktop, 'keyboard');
    const contract = createArcGisResultWorkspaceAccessibilityContract(failed, { errorMessage: 'Ağ\u0000 hatası' }, 'results', 'error');
    expect(contract.liveRegion.role).toBe('alert');
    expect(contract.liveRegion.ariaLive).toBe('assertive');
    expect(contract.liveRegion.message).not.toContain('\u0000');
  });

  it('keeps keyboard focus indication modality-aware', () => {
    expect(createArcGisResultWorkspaceAccessibilityContract(workspace()).focusVisible).toBe(true);
    const pointerWorkspace = createArcGisResultWorkspaceExperience(input, desktop, 'pointer');
    expect(createArcGisResultWorkspaceAccessibilityContract(pointerWorkspace).focusVisible).toBe(false);
  });

  it('makes the collection the fallback focus target when no row is focused', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace());
    expect(contract.focusTarget).toBe(contract.ids.collection);
    expect(contract.collection.tabIndex).toBe(0);
  });

  it('moves the focus contract to a deterministic active descendant', () => {
    const start = workspace();
    const moved = applyArcGisResultWorkspaceIntent(start, { type: 'move-focus', delta: 1 }, desktop, 'keyboard').next;
    const contract = createArcGisResultWorkspaceAccessibilityContract(moved);
    expect(contract.activeDescendant).toBe('result-option-b');
    expect(contract.focusTarget).toBe('result-option-b');
    expect(contract.collection.tabIndex).toBe(-1);
  });

  it('announces focus movement with low-priority polite output', () => {
    const start = workspace();
    const before = createArcGisResultWorkspaceAccessibilityContract(start);
    const moved = applyArcGisResultWorkspaceIntent(start, { type: 'move-focus', delta: 1 }, desktop, 'keyboard').next;
    const after = reconcileArcGisResultWorkspaceAccessibilityContract(before, moved);
    expect(after.action).toBe('restore-result-focus');
    expect(after.announcement.priority).toBe(20);
    expect(after.announcement.message).toContain('Sonuç');
  });

  it('announces selection changes without replacing focus', () => {
    const start = applyArcGisResultWorkspaceIntent(workspace(), { type: 'move-focus', delta: 1 }, desktop, 'keyboard').next;
    const before = createArcGisResultWorkspaceAccessibilityContract(start);
    const selected = applyArcGisResultWorkspaceIntent(start, { type: 'toggle-selection', resultId: 'b' }, desktop, 'keyboard').next;
    const after = reconcileArcGisResultWorkspaceAccessibilityContract(before, selected);
    expect(after.snapshot.selectedCount).toBe(1);
    expect(after.announcement.message).toBe('1 sonuç seçili.');
    expect(after.activeDescendant).toBe(before.activeDescendant);
  });

  it('marks phone filters as modal when the overlay is open', () => {
    const start = workspace(phone);
    const filtered = applyArcGisResultWorkspaceIntent(start, { type: 'toggle-filters' }, phone, 'touch').next;
    const contract = createArcGisResultWorkspaceAccessibilityContract(filtered);
    expect(contract.filters.hidden).toBe(false);
    expect(contract.filters.modal).toBe(true);
    expect(contract.focusTarget).toBe(contract.ids.filters);
  });

  it('does not mark desktop filter region as modal', () => {
    const filtered = applyArcGisResultWorkspaceIntent(workspace(), { type: 'toggle-filters' }, desktop, 'keyboard').next;
    const contract = createArcGisResultWorkspaceAccessibilityContract(filtered);
    expect(contract.filters.hidden).toBe(false);
    expect(contract.filters.modal).toBe(false);
  });

  it('hides detail semantics until a real detail is open', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace());
    expect(contract.detail.hidden).toBe(true);
  });

  it('exposes detail region and focus target when detail opens', () => {
    const opened = applyArcGisResultWorkspaceIntent(workspace(), { type: 'open-detail', resultId: 'a' }, desktop, 'keyboard').next;
    const contract = createArcGisResultWorkspaceAccessibilityContract(opened);
    expect(contract.detail.hidden).toBe(false);
    expect(contract.detail.role).toBe('region');
    expect(contract.focusTarget).toBe(contract.ids.detail);
  });

  it('moves action authority to detail when panel changes', () => {
    const start = workspace();
    const before = createArcGisResultWorkspaceAccessibilityContract(start);
    const opened = applyArcGisResultWorkspaceIntent(start, { type: 'open-detail', resultId: 'a' }, desktop, 'keyboard').next;
    const after = reconcileArcGisResultWorkspaceAccessibilityContract(before, opened);
    expect(after.action).toBe('focus-detail');
  });

  it('moves action authority back to result focus after detail closes', () => {
    const start = applyArcGisResultWorkspaceIntent(workspace(), { type: 'open-detail', resultId: 'a' }, desktop, 'keyboard').next;
    const before = createArcGisResultWorkspaceAccessibilityContract(start);
    const closed = applyArcGisResultWorkspaceIntent(start, { type: 'close-detail' }, desktop, 'keyboard').next;
    const after = reconcileArcGisResultWorkspaceAccessibilityContract(before, closed);
    expect(after.action === 'restore-result-focus' || after.action === 'focus-collection').toBe(true);
  });

  it('exposes map as focusable only when it is the active phone panel', () => {
    const start = workspace(phone);
    const mapContract = createArcGisResultWorkspaceAccessibilityContract(start);
    expect(mapContract.map.hidden).toBe(false);
    expect(mapContract.map.tabIndex).toBe(0);
    const results = applyArcGisResultWorkspaceIntent(start, { type: 'show-results' }, phone, 'keyboard').next;
    const resultsContract = createArcGisResultWorkspaceAccessibilityContract(results);
    expect(resultsContract.map.tabIndex).toBe(-1);
  });

  it('keeps desktop map semantic region visible while collection is active', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace());
    expect(contract.map.hidden).toBe(false);
    expect(contract.map.tabIndex).toBe(-1);
  });

  it('creates pagination hints from accessibility authority', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), { totalCount: 100, visibleCount: 20, pageSize: 20, pageIndex: 2 });
    expect(contract.hints.pagination).toContain('5 sayfa');
    expect(contract.snapshot.currentPageNumber).toBe(3);
  });

  it('supports explicit page-change announcements', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), { totalCount: 100, visibleCount: 20, pageSize: 20, pageIndex: 2 }, 'results', 'page-change');
    expect(contract.announcement.message).toContain('Sayfa 3 / 5');
  });

  it('supports explicit filter-change announcements', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), { totalCount: 7, visibleCount: 7 }, 'results', 'filter-change');
    expect(contract.announcement.message).toContain('Filtreler uygulandı');
  });

  it('supports explicit sort-change announcements', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), { sortLabel: 'Ada göre' }, 'results', 'sort-change');
    expect(contract.announcement.message).toContain('Ada göre');
  });

  it('preserves multi-select semantics by default', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace());
    expect(contract.collection.ariaMultiSelectable).toBe(true);
  });

  it('can expose a single-select collection contract', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), { multiSelectable: false });
    expect(contract.collection.ariaMultiSelectable).toBe(false);
    expect(contract.hints.selection).toContain('tekli');
  });

  it('suppresses shortcuts inside editable targets', () => {
    expect(shouldSuppressWorkspaceAccessibilityShortcut('keyboard', { editable: true })).toBe(true);
  });

  it('suppresses shortcuts during IME composition', () => {
    expect(shouldSuppressWorkspaceAccessibilityShortcut('keyboard', { composing: true })).toBe(true);
  });

  it('suppresses all shortcuts for disabled surfaces', () => {
    expect(shouldSuppressWorkspaceAccessibilityShortcut('keyboard', { disabled: true })).toBe(true);
  });

  it('does not suppress ordinary keyboard shortcuts solely because a modal is open', () => {
    expect(shouldSuppressWorkspaceAccessibilityShortcut('keyboard', { modalOpen: true })).toBe(false);
  });

  it('suppresses non-keyboard modal shortcut dispatch', () => {
    expect(shouldSuppressWorkspaceAccessibilityShortcut('touch', { modalOpen: true })).toBe(true);
  });

  it('restores escape from detail to collection', () => {
    const opened = applyArcGisResultWorkspaceIntent(workspace(), { type: 'open-detail', resultId: 'a' }, desktop, 'keyboard').next;
    const contract = createArcGisResultWorkspaceAccessibilityContract(opened);
    expect(resolveWorkspaceAccessibilityEscapeTarget(contract)).toBe(contract.ids.collection);
  });

  it('restores escape from filters to collection', () => {
    const filtered = applyArcGisResultWorkspaceIntent(workspace(phone), { type: 'toggle-filters' }, phone, 'keyboard').next;
    const contract = createArcGisResultWorkspaceAccessibilityContract(filtered);
    expect(resolveWorkspaceAccessibilityEscapeTarget(contract)).toBe(contract.ids.collection);
  });

  it('keeps escape on the map when map is active', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(phone));
    expect(resolveWorkspaceAccessibilityEscapeTarget(contract)).toBe(contract.ids.map);
  });

  it('increments contract revision monotonically', () => {
    const first = createArcGisResultWorkspaceAccessibilityContract(workspace());
    const second = reconcileArcGisResultWorkspaceAccessibilityContract(first, workspace());
    const third = reconcileArcGisResultWorkspaceAccessibilityContract(second, workspace());
    expect([first.revision, second.revision, third.revision]).toEqual([0, 1, 2]);
  });

  it('bounds huge totals through the shared accessibility policy', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), { totalCount: Number.MAX_SAFE_INTEGER, visibleCount: 3 });
    expect(contract.snapshot.totalCount).toBe(1_000_000);
  });

  it('normalizes invalid paging through the shared accessibility policy', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), { totalCount: 30, visibleCount: 10, pageSize: Number.NaN, pageIndex: Number.POSITIVE_INFINITY });
    expect(Number.isFinite(contract.snapshot.pageSize)).toBe(true);
    expect(contract.snapshot.pageIndex).toBe(0);
  });

  it('does not expose active descendant when collection is hidden on phone', () => {
    const start = workspace(phone);
    const moved = applyArcGisResultWorkspaceIntent(start, { type: 'move-focus', delta: 1 }, phone, 'keyboard').next;
    const map = applyArcGisResultWorkspaceIntent(moved, { type: 'show-map' }, phone, 'keyboard').next;
    const contract = createArcGisResultWorkspaceAccessibilityContract(map);
    expect(contract.activeDescendant).toBeNull();
  });

  it('exposes active descendant after switching phone to results', () => {
    const start = workspace(phone);
    const moved = applyArcGisResultWorkspaceIntent(start, { type: 'move-focus', delta: 1 }, phone, 'keyboard').next;
    const results = applyArcGisResultWorkspaceIntent(moved, { type: 'show-results' }, phone, 'keyboard').next;
    const contract = createArcGisResultWorkspaceAccessibilityContract(results);
    expect(contract.activeDescendant).toBe('result-option-b');
  });

  it('keeps pointer focus changes from forcing keyboard restoration', () => {
    const start = createArcGisResultWorkspaceExperience(input, desktop, 'pointer');
    const before = createArcGisResultWorkspaceAccessibilityContract(start);
    const moved = applyArcGisResultWorkspaceIntent(start, { type: 'move-focus', delta: 1 }, desktop, 'pointer').next;
    const after = reconcileArcGisResultWorkspaceAccessibilityContract(before, moved);
    expect(after.action).not.toBe('restore-result-focus');
  });

  it('uses shared workspace map label', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace());
    expect(contract.map.ariaLabel).toBe('Harita');
  });

  it('uses heading-aware collection label from shared accessibility policy', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), { query: 'Kızılay' });
    expect(contract.collection.ariaLabel).toContain('Kızılay');
  });

  it('keeps live region atomicity aligned with announcement policy', () => {
    const contract = createArcGisResultWorkspaceAccessibilityContract(workspace(), {}, 'results', 'focus-change');
    expect(contract.liveRegion.ariaAtomic).toBe(false);
  });
});
