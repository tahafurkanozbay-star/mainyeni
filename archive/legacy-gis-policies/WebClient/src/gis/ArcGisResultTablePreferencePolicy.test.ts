import { describe, expect, it } from 'vitest';
import {
  applyResultTableColumnMove,
  createArcGisResultTablePreferenceModel,
  resolveArcGisResultTableResize,
  resolveResultTablePreferenceKeyboardAction,
} from './ArcGisResultTablePreferencePolicy';

const columns = [
  { id: 'name', label: 'Ad', pinned: true, hideable: false, defaultWidth: 180 },
  { id: 'district', label: 'İlçe', defaultWidth: 140 },
  { id: 'type', label: 'Tür', minimumWidth: 96, maximumWidth: 260, defaultWidth: 120 },
  { id: 'address', label: 'Adres', defaultWidth: 240 },
] as const;

describe('ArcGisResultTablePreferencePolicy', () => {
  it('normalizes duplicate and hostile column definitions without losing pinned authority', () => {
    const model = createArcGisResultTablePreferenceModel([
      ...columns,
      { id: 'type', label: 'Duplicate' },
      { id: ' ', label: 'Empty' },
      { id: 'hostile', label: ' X '.repeat(100), minimumWidth: -500, maximumWidth: Number.POSITIVE_INFINITY },
    ], { hidden: ['name', 'type', 'type', 'missing'] }, 1280);

    expect(model.columns.map((column) => column.id)).toEqual(['name', 'district', 'type', 'address', 'hostile']);
    expect(model.columns[0].hidden).toBe(false);
    expect(model.hiddenColumnIds).toEqual(['type']);
    expect(model.columns.at(-1)?.minimumWidth).toBe(88);
    expect(model.columns.at(-1)?.maximumWidth).toBe(520);
  });

  it('keeps pinned columns ahead of user-reordered optional columns', () => {
    const model = createArcGisResultTablePreferenceModel(columns, {
      order: ['address', 'type', 'name', 'district'],
    }, 1280);
    expect(model.columns.map((column) => column.id)).toEqual(['name', 'address', 'type', 'district']);
    expect(model.canReset).toBe(true);
  });

  it('clamps persisted widths and ignores unknown preference keys', () => {
    const model = createArcGisResultTablePreferenceModel(columns, {
      widths: { type: 9999, district: -100, missing: 300 },
    }, 900);
    expect(model.columns.find((column) => column.id === 'type')?.width).toBe(260);
    expect(model.columns.find((column) => column.id === 'district')?.width).toBe(88);
    expect(model.viewport).toBe('tablet');
  });

  it('reports stable phone, tablet and desktop viewport contracts', () => {
    expect(createArcGisResultTablePreferenceModel(columns, {}, 639).viewport).toBe('phone');
    expect(createArcGisResultTablePreferenceModel(columns, {}, 640).viewport).toBe('tablet');
    expect(createArcGisResultTablePreferenceModel(columns, {}, 1023).viewport).toBe('tablet');
    expect(createArcGisResultTablePreferenceModel(columns, {}, 1024).viewport).toBe('desktop');
  });

  it('exposes bounded visibility announcements and reset state', () => {
    const defaultModel = createArcGisResultTablePreferenceModel(columns, {}, 1200);
    expect(defaultModel.announcement).toBe('4 sütunun tümü görünür.');
    expect(defaultModel.canReset).toBe(false);

    const customModel = createArcGisResultTablePreferenceModel(columns, { hidden: ['district'], density: 'compact' }, 1200);
    expect(customModel.announcement).toBe('3 sütun görünür, 1 sütun gizli.');
    expect(customModel.canReset).toBe(true);
  });

  it('clamps pointer resizing to declared column bounds', () => {
    expect(resolveArcGisResultTableResize({ columnId: 'type', startWidth: 120, delta: 1000, minimumWidth: 96, maximumWidth: 260 }).width).toBe(260);
    expect(resolveArcGisResultTableResize({ columnId: 'type', startWidth: 120, delta: -1000, minimumWidth: 96, maximumWidth: 260 }).width).toBe(96);
  });

  it('bounds a single keyboard resize step even with hostile deltas', () => {
    const resized = resolveArcGisResultTableResize({ columnId: 'type', startWidth: 120, delta: 999, minimumWidth: 96, maximumWidth: 260, keyboard: true });
    expect(resized.width).toBe(160);
    expect(resized.changed).toBe(true);
    expect(resized.announcement).toContain('160 piksel');
  });

  it('does not change width for non-finite resize deltas', () => {
    expect(resolveArcGisResultTableResize({ columnId: 'type', startWidth: 120, delta: Number.NaN }).width).toBe(120);
  });

  it('maps accessible keyboard preference actions deterministically', () => {
    expect(resolveResultTablePreferenceKeyboardAction('ArrowLeft', 'type', true)).toEqual({ type: 'move', columnId: 'type', delta: -1 });
    expect(resolveResultTablePreferenceKeyboardAction('ArrowRight', 'type', false, true)).toEqual({ type: 'resize', columnId: 'type', delta: 16 });
    expect(resolveResultTablePreferenceKeyboardAction('Delete', 'type')).toEqual({ type: 'toggle-visibility', columnId: 'type' });
    expect(resolveResultTablePreferenceKeyboardAction('Escape', 'type')).toEqual({ type: 'reset' });
    expect(resolveResultTablePreferenceKeyboardAction('a', 'type')).toBeNull();
  });

  it('moves optional columns only inside their pinned grouping', () => {
    const order = ['name', 'district', 'type', 'address'];
    expect(applyResultTableColumnMove(order, 'type', -1, ['name'])).toEqual(['name', 'type', 'district', 'address']);
    expect(applyResultTableColumnMove(order, 'district', -1, ['name'])).toEqual(order);
    expect(applyResultTableColumnMove(order, 'name', 1, ['name'])).toEqual(order);
  });

  it('returns immutable policy collections', () => {
    const model = createArcGisResultTablePreferenceModel(columns, { hidden: ['type'] }, 1200);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.columns)).toBe(true);
    expect(Object.isFrozen(model.visibleColumnIds)).toBe(true);
    expect(Object.isFrozen(model.hiddenColumnIds)).toBe(true);
  });
});
