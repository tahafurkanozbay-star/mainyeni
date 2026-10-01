import { describe, expect, it } from 'vitest';
import {
  createResultFilterState,
  describeResultFilterChange,
  normalizeResultFilterClauses,
  normalizeResultFilterDefinitions,
  reduceResultFilterState,
  resolveResultFilterViewport,
  type ResultFilterDefinition,
} from './ArcGisResultFilterExperiencePolicy';

const definitions: readonly ResultFilterDefinition[] = [
  { id: 'name', label: 'Ad', kind: 'text' },
  { id: 'count', label: 'Sayı', kind: 'number' },
  { id: 'date', label: 'Tarih', kind: 'date' },
  { id: 'district', label: 'İlçe', kind: 'choice', options: [{ value: 'cankaya', label: 'Çankaya', count: 8 }, { value: 'kecioren', label: 'Keçiören', count: 3 }] },
];

describe('ArcGisResultFilterExperiencePolicy', () => {
  it('maps responsive widths deterministically', () => {
    expect(resolveResultFilterViewport(320)).toBe('phone');
    expect(resolveResultFilterViewport(639)).toBe('phone');
    expect(resolveResultFilterViewport(640)).toBe('tablet');
    expect(resolveResultFilterViewport(1023)).toBe('tablet');
    expect(resolveResultFilterViewport(1024)).toBe('desktop');
    expect(resolveResultFilterViewport(undefined)).toBe('desktop');
    expect(resolveResultFilterViewport(Number.NaN)).toBe('desktop');
  });

  it('normalizes definitions and removes duplicate identities', () => {
    const result = normalizeResultFilterDefinitions([
      ...definitions,
      { id: 'name', label: 'Duplicate', kind: 'text' },
      { id: '', label: 'Missing', kind: 'text' },
    ]);
    expect(result).toHaveLength(4);
    expect(result[0].operators).toEqual(['contains', 'equals']);
    expect(result[1].operators).toEqual(['equals', 'between']);
    expect(result[2].operators).toEqual(['equals', 'before', 'after', 'between']);
    expect(result[3].operators).toEqual(['equals']);
  });

  it('bounds definition cardinality', () => {
    const result = normalizeResultFilterDefinitions(Array.from({ length: 100 }, (_, index) => ({ id: `f-${index}`, label: `Filter ${index}`, kind: 'text' as const })));
    expect(result).toHaveLength(32);
  });

  it('bounds option cardinality and deduplicates option values', () => {
    const result = normalizeResultFilterDefinitions([{ id: 'choice', label: 'Choice', kind: 'choice', options: [...Array.from({ length: 120 }, (_, index) => ({ value: `v-${index}`, label: `Value ${index}` })), { value: 'v-0', label: 'Duplicate' }] }]);
    expect(result[0].options).toHaveLength(100);
    expect(result[0].options?.[0].label).toBe('Value 0');
  });

  it('sanitizes control characters in user-facing labels', () => {
    const result = normalizeResultFilterDefinitions([{ id: ' x\u0000 ', label: ' A\n B ', kind: 'text' }]);
    expect(result[0].id).toBe('x');
    expect(result[0].label).toBe('A B');
  });

  it('accepts valid text clauses', () => {
    const result = normalizeResultFilterClauses([{ id: 'c1', filterId: 'name', operator: 'contains', value: 'park' }], definitions);
    expect(result.invalidClauseIds).toEqual([]);
    expect(result.clauses).toHaveLength(1);
  });

  it('rejects unsupported operators without dropping reviewable draft', () => {
    const result = normalizeResultFilterClauses([{ id: 'c1', filterId: 'district', operator: 'contains', value: 'cankaya' }], definitions);
    expect(result.clauses).toHaveLength(1);
    expect(result.invalidClauseIds).toEqual(['c1']);
  });

  it('validates number equality', () => {
    expect(normalizeResultFilterClauses([{ id: 'c', filterId: 'count', operator: 'equals', value: '42' }], definitions).invalidClauseIds).toEqual([]);
    expect(normalizeResultFilterClauses([{ id: 'c', filterId: 'count', operator: 'equals', value: 'forty' }], definitions).invalidClauseIds).toEqual(['c']);
  });

  it('requires both bounds for number ranges', () => {
    expect(normalizeResultFilterClauses([{ id: 'c', filterId: 'count', operator: 'between', value: '1', secondaryValue: '9' }], definitions).invalidClauseIds).toEqual([]);
    expect(normalizeResultFilterClauses([{ id: 'c', filterId: 'count', operator: 'between', value: '1' }], definitions).invalidClauseIds).toEqual(['c']);
  });

  it('validates date values and date ranges', () => {
    expect(normalizeResultFilterClauses([{ id: 'c', filterId: 'date', operator: 'before', value: '2026-10-01' }], definitions).invalidClauseIds).toEqual([]);
    expect(normalizeResultFilterClauses([{ id: 'c', filterId: 'date', operator: 'between', value: '2026-10-01', secondaryValue: '2026-10-31' }], definitions).invalidClauseIds).toEqual([]);
    expect(normalizeResultFilterClauses([{ id: 'c', filterId: 'date', operator: 'before', value: 'tomorrow' }], definitions).invalidClauseIds).toEqual(['c']);
  });

  it('validates choice membership', () => {
    expect(normalizeResultFilterClauses([{ id: 'c', filterId: 'district', operator: 'equals', value: 'cankaya' }], definitions).invalidClauseIds).toEqual([]);
    expect(normalizeResultFilterClauses([{ id: 'c', filterId: 'district', operator: 'equals', value: 'unknown' }], definitions).invalidClauseIds).toEqual(['c']);
  });

  it('drops clauses that reference unknown definitions', () => {
    expect(normalizeResultFilterClauses([{ id: 'c', filterId: 'missing', operator: 'equals', value: 'x' }], definitions).clauses).toEqual([]);
  });

  it('deduplicates clause identities', () => {
    const result = normalizeResultFilterClauses([{ id: 'c', filterId: 'name', operator: 'equals', value: 'a' }, { id: 'c', filterId: 'name', operator: 'equals', value: 'b' }], definitions);
    expect(result.clauses).toHaveLength(1);
    expect(result.clauses[0].value).toBe('a');
  });

  it('bounds clause cardinality', () => {
    const result = normalizeResultFilterClauses(Array.from({ length: 100 }, (_, index) => ({ id: `c-${index}`, filterId: 'name', operator: 'equals' as const, value: String(index) })), definitions);
    expect(result.clauses).toHaveLength(24);
  });

  it('creates accessible empty state labels', () => {
    const state = createResultFilterState({ definitions });
    expect(state.activeCount).toBe(0);
    expect(state.summary).toBe('Filtre yok');
    expect(state.clearLabel).toBe('Filtreleri temizle');
    expect(state.panelLabel).toBe('Sonuç filtreleri');
  });

  it('counts committed clauses independently from drafts', () => {
    const state = createResultFilterState({ definitions, clauses: [{ id: 'a', filterId: 'name', operator: 'contains', value: 'park' }], draftClauses: [{ id: 'a', filterId: 'name', operator: 'contains', value: 'school' }] });
    expect(state.activeCount).toBe(1);
    expect(state.dirty).toBe(true);
    expect(state.summary).toBe('1 etkin filtre');
  });

  it('keeps desktop filter presentation inline', () => {
    expect(createResultFilterState({ definitions, viewportWidth: 1400, panelOpen: true }).panelOpen).toBe(false);
  });

  it('allows compact filter panel on phone', () => {
    const state = createResultFilterState({ definitions, viewportWidth: 390, panelOpen: true });
    expect(state.viewport).toBe('phone');
    expect(state.panelOpen).toBe(true);
  });

  it('opens and closes filter panel without changing clauses', () => {
    const initial = createResultFilterState({ definitions, viewportWidth: 390 });
    const opened = reduceResultFilterState(initial, { type: 'open' });
    expect(opened.panelOpen).toBe(true);
    expect(reduceResultFilterState(opened, { type: 'close' }).panelOpen).toBe(false);
  });

  it('upserts draft clauses without committing prematurely', () => {
    const initial = createResultFilterState({ definitions, viewportWidth: 390 });
    const next = reduceResultFilterState(initial, { type: 'upsert', clause: { id: 'a', filterId: 'name', operator: 'contains', value: 'park' } });
    expect(next.clauses).toHaveLength(0);
    expect(next.draftClauses).toHaveLength(1);
    expect(next.dirty).toBe(true);
  });

  it('replaces an existing draft by stable identity', () => {
    let state = createResultFilterState({ definitions });
    state = reduceResultFilterState(state, { type: 'upsert', clause: { id: 'a', filterId: 'name', operator: 'contains', value: 'park' } });
    state = reduceResultFilterState(state, { type: 'upsert', clause: { id: 'a', filterId: 'name', operator: 'contains', value: 'school' } });
    expect(state.draftClauses).toHaveLength(1);
    expect(state.draftClauses[0].value).toBe('school');
  });

  it('removes a draft clause', () => {
    const initial = createResultFilterState({ definitions, draftClauses: [{ id: 'a', filterId: 'name', operator: 'contains', value: 'park' }] });
    expect(reduceResultFilterState(initial, { type: 'remove', clauseId: 'a' }).draftClauses).toHaveLength(0);
  });

  it('cancels draft edits and restores committed state', () => {
    const initial = createResultFilterState({ definitions, clauses: [{ id: 'a', filterId: 'name', operator: 'contains', value: 'park' }], draftClauses: [{ id: 'a', filterId: 'name', operator: 'contains', value: 'school' }], viewportWidth: 390, panelOpen: true });
    const next = reduceResultFilterState(initial, { type: 'cancel' });
    expect(next.draftClauses).toEqual(next.clauses);
    expect(next.dirty).toBe(false);
    expect(next.panelOpen).toBe(false);
  });

  it('refuses apply while draft contains validation errors', () => {
    const initial = createResultFilterState({ definitions, draftClauses: [{ id: 'a', filterId: 'count', operator: 'equals', value: 'NaN' }] });
    const next = reduceResultFilterState(initial, { type: 'apply' });
    expect(next).toBe(initial);
    expect(next.applyLabel).toContain('1 hata');
  });

  it('applies valid drafts atomically', () => {
    const initial = createResultFilterState({ definitions, draftClauses: [{ id: 'a', filterId: 'name', operator: 'contains', value: 'park' }], viewportWidth: 390, panelOpen: true });
    const next = reduceResultFilterState(initial, { type: 'apply' });
    expect(next.clauses).toHaveLength(1);
    expect(next.dirty).toBe(false);
    expect(next.panelOpen).toBe(false);
  });

  it('clears committed and draft filters together', () => {
    const initial = createResultFilterState({ definitions, clauses: [{ id: 'a', filterId: 'name', operator: 'contains', value: 'park' }] });
    const next = reduceResultFilterState(initial, { type: 'clear' });
    expect(next.clauses).toEqual([]);
    expect(next.draftClauses).toEqual([]);
    expect(next.activeCount).toBe(0);
  });

  it('announces pending draft changes', () => {
    const initial = createResultFilterState({ definitions });
    const next = reduceResultFilterState(initial, { type: 'upsert', clause: { id: 'a', filterId: 'name', operator: 'contains', value: 'park' } });
    expect(describeResultFilterChange(initial, next)).toBe('Filtre değişiklikleri uygulanmayı bekliyor');
  });

  it('announces applied filter count', () => {
    const initial = createResultFilterState({ definitions, draftClauses: [{ id: 'a', filterId: 'name', operator: 'contains', value: 'park' }] });
    const next = reduceResultFilterState(initial, { type: 'apply' });
    expect(describeResultFilterChange(initial, next)).toBe('1 filtre etkin');
  });

  it('announces clearing all filters', () => {
    const initial = createResultFilterState({ definitions, clauses: [{ id: 'a', filterId: 'name', operator: 'contains', value: 'park' }] });
    const next = reduceResultFilterState(initial, { type: 'clear' });
    expect(describeResultFilterChange(initial, next)).toBe('Tüm filtreler temizlendi');
  });

  it('does not invent announcements for no-op state', () => {
    const state = createResultFilterState({ definitions });
    expect(describeResultFilterChange(state, state)).toBe('');
  });
});
