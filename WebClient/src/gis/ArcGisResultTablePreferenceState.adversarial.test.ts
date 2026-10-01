import { describe, expect, it } from 'vitest';
import type { ResultTablePreferenceColumnInput } from './ArcGisResultTablePreferencePolicy';
import {
  normalizeResultTablePreferenceState,
  parseResultTablePreferenceState,
  reduceResultTablePreferenceState,
  serializeResultTablePreferenceState,
} from './ArcGisResultTablePreferenceState';

const columns: readonly ResultTablePreferenceColumnInput[] = [
  { id: 'identity', label: 'Kimlik', pinned: true, minimumWidth: 120, maximumWidth: 240, defaultWidth: 180 },
  { id: 'name', label: 'Ad', minimumWidth: 100, maximumWidth: 320, defaultWidth: 180 },
  { id: 'district', label: 'İlçe', minimumWidth: 100, maximumWidth: 260, defaultWidth: 140 },
];

describe('adversarial result-table preference state', () => {
  it('bounds column cardinality before persistence normalization', () => {
    const hostile = Array.from({ length: 1000 }, (_, index) => ({ id: `c-${index}`, label: `Sütun ${index}` }));
    const state = normalizeResultTablePreferenceState(hostile, { order: hostile.map((column) => column.id) });
    expect(state.order).toHaveLength(32);
  });

  it('does not allow whitespace aliases to create duplicate identities', () => {
    const state = normalizeResultTablePreferenceState([
      { id: 'name', label: 'Ad' },
      { id: ' name ', label: 'Takma ad' },
      { id: '\nname\t', label: 'Başka ad' },
    ], { hidden: [' name '] });
    expect(state.order).toEqual(['name']);
    expect(state.hidden).toEqual(['name']);
  });

  it('ignores prototype-shaped width keys that are not declared columns', () => {
    const state = normalizeResultTablePreferenceState(columns, {
      widths: JSON.parse('{"__proto__":300,"constructor":300,"name":210}') as Record<string, number>,
    });
    expect(state.widths).toEqual({ name: 210 });
  });

  it('normalizes infinite and fractional widths without leaking non-finite values', () => {
    const state = normalizeResultTablePreferenceState(columns, {
      widths: { identity: Number.POSITIVE_INFINITY, name: 171.9, district: Number.NEGATIVE_INFINITY },
    });
    expect(state.widths.identity).toBeUndefined();
    expect(state.widths.name).toBe(171);
    expect(state.widths.district).toBeUndefined();
  });

  it('keeps serialized preference payload deterministic for equivalent state', () => {
    const first = normalizeResultTablePreferenceState(columns, { hidden: ['district'], widths: { name: 200 } });
    const second = normalizeResultTablePreferenceState(columns, { widths: { name: 200 }, hidden: ['district'] });
    expect(serializeResultTablePreferenceState(first)).toBe(serializeResultTablePreferenceState(second));
  });

  it('does not restore data from primitive JSON payloads', () => {
    for (const payload of ['null', 'true', '42', '"text"', '[]']) {
      const state = parseResultTablePreferenceState(payload, columns);
      expect(state.order).toEqual(['identity', 'name', 'district']);
      expect(state.hidden).toEqual([]);
    }
  });

  it('preserves a visible identity column through repeated hostile transitions', () => {
    let state = normalizeResultTablePreferenceState(columns, {});
    for (let index = 0; index < 20; index += 1) {
      state = reduceResultTablePreferenceState(columns, state, { type: 'toggle-visibility', columnId: 'identity' }).state;
      state = reduceResultTablePreferenceState(columns, state, { type: 'move', columnId: 'identity', delta: 999 }).state;
    }
    expect(state.hidden).not.toContain('identity');
    expect(state.order[0]).toBe('identity');
  });

  it('keeps resize state bounded after repeated extreme pointer deltas', () => {
    let state = normalizeResultTablePreferenceState(columns, {});
    for (const delta of [100_000, 100_000, -100_000, -100_000, 100_000]) {
      state = reduceResultTablePreferenceState(columns, state, { type: 'resize', columnId: 'name', delta }).state;
    }
    expect(state.widths.name).toBeGreaterThanOrEqual(100);
    expect(state.widths.name).toBeLessThanOrEqual(320);
  });

  it('keeps focus recovery on the acted column for denied and accepted actions', () => {
    const initial = normalizeResultTablePreferenceState(columns, {});
    const denied = reduceResultTablePreferenceState(columns, initial, { type: 'toggle-visibility', columnId: 'identity' });
    const accepted = reduceResultTablePreferenceState(columns, initial, { type: 'toggle-visibility', columnId: 'district' });
    expect(denied.focusColumnId).toBe('identity');
    expect(accepted.focusColumnId).toBe('district');
  });

  it('does not mutate the previous state while reducing', () => {
    const initial = normalizeResultTablePreferenceState(columns, { hidden: ['district'], widths: { name: 190 } });
    const before = serializeResultTablePreferenceState(initial);
    const next = reduceResultTablePreferenceState(columns, initial, { type: 'resize', columnId: 'name', delta: 20 });
    expect(serializeResultTablePreferenceState(initial)).toBe(before);
    expect(next.state).not.toBe(initial);
    expect(next.state.widths.name).toBe(210);
  });
});
