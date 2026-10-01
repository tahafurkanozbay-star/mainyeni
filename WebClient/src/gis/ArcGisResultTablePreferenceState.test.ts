import { describe, expect, it } from 'vitest';
import type { ResultTablePreferenceColumnInput } from './ArcGisResultTablePreferencePolicy';
import {
  normalizeResultTablePreferenceState,
  parseResultTablePreferenceState,
  reduceResultTablePreferenceState,
  serializeResultTablePreferenceState,
} from './ArcGisResultTablePreferenceState';

const columns: readonly ResultTablePreferenceColumnInput[] = [
  { id: 'title', label: 'Başlık', pinned: true, hideable: false, minimumWidth: 120, maximumWidth: 420, defaultWidth: 220 },
  { id: 'category', label: 'Kategori', minimumWidth: 100, maximumWidth: 300, defaultWidth: 160 },
  { id: 'district', label: 'İlçe', minimumWidth: 100, maximumWidth: 280, defaultWidth: 140 },
  { id: 'address', label: 'Adres', minimumWidth: 140, maximumWidth: 520, defaultWidth: 260 },
] as const;

describe('result table preference persistence', () => {
  it('normalizes persisted order while appending newly introduced columns', () => {
    const state = normalizeResultTablePreferenceState(columns, { order: ['district', 'title'] });
    expect(state.order).toEqual(['district', 'title', 'category', 'address']);
  });

  it('drops duplicate, unknown and blank persisted identities', () => {
    const state = normalizeResultTablePreferenceState(columns, {
      order: ['district', ' district ', 'missing', '', 'title'],
      hidden: ['category', ' category ', 'missing'],
    });
    expect(state.order).toEqual(['district', 'title', 'category', 'address']);
    expect(state.hidden).toEqual(['category']);
  });

  it('never restores a hidden pinned or explicitly non-hideable column', () => {
    const state = normalizeResultTablePreferenceState(columns, { hidden: ['title', 'category'] });
    expect(state.hidden).toEqual(['category']);
  });

  it('bounds hostile persisted widths to per-column constraints', () => {
    const state = normalizeResultTablePreferenceState(columns, {
      widths: { title: -5000, category: 999999, district: Number.NaN, missing: 200 },
    });
    expect(state.widths.title).toBe(120);
    expect(state.widths.category).toBe(300);
    expect(state.widths.district).toBeUndefined();
    expect(state.widths.missing).toBeUndefined();
  });

  it('falls back to comfortable density for malformed values', () => {
    const state = normalizeResultTablePreferenceState(columns, { density: 'unexpected' as never });
    expect(state.density).toBe('comfortable');
  });

  it('round-trips the bounded versioned storage contract', () => {
    const original = normalizeResultTablePreferenceState(columns, {
      order: ['title', 'district', 'category', 'address'],
      hidden: ['address'],
      widths: { district: 180 },
      density: 'compact',
    });
    const restored = parseResultTablePreferenceState(serializeResultTablePreferenceState(original), columns);
    expect(restored).toEqual(original);
  });

  it('rejects future schema versions instead of guessing migration semantics', () => {
    const restored = parseResultTablePreferenceState(JSON.stringify({ version: 99, hidden: ['category'], density: 'compact' }), columns);
    expect(restored.hidden).toEqual([]);
    expect(restored.density).toBe('comfortable');
  });

  it('recovers from malformed JSON without throwing', () => {
    expect(() => parseResultTablePreferenceState('{not-json', columns)).not.toThrow();
    expect(parseResultTablePreferenceState('{not-json', columns).order).toEqual(columns.map((column) => column.id));
  });

  it('rejects oversized storage payloads before parsing', () => {
    const payload = JSON.stringify({ version: 1, density: 'compact', padding: 'x'.repeat(10_000) });
    expect(parseResultTablePreferenceState(payload, columns).density).toBe('comfortable');
  });

  it('returns deeply stable top-level state collections', () => {
    const state = normalizeResultTablePreferenceState(columns, { hidden: ['address'], widths: { title: 240 } });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.order)).toBe(true);
    expect(Object.isFrozen(state.hidden)).toBe(true);
    expect(Object.isFrozen(state.widths)).toBe(true);
  });
});

describe('result table preference transitions', () => {
  const initial = normalizeResultTablePreferenceState(columns, {});

  it('hides and restores an allowed column with deterministic focus recovery', () => {
    const hidden = reduceResultTablePreferenceState(columns, initial, { type: 'toggle-visibility', columnId: 'category' });
    expect(hidden.changed).toBe(true);
    expect(hidden.state.hidden).toEqual(['category']);
    expect(hidden.focusColumnId).toBe('category');
    expect(hidden.announcement).toBe('Kategori sütunu gizlendi.');
    const restored = reduceResultTablePreferenceState(columns, hidden.state, { type: 'toggle-visibility', columnId: 'category' });
    expect(restored.state.hidden).toEqual([]);
    expect(restored.announcement).toBe('Kategori sütunu gösterildi.');
  });

  it('denies hiding the pinned identity column', () => {
    const result = reduceResultTablePreferenceState(columns, initial, { type: 'toggle-visibility', columnId: 'title' });
    expect(result.changed).toBe(false);
    expect(result.state).toEqual(initial);
    expect(result.announcement).toContain('her zaman görünür');
  });

  it('moves unpinned columns without crossing the pinned group', () => {
    const moved = reduceResultTablePreferenceState(columns, initial, { type: 'move', columnId: 'district', delta: -1 });
    expect(moved.changed).toBe(true);
    expect(moved.state.order).toEqual(['title', 'district', 'category', 'address']);
    const bounded = reduceResultTablePreferenceState(columns, moved.state, { type: 'move', columnId: 'district', delta: -1 });
    expect(bounded.changed).toBe(false);
    expect(bounded.state.order[0]).toBe('title');
  });

  it('keeps pinned columns inside the pinned group', () => {
    const result = reduceResultTablePreferenceState(columns, initial, { type: 'move', columnId: 'title', delta: 1 });
    expect(result.changed).toBe(false);
    expect(result.state.order[0]).toBe('title');
  });

  it('applies bounded pointer resize transitions', () => {
    const result = reduceResultTablePreferenceState(columns, initial, { type: 'resize', columnId: 'category', delta: 5000 });
    expect(result.changed).toBe(true);
    expect(result.state.widths.category).toBe(300);
    expect(result.announcement).toContain('300 piksel');
  });

  it('applies bounded keyboard resize increments', () => {
    const result = reduceResultTablePreferenceState(columns, initial, { type: 'resize', columnId: 'category', delta: 999, keyboard: true });
    expect(result.state.widths.category).toBe(200);
  });

  it('reports a no-op at a resize boundary', () => {
    const atMaximum = normalizeResultTablePreferenceState(columns, { widths: { category: 300 } });
    const result = reduceResultTablePreferenceState(columns, atMaximum, { type: 'resize', columnId: 'category', delta: 20 });
    expect(result.changed).toBe(false);
    expect(result.announcement).toContain('genişlik sınırında');
  });

  it('switches density with a concise screen-reader announcement', () => {
    const compact = reduceResultTablePreferenceState(columns, initial, { type: 'density', density: 'compact' });
    expect(compact.changed).toBe(true);
    expect(compact.state.density).toBe('compact');
    expect(compact.announcement).toContain('Kompakt');
    const repeated = reduceResultTablePreferenceState(columns, compact.state, { type: 'density', density: 'compact' });
    expect(repeated.changed).toBe(false);
  });

  it('resets all customizations atomically', () => {
    const custom = normalizeResultTablePreferenceState(columns, {
      order: ['title', 'address', 'district', 'category'],
      hidden: ['address'],
      widths: { district: 210 },
      density: 'compact',
    });
    const result = reduceResultTablePreferenceState(columns, custom, { type: 'reset' });
    expect(result.changed).toBe(true);
    expect(result.state.order).toEqual(columns.map((column) => column.id));
    expect(result.state.hidden).toEqual([]);
    expect(result.state.widths).toEqual({});
    expect(result.state.density).toBe('comfortable');
    expect(result.focusColumnId).toBe('title');
  });

  it('reports reset as a no-op when already default', () => {
    const result = reduceResultTablePreferenceState(columns, initial, { type: 'reset' });
    expect(result.changed).toBe(false);
    expect(result.announcement).toContain('zaten varsayılan');
  });

  it('ignores unknown column actions without mutating state', () => {
    const result = reduceResultTablePreferenceState(columns, initial, { type: 'move', columnId: 'missing', delta: 1 });
    expect(result.changed).toBe(false);
    expect(result.state).toEqual(initial);
    expect(result.focusColumnId).toBeNull();
  });

  it('normalizes stale state before applying a transition', () => {
    const stale = {
      version: 1 as const,
      order: Object.freeze(['missing', 'category']),
      hidden: Object.freeze(['missing', 'title']),
      widths: Object.freeze({ missing: 999, category: 999 }),
      density: 'compact' as const,
    };
    const result = reduceResultTablePreferenceState(columns, stale, { type: 'toggle-visibility', columnId: 'district' });
    expect(result.state.order).toEqual(['category', 'title', 'district', 'address']);
    expect(result.state.hidden).toEqual(['district']);
    expect(result.state.widths).toEqual({ category: 300 });
  });
});
