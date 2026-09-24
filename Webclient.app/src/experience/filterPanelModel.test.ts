import { describe, expect, it, vi } from 'vitest';
import { createFilterPanelModel, type FilterFieldDefinition } from './filterPanelModel';

const fields: readonly FilterFieldDefinition[] = [
  { id: 'name', label: 'Ad', type: 'text' },
  { id: 'population', label: 'Nüfus', type: 'number' },
  {
    id: 'district',
    label: 'İlçe',
    type: 'select',
    options: [
      { id: 'cankaya', label: 'Çankaya' },
      { id: 'kecioren', label: 'Keçiören' },
      { id: 'mamak', label: 'Mamak' },
    ],
  },
  { id: 'active', label: 'Aktif', type: 'boolean' },
  { id: 'updated', label: 'Güncelleme', type: 'date' },
];

describe('filterPanelModel', () => {
  it('starts empty and immutable', () => {
    const model = createFilterPanelModel({ fields });
    const snapshot = model.snapshot();
    expect(snapshot).toMatchObject({
      query: '',
      conjunction: 'and',
      activeCount: 0,
      invalidCount: 0,
      hasFilters: false,
      canApply: false,
      revision: 0,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.conditions)).toBe(true);
  });

  it('normalizes the free-text query and counts it as an active filter', () => {
    const model = createFilterPanelModel({ fields });
    model.setQuery('  kent   rehberi  ');
    expect(model.snapshot()).toMatchObject({
      query: 'kent rehberi',
      activeCount: 1,
      hasFilters: true,
      canApply: true,
    });
  });

  it('does not revise state for an equivalent normalized query', () => {
    const model = createFilterPanelModel({ fields });
    model.setQuery('ankara');
    const revision = model.snapshot().revision;
    model.setQuery('  ankara  ');
    expect(model.snapshot().revision).toBe(revision);
  });

  it('adds a valid text condition and creates an accessible summary', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({ id: 'name-filter', fieldId: 'name', operator: 'contains', value: '  park  ' });
    const condition = model.snapshot().conditions[0];
    expect(condition).toMatchObject({
      id: 'name-filter',
      fieldId: 'name',
      fieldLabel: 'Ad',
      operator: 'contains',
      operatorLabel: 'içerir',
      value: 'park',
      valid: true,
      error: null,
      summary: 'Ad içerir park',
    });
  });

  it('normalizes numeric filter values and rejects invalid numeric input as incomplete', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({ id: 'population', fieldId: 'population', operator: 'greater-than', value: '1000' });
    expect(model.snapshot().conditions[0]?.value).toBe(1000);
    model.updateCondition('population', { value: 'not-a-number' });
    expect(model.snapshot().conditions[0]).toMatchObject({ valid: false, error: 'Bir filtre değeri girin.' });
  });

  it('validates select values against declared options', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({ id: 'district', fieldId: 'district', operator: 'equals', value: 'cankaya' });
    expect(model.snapshot().conditions[0]?.summary).toBe('İlçe eşittir Çankaya');
    model.updateCondition('district', { value: 'unknown' });
    expect(model.snapshot().conditions[0]).toMatchObject({ valid: false, error: 'Geçersiz seçenek.' });
  });

  it('supports bounded multi-value select filters', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({
      id: 'districts',
      fieldId: 'district',
      operator: 'in',
      value: ['cankaya', 'kecioren'],
    });
    expect(model.snapshot().conditions[0]).toMatchObject({
      valid: true,
      summary: 'İlçe şunlardan biri Çankaya, Keçiören',
    });
  });

  it('treats is-empty operators as value-free and valid', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({ id: 'empty-name', fieldId: 'name', operator: 'is-empty', value: 'ignored' });
    expect(model.snapshot().conditions[0]).toMatchObject({
      value: null,
      valid: true,
      summary: 'Ad boş',
    });
  });

  it('supports boolean values with localized summaries', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({ id: 'active', fieldId: 'active', operator: 'equals', value: true });
    expect(model.snapshot().conditions[0]?.summary).toBe('Aktif eşittir Evet');
    model.updateCondition('active', { value: false });
    expect(model.snapshot().conditions[0]?.summary).toBe('Aktif eşittir Hayır');
  });

  it('tracks invalid conditions and apply eligibility', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({ id: 'incomplete', fieldId: 'name', operator: 'equals' });
    expect(model.snapshot()).toMatchObject({ activeCount: 1, invalidCount: 1, hasFilters: true, canApply: false });
    model.updateCondition('incomplete', { value: 'Ankara' });
    expect(model.snapshot()).toMatchObject({ invalidCount: 0, canApply: true });
  });

  it('switches conjunction without rewriting conditions', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({ id: 'a', fieldId: 'name', operator: 'contains', value: 'a' });
    model.addCondition({ id: 'b', fieldId: 'district', operator: 'equals', value: 'mamak' });
    model.setConjunction('or');
    expect(model.snapshot().conjunction).toBe('or');
    expect(model.snapshot().conditions.map((condition) => condition.id)).toEqual(['a', 'b']);
  });

  it('updates field, operator, and value as one normalized condition', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({ id: 'dynamic', fieldId: 'name', operator: 'contains', value: 'park' });
    expect(model.updateCondition('dynamic', {
      fieldId: 'population',
      operator: 'greater-or-equal',
      value: 5000,
    })).toBe(true);
    expect(model.snapshot().conditions[0]).toMatchObject({
      fieldId: 'population',
      operator: 'greater-or-equal',
      value: 5000,
      valid: true,
    });
  });

  it('reorders conditions with bounded keyboard-friendly movement', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({ id: 'a', fieldId: 'name', operator: 'contains', value: 'a' });
    model.addCondition({ id: 'b', fieldId: 'name', operator: 'contains', value: 'b' });
    model.addCondition({ id: 'c', fieldId: 'name', operator: 'contains', value: 'c' });
    expect(model.moveCondition('b', -1)).toBe(true);
    expect(model.snapshot().conditions.map((condition) => condition.id)).toEqual(['b', 'a', 'c']);
    expect(model.moveCondition('b', -1)).toBe(false);
    expect(model.moveCondition('c', 1)).toBe(false);
  });

  it('removes individual conditions and clears all filter state', () => {
    const model = createFilterPanelModel({ fields });
    model.setQuery('park');
    model.addCondition({ id: 'district', fieldId: 'district', operator: 'equals', value: 'cankaya' });
    expect(model.removeCondition('district')).toBe(true);
    expect(model.removeCondition('district')).toBe(false);
    expect(model.snapshot().activeCount).toBe(1);
    model.clear();
    expect(model.snapshot()).toMatchObject({ query: '', activeCount: 0, hasFilters: false, canApply: false });
  });

  it('enforces condition capacity', () => {
    const model = createFilterPanelModel({ fields, maxConditions: 2 });
    model.addCondition({ id: 'a', fieldId: 'name', operator: 'equals', value: 'a' });
    model.addCondition({ id: 'b', fieldId: 'name', operator: 'equals', value: 'b' });
    expect(() => model.addCondition({ id: 'c', fieldId: 'name', operator: 'equals', value: 'c' })).toThrow('capacity');
  });

  it('rejects duplicate conditions and unknown fields', () => {
    const model = createFilterPanelModel({ fields });
    model.addCondition({ id: 'same', fieldId: 'name', operator: 'equals', value: 'a' });
    expect(() => model.addCondition({ id: 'same', fieldId: 'name', operator: 'equals', value: 'b' })).toThrow('Duplicate');
    expect(() => model.addCondition({ id: 'missing', fieldId: 'unknown', operator: 'equals', value: 'x' })).toThrow('Unknown filter field');
  });

  it('rejects unsupported field/operator combinations', () => {
    const model = createFilterPanelModel({ fields });
    expect(() => model.addCondition({ id: 'bad', fieldId: 'population', operator: 'contains', value: 5 })).toThrow('Unsupported');
  });

  it('validates field definitions and select options', () => {
    expect(() => createFilterPanelModel({ fields: [] })).toThrow('At least one');
    expect(() => createFilterPanelModel({ fields: [{ id: 'x', label: 'X', type: 'select' }] })).toThrow('requires options');
    expect(() => createFilterPanelModel({ fields: [{ id: 'x', label: 'X', type: 'text' }, { id: 'x', label: 'Y', type: 'text' }] })).toThrow('Duplicate');
    expect(() => createFilterPanelModel({ fields: [{ id: 'x', label: 'X', type: 'number', operators: ['contains'] }] })).toThrow('not valid');
  });

  it('notifies subscribers immediately and on revisions', () => {
    const observer = vi.fn();
    const model = createFilterPanelModel({ fields });
    const unsubscribe = model.subscribe(observer);
    expect(observer).toHaveBeenCalledTimes(1);
    model.setQuery('ankara');
    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({ revision: 1, query: 'ankara' });
    unsubscribe();
    model.setQuery('izmir');
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('reports observer failures without replacing filter state', () => {
    const reporter = vi.fn();
    const model = createFilterPanelModel({ fields, onObserverError: reporter });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.setQuery('ankara')).not.toThrow();
    expect(reporter).toHaveBeenCalled();
    expect(model.snapshot().query).toBe('ankara');
  });
});
