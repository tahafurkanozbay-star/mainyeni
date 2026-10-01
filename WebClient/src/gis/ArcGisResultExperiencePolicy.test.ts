import { describe, expect, it } from 'vitest';
import {
  createArcGisResultExperienceModel,
  describeResultSort,
  resolveNextResultIndex,
  resolveResultKeyboardIntent,
  type ArcGisResultExperienceInput,
} from './ArcGisResultExperiencePolicy';

const columns = [
  { id: 'title', label: 'Ad', sortable: true, priority: 1 },
  { id: 'category', label: 'Kategori', sortable: true, priority: 2 },
  { id: 'population', label: 'Nüfus', attribute: 'population', sortable: true, priority: 3 },
] as const;

const records = [
  {
    objectId: 10,
    title: 'Gençlik Parkı',
    subtitle: 'Altındağ',
    category: 'Park',
    description: 'Kent merkezi yeşil alanı',
    attributes: { population: 12500, hidden: 'secret' },
  },
  {
    objectId: 11,
    title: 'Kuğulu Park',
    subtitle: 'Çankaya',
    category: 'Park',
    attributes: { population: 8200 },
  },
] as const;

const readyInput = (overrides: Partial<ArcGisResultExperienceInput> = {}): ArcGisResultExperienceInput => ({
  records,
  columns,
  status: 'ready',
  totalCount: 2,
  page: 1,
  pageSize: 25,
  ...overrides,
});

describe('createArcGisResultExperienceModel', () => {
  it('builds deterministic list rows with accessible position metadata', () => {
    const model = createArcGisResultExperienceModel(readyInput());
    expect(model.layout).toBe('list');
    expect(model.density).toBe('comfortable');
    expect(model.rows).toHaveLength(2);
    expect(model.rows[0]).toMatchObject({
      objectId: 10,
      title: 'Gençlik Parkı',
      category: 'Park',
      positionInSet: 1,
      setSize: 2,
      selected: false,
    });
    expect(model.rows[0].accessibleName).toContain('Gençlik Parkı');
    expect(model.rows[0].accessibleName).toContain('1 / 2');
  });

  it('preserves string and numeric object ids as distinct identities', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      records: [
        { objectId: 7, title: 'Numeric' },
        { objectId: '7', title: 'String' },
      ],
      totalCount: 2,
    }));
    expect(model.rows.map((row) => row.key)).toEqual(['number:7', 'string:7']);
  });

  it('deduplicates repeated identities without creating duplicate focus targets', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      records: [
        { objectId: 7, title: 'First' },
        { objectId: 7, title: 'Duplicate' },
        { objectId: 8, title: 'Second' },
      ],
      totalCount: 2,
    }));
    expect(model.rows.map((row) => row.title)).toEqual(['First', 'Second']);
    expect(model.rows.map((row) => row.positionInSet)).toEqual([1, 2]);
    expect(model.rows.every((row) => row.setSize === 2)).toBe(true);
  });

  it('marks exactly the selected row and exposes its stable index', () => {
    const model = createArcGisResultExperienceModel(readyInput({ selectedObjectId: 11 }));
    expect(model.rows.map((row) => row.selected)).toEqual([false, true]);
    expect(model.selection).toEqual({ objectId: 11, index: 1 });
    expect(model.rows[1].accessibleName).toContain('Seçili');
  });

  it('does not coerce string ids into numeric selection ids', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      records: [{ objectId: '11', title: 'String id' }],
      selectedObjectId: 11,
      totalCount: 1,
    }));
    expect(model.selection).toBeNull();
    expect(model.rows[0].selected).toBe(false);
  });

  it('normalizes whitespace and bounds user-facing text', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      query: '   park    alanları   ',
      records: [{ objectId: 1, title: `  ${'x'.repeat(300)}   ` }],
      totalCount: 1,
    }));
    expect(model.query).toBe('park alanları');
    expect(model.heading).toBe('“park alanları” için sonuçlar');
    expect(model.rows[0].title.length).toBeLessThanOrEqual(120);
    expect(model.rows[0].title.endsWith('…')).toBe(true);
  });

  it('never reflects unbounded server error content', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      status: 'error',
      errorMessage: `Server ${'failure '.repeat(100)}`,
    }));
    expect(model.errorTitle).toBe('Sonuçlar gösterilemiyor');
    expect(model.errorDescription?.length).toBeLessThanOrEqual(180);
    expect(model.announcement).toContain('yüklenemedi');
  });

  it('uses recovery guidance when an error has no safe message', () => {
    const model = createArcGisResultExperienceModel(readyInput({ status: 'error', errorMessage: '   ' }));
    expect(model.errorDescription).toBe('Bağlantıyı kontrol edip işlemi yeniden deneyin.');
  });

  it('converts a ready zero-count state into an explicit empty experience', () => {
    const model = createArcGisResultExperienceModel(readyInput({ records: [], totalCount: 0 }));
    expect(model.status).toBe('empty');
    expect(model.summary).toBe('Sonuç bulunamadı');
    expect(model.emptyTitle).toBe('Bu kapsamda sonuç yok');
    expect(model.emptyDescription).toContain('harita');
  });

  it('uses query-specific empty guidance without suggesting broad scans', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      records: [],
      totalCount: 0,
      query: 'müze',
    }));
    expect(model.emptyTitle).toBe('Eşleşen sonuç yok');
    expect(model.emptyDescription).toContain('Arama ifadenizi');
    expect(model.announcement).toBe('müze için sonuç bulunamadı.');
  });

  it('keeps loading state distinct from empty state', () => {
    const model = createArcGisResultExperienceModel(readyInput({ status: 'loading', records: [], totalCount: 0 }));
    expect(model.status).toBe('loading');
    expect(model.summary).toBe('Sonuçlar yükleniyor');
    expect(model.emptyTitle).toBeNull();
  });

  it('computes bounded pagination for large result counts', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      totalCount: 1001,
      page: 3,
      pageSize: 25,
    }));
    expect(model.pagination).toEqual({
      page: 3,
      pageSize: 25,
      totalCount: 1001,
      pageCount: 41,
      firstItem: 51,
      lastItem: 52,
      hasPrevious: true,
      hasNext: true,
      previousPage: 2,
      nextPage: 4,
    });
    expect(model.summary).toContain('51–52');
  });

  it('clamps invalid page sizes to the bounded policy', () => {
    const model = createArcGisResultExperienceModel(readyInput({ totalCount: 500, pageSize: 9999 }));
    expect(model.pagination.pageSize).toBe(200);
    expect(model.pagination.pageCount).toBe(3);
  });

  it('uses defaults for non-finite pagination values', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      page: Number.NaN,
      pageSize: Number.POSITIVE_INFINITY,
      totalCount: Number.NaN,
    }));
    expect(model.pagination.page).toBe(1);
    expect(model.pagination.pageSize).toBe(25);
    expect(model.pagination.totalCount).toBe(2);
  });

  it('clamps page to the available page count', () => {
    const model = createArcGisResultExperienceModel(readyInput({ totalCount: 50, pageSize: 25, page: 99 }));
    expect(model.pagination.page).toBe(2);
    expect(model.pagination.hasNext).toBe(false);
    expect(model.pagination.nextPage).toBeNull();
  });

  it('exposes previous and next page affordances only when meaningful', () => {
    const first = createArcGisResultExperienceModel(readyInput({ totalCount: 75, page: 1, pageSize: 25 }));
    const last = createArcGisResultExperienceModel(readyInput({ totalCount: 75, page: 3, pageSize: 25 }));
    expect(first.pagination.hasPrevious).toBe(false);
    expect(first.pagination.hasNext).toBe(true);
    expect(last.pagination.hasPrevious).toBe(true);
    expect(last.pagination.hasNext).toBe(false);
  });

  it('deduplicates columns by id and respects presentation priority', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      columns: [
        { id: 'category', label: 'Kategori', priority: 20 },
        { id: 'title', label: 'Ad', priority: 10 },
        { id: 'title', label: 'Duplicate', priority: 1 },
        { id: '', label: 'Invalid', priority: 0 },
      ],
    }));
    expect(model.columns.map((column) => column.id)).toEqual(['title', 'category']);
  });

  it('only projects explicitly configured attributes into cells', () => {
    const model = createArcGisResultExperienceModel(readyInput());
    expect(model.rows[0].cells).toEqual({
      title: 'Gençlik Parkı',
      category: 'Park',
      population: '12.500',
    });
    expect(model.rows[0].cells).not.toHaveProperty('hidden');
  });

  it('uses em dash for missing cell values', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      records: [{ objectId: 1, title: 'No population' }],
      totalCount: 1,
    }));
    expect(model.rows[0].cells.population).toBe('—');
  });

  it('formats booleans into localized accessible words', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      columns: [{ id: 'active', label: 'Aktif', attribute: 'active' }],
      records: [{ objectId: 1, title: 'A', attributes: { active: true } }],
      totalCount: 1,
    }));
    expect(model.rows[0].cells.active).toBe('Evet');
  });

  it('keeps table and compact density as explicit user presentation choices', () => {
    const model = createArcGisResultExperienceModel(readyInput({ layout: 'table', density: 'compact' }));
    expect(model.layout).toBe('table');
    expect(model.density).toBe('compact');
  });

  it('drops sort state when the column is not sortable', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      columns: [{ id: 'title', label: 'Ad', sortable: false }],
      sort: { columnId: 'title', direction: 'ascending' },
    }));
    expect(model.sort).toBeNull();
  });

  it('drops sort state when the column no longer exists', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      sort: { columnId: 'missing', direction: 'descending' },
    }));
    expect(model.sort).toBeNull();
  });

  it('preserves a valid sortable column and direction', () => {
    const model = createArcGisResultExperienceModel(readyInput({
      sort: { columnId: 'title', direction: 'descending' },
    }));
    expect(model.sort).toEqual({ columnId: 'title', direction: 'descending' });
  });

  it('freezes top-level model and row collections against accidental mutation', () => {
    const model = createArcGisResultExperienceModel(readyInput());
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.rows)).toBe(true);
    expect(Object.isFrozen(model.rows[0])).toBe(true);
    expect(Object.isFrozen(model.rows[0].cells)).toBe(true);
  });
});

describe('resolveResultKeyboardIntent', () => {
  it.each([
    ['ArrowDown', 'move', 1],
    ['ArrowUp', 'move', -1],
    ['Home', 'first', undefined],
    ['End', 'last', undefined],
    ['PageUp', 'page-previous', undefined],
    ['PageDown', 'page-next', undefined],
    ['Enter', 'activate', undefined],
    [' ', 'activate', undefined],
    ['Escape', 'clear-selection', undefined],
  ])('maps %s to %s', (key, type, delta) => {
    expect(resolveResultKeyboardIntent(key)).toEqual(delta === undefined ? { type } : { type, delta });
  });

  it('does not steal unrelated application shortcuts', () => {
    expect(resolveResultKeyboardIntent('k')).toBeNull();
    expect(resolveResultKeyboardIntent('a', true)).toBeNull();
    expect(resolveResultKeyboardIntent('a', false, true)).toBeNull();
  });
});

describe('resolveNextResultIndex', () => {
  it('moves within list bounds without wraparound surprises', () => {
    expect(resolveNextResultIndex(1, 3, { type: 'move', delta: 1 })).toBe(2);
    expect(resolveNextResultIndex(2, 3, { type: 'move', delta: 1 })).toBe(2);
    expect(resolveNextResultIndex(0, 3, { type: 'move', delta: -1 })).toBe(0);
  });

  it('moves directly to first and last items', () => {
    expect(resolveNextResultIndex(1, 4, { type: 'first' })).toBe(0);
    expect(resolveNextResultIndex(1, 4, { type: 'last' })).toBe(3);
  });

  it('returns null for an empty result set', () => {
    expect(resolveNextResultIndex(0, 0, { type: 'first' })).toBeNull();
  });

  it('keeps current focus for activation and pagination intents', () => {
    expect(resolveNextResultIndex(2, 4, { type: 'activate' })).toBe(2);
    expect(resolveNextResultIndex(2, 4, { type: 'page-next' })).toBe(2);
  });
});

describe('describeResultSort', () => {
  it('describes ascending sort in Turkish', () => {
    expect(describeResultSort({ columnId: 'title', direction: 'ascending' }, columns)).toBe('Ad: artan sıralama');
  });

  it('describes descending sort in Turkish', () => {
    expect(describeResultSort({ columnId: 'category', direction: 'descending' }, columns)).toBe('Kategori: azalan sıralama');
  });

  it('returns null for missing sort state or unknown columns', () => {
    expect(describeResultSort(null, columns)).toBeNull();
    expect(describeResultSort({ columnId: 'missing', direction: 'ascending' }, columns)).toBeNull();
  });
});
