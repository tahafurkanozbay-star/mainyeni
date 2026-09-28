import { describe, expect, test, vi } from 'vitest';
import {
  createCommandCenterInteractionModel,
  type CommandCenterItem,
  type CommandCenterState,
} from './commandCenterInteractionModel';

const item = (
  id: string,
  label: string,
  group = 'Harita',
  disabled = false,
): CommandCenterItem => ({
  id,
  label,
  group,
  description: `${label} açıklaması`,
  searchText: `${label} ${group} kent rehberi`,
  ...(disabled ? { disabled: true } : {}),
});

const inventory: readonly CommandCenterItem[] = [
  item('search', 'Genel arama', 'Arama'),
  item('layers', 'Katman yönetimi'),
  item('legend', 'Lejant'),
  item('measure', 'Ölçüm', 'Analiz'),
  item('disabled', 'Devre dışı', 'Yönetim', true),
];

describe('commandCenterInteractionModel lifecycle', () => {
  test('exposes bounded inventory facts independently from visible matches', () => {
    const model = createCommandCenterInteractionModel(inventory);
    expect(model.getInventoryFacts()).toEqual({
      submittedCount: 5,
      acceptedCount: 5,
      enabledCount: 4,
      disabledCount: 1,
      groupCount: 4,
      truncated: false,
    });
    expect(model.getState().matches).toHaveLength(4);
  });

  test('reports truncation when item capacity rejects submitted commands', () => {
    const model = createCommandCenterInteractionModel(inventory, { maxItems: 3 });
    expect(model.getInventoryFacts()).toEqual({
      submittedCount: 5,
      acceptedCount: 3,
      enabledCount: 3,
      disabledCount: 0,
      groupCount: 2,
      truncated: true,
    });
  });

  test('reports truncation when group capacity rejects a new group', () => {
    const model = createCommandCenterInteractionModel([
      item('a1', 'A1', 'A'),
      item('b1', 'B1', 'B'),
      item('c1', 'C1', 'C'),
      item('a2', 'A2', 'A'),
    ], { maxGroups: 2 });
    expect(model.getInventoryFacts()).toMatchObject({
      submittedCount: 4,
      acceptedCount: 3,
      groupCount: 2,
      truncated: true,
    });
  });

  test('removes control code points without relying on control-character regex literals', () => {
    const model = createCommandCenterInteractionModel([
      item('la\u0000yers', 'Kat\u0007man'),
    ]);
    expect(model.getItems()[0]?.id).toBe('la-yers');
    expect(model.getItems()[0]?.label).toBe('Kat man');
  });

  test('normalizes accents and Turkish dotted/dotless i for forgiving discovery', () => {
    const model = createCommandCenterInteractionModel([
      item('women', 'Kadın Danışma Merkezleri', 'Sosyal'),
      item('district', 'İlçe Sınırları', 'Harita'),
    ]);
    model.dispatch({ type: 'open' });
    expect(model.dispatch({ type: 'query', value: 'kadin danisma' }).matches[0]?.item.id).toBe('women');
    expect(model.dispatch({ type: 'query', value: 'ilce sinirlari' }).matches[0]?.item.id).toBe('district');
  });

  test('bounds text scans before normalization', () => {
    const model = createCommandCenterInteractionModel([
      item('large', 'A'.repeat(5000)),
    ]);
    expect(model.getItems()[0]?.label).toHaveLength(160);
    expect(model.getItems()[0]?.searchText.length).toBeLessThanOrEqual(1024);
  });

  test('finds a visible match by sanitized id', () => {
    const model = createCommandCenterInteractionModel(inventory);
    model.dispatch({ type: 'open' });
    expect(model.getMatch(' layers ')?.item.id).toBe('layers');
    expect(model.getMatch('missing')).toBeNull();
  });

  test('getMatch follows the current filtered result set', () => {
    const model = createCommandCenterInteractionModel(inventory);
    model.dispatch({ type: 'open' });
    model.dispatch({ type: 'query', value: 'ölçüm' });
    expect(model.getMatch('measure')?.item.label).toBe('Ölçüm');
    expect(model.getMatch('layers')).toBeNull();
  });

  test('subscribers receive the current state immediately', () => {
    const model = createCommandCenterInteractionModel(inventory);
    const observer = vi.fn();
    model.subscribe(observer);
    expect(observer).toHaveBeenCalledTimes(1);
    const [snapshot, previous] = observer.mock.calls[0] as [CommandCenterState, CommandCenterState];
    expect(snapshot).toBe(model.getState());
    expect(previous).toBe(snapshot);
  });

  test('subscribers receive previous state for every committed transition', () => {
    const model = createCommandCenterInteractionModel(inventory);
    const revisions: Array<[number, number]> = [];
    model.subscribe((snapshot, previous) => revisions.push([snapshot.revision, previous.revision]));
    model.dispatch({ type: 'open' });
    model.dispatch({ type: 'move', delta: 1 });
    model.dispatch({ type: 'query', value: 'katman' });
    expect(revisions).toEqual([[0, 0], [1, 0], [2, 1], [3, 2]]);
  });

  test('rejected activation does not notify observers', () => {
    const model = createCommandCenterInteractionModel(inventory);
    model.dispatch({ type: 'open' });
    const observer = vi.fn();
    model.subscribe(observer);
    model.dispatch({ type: 'activate', id: 'missing' });
    expect(observer).toHaveBeenCalledTimes(1);
  });

  test('zero movement does not manufacture a revision or notification', () => {
    const model = createCommandCenterInteractionModel(inventory);
    model.dispatch({ type: 'open' });
    const observer = vi.fn();
    model.subscribe(observer);
    const before = model.getState();
    const after = model.dispatch({ type: 'move', delta: 0 });
    expect(after).toBe(before);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  test('first and last are no-ops when already at the requested boundary', () => {
    const model = createCommandCenterInteractionModel(inventory);
    model.dispatch({ type: 'open' });
    const first = model.getState();
    expect(model.dispatch({ type: 'first' })).toBe(first);
    model.dispatch({ type: 'last' });
    const last = model.getState();
    expect(model.dispatch({ type: 'last' })).toBe(last);
  });

  test('subscriber release is idempotent', () => {
    const model = createCommandCenterInteractionModel(inventory);
    const observer = vi.fn();
    const release = model.subscribe(observer);
    release();
    release();
    model.dispatch({ type: 'open' });
    expect(observer).toHaveBeenCalledTimes(1);
  });

  test('isolates an immediate subscriber exception', () => {
    const errors: unknown[] = [];
    const model = createCommandCenterInteractionModel(inventory, {
      onObserverError: error => errors.push(error),
    });
    expect(() => model.subscribe(() => { throw new Error('initial observer'); })).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  test('isolates transition observer failures and still notifies healthy observers', () => {
    const errors: unknown[] = [];
    const healthy = vi.fn();
    const model = createCommandCenterInteractionModel(inventory, {
      onObserverError: error => errors.push(error),
    });
    model.subscribe(() => { throw new Error('observer'); });
    model.subscribe(healthy);
    model.dispatch({ type: 'open' });
    expect(errors).toHaveLength(2);
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  test('isolates a failing observer-error reporter', () => {
    const model = createCommandCenterInteractionModel(inventory, {
      onObserverError: () => { throw new Error('reporter'); },
    });
    model.subscribe(() => { throw new Error('observer'); });
    expect(() => model.dispatch({ type: 'open' })).not.toThrow();
    expect(model.getState().open).toBe(true);
  });

  test('bounds subscriber cardinality', () => {
    const model = createCommandCenterInteractionModel(inventory);
    const releases: Array<() => void> = [];
    for (let index = 0; index < 32; index += 1) {
      releases.push(model.subscribe(() => undefined));
    }
    expect(() => model.subscribe(() => undefined)).toThrow('observer capacity exceeded');
    releases.forEach(release => release());
  });

  test('items-changed refreshes inventory facts atomically', () => {
    const model = createCommandCenterInteractionModel(inventory);
    model.dispatch({ type: 'open' });
    const before = model.getInventoryFacts();
    model.dispatch({
      type: 'items-changed',
      items: [item('new', 'Yeni', 'Yeni grup'), item('off', 'Kapalı', 'Yeni grup', true)],
    });
    expect(model.getInventoryFacts()).not.toBe(before);
    expect(model.getInventoryFacts()).toEqual({
      submittedCount: 2,
      acceptedCount: 2,
      enabledCount: 1,
      disabledCount: 1,
      groupCount: 1,
      truncated: false,
    });
    expect(model.getState().matches.map(match => match.item.id)).toEqual(['new']);
  });

  test('items-changed preserves the display query while rematching normalized search text', () => {
    const model = createCommandCenterInteractionModel(inventory);
    model.dispatch({ type: 'open' });
    model.dispatch({ type: 'query', value: 'kadin' });
    const state = model.dispatch({
      type: 'items-changed',
      items: [item('women', 'Kadın Danışma', 'Sosyal')],
    });
    expect(state.query).toBe('kadin');
    expect(state.matches.map(match => match.item.id)).toEqual(['women']);
  });

  test('dispose is idempotent and makes later actions inert', () => {
    const model = createCommandCenterInteractionModel(inventory);
    model.dispatch({ type: 'open' });
    const before = model.getState();
    model.dispose();
    model.dispose();
    expect(model.dispatch({ type: 'query', value: 'katman' })).toBe(before);
    expect(model.dispatch({ type: 'close' })).toBe(before);
  });

  test('subscribe after dispose does not invoke observer', () => {
    const model = createCommandCenterInteractionModel(inventory);
    model.dispose();
    const observer = vi.fn();
    const release = model.subscribe(observer);
    expect(observer).not.toHaveBeenCalled();
    expect(() => release()).not.toThrow();
  });

  test('public inventory facts are immutable', () => {
    const model = createCommandCenterInteractionModel(inventory);
    expect(Object.isFrozen(model.getInventoryFacts())).toBe(true);
  });
});