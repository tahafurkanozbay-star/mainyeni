import { describe, expect, test } from 'vitest';
import {
  createCommandCenterInteractionModel,
  type CommandCenterItem,
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

const items: readonly CommandCenterItem[] = [
  item('search', 'Genel arama', 'Arama'),
  item('layers', 'Katman yönetimi'),
  item('legend', 'Lejant'),
  item('basemap', 'Altlık harita'),
  item('measure', 'Ölçüm', 'Analiz'),
  item('sketch', 'Çizim', 'Analiz'),
  item('disabled', 'Devre dışı', 'Yönetim', true),
];

describe('commandCenterInteractionModel', () => {
  test('starts closed with the first enabled command active', () => {
    const model = createCommandCenterInteractionModel(items);
    expect(model.getState()).toMatchObject({
      open: false,
      query: '',
      activeId: 'search',
      modality: 'programmatic',
      revision: 0,
    });
    expect(model.getState().matches.map(match => match.item.id)).toEqual([
      'search', 'layers', 'legend', 'basemap', 'measure', 'sketch',
    ]);
    expect(model.getState().announcement).toBe('6 komut kullanılabilir.');
  });

  test('opens with a fresh query and keyboard modality', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'query', value: 'ölçüm' });
    const state = model.dispatch({ type: 'open', modality: 'keyboard' });
    expect(state.open).toBe(true);
    expect(state.query).toBe('');
    expect(state.activeId).toBe('search');
    expect(state.modality).toBe('keyboard');
  });

  test('closes without discarding the bounded match snapshot', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    model.dispatch({ type: 'query', value: 'katman' });
    const before = model.getState().matches;
    const state = model.dispatch({ type: 'close', modality: 'pointer' });
    expect(state.open).toBe(false);
    expect(state.matches).toBe(before);
    expect(state.modality).toBe('pointer');
    expect(state.announcement).toBe('Komut merkezi kapatıldı.');
  });

  test('matches Turkish case folding deterministically', () => {
    const model = createCommandCenterInteractionModel([
      item('ilce', 'İlçe sorgusu', 'Arama'),
      item('isik', 'Işıklandırma', 'Hizmet'),
    ]);
    model.dispatch({ type: 'open' });
    expect(model.dispatch({ type: 'query', value: 'İLÇE' }).matches[0]?.item.id).toBe('ilce');
    expect(model.dispatch({ type: 'query', value: 'IŞIK' }).matches[0]?.item.id).toBe('isik');
  });

  test('requires every normalized query token to match', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    expect(model.dispatch({ type: 'query', value: 'katman harita' }).matches.map(match => match.item.id)).toEqual(['layers']);
    expect(model.dispatch({ type: 'query', value: 'katman analiz' }).matches).toHaveLength(0);
  });

  test('ranks exact and prefix label matches ahead of generic search text matches', () => {
    const model = createCommandCenterInteractionModel([
      item('generic', 'Harita aracı', 'Katman'),
      item('prefix', 'Katman görünümü'),
      item('exact', 'Katman'),
    ]);
    model.dispatch({ type: 'open' });
    expect(model.dispatch({ type: 'query', value: 'katman' }).matches.map(match => match.item.id)).toEqual([
      'exact', 'prefix', 'generic',
    ]);
  });

  test('preserves source order for equal-score matches', () => {
    const model = createCommandCenterInteractionModel([
      item('b', 'Ortak bir'),
      item('a', 'Ortak iki'),
      item('c', 'Ortak üç'),
    ]);
    model.dispatch({ type: 'open' });
    expect(model.dispatch({ type: 'query', value: 'ortak' }).matches.map(match => match.item.id)).toEqual(['b', 'a', 'c']);
  });

  test('moves forward and wraps at the end', () => {
    const model = createCommandCenterInteractionModel(items.slice(0, 3));
    model.dispatch({ type: 'open' });
    expect(model.dispatch({ type: 'move', delta: 1 }).activeId).toBe('layers');
    expect(model.dispatch({ type: 'move', delta: 1 }).activeId).toBe('legend');
    expect(model.dispatch({ type: 'move', delta: 1 }).activeId).toBe('search');
  });

  test('moves backward and wraps at the beginning', () => {
    const model = createCommandCenterInteractionModel(items.slice(0, 3));
    model.dispatch({ type: 'open' });
    expect(model.dispatch({ type: 'move', delta: -1 }).activeId).toBe('legend');
  });

  test('jumps to first and last results', () => {
    const model = createCommandCenterInteractionModel(items.slice(0, 4));
    model.dispatch({ type: 'open' });
    expect(model.dispatch({ type: 'last' }).activeId).toBe('basemap');
    expect(model.dispatch({ type: 'first' }).activeId).toBe('search');
  });

  test('uses a bounded page step in both directions', () => {
    const many = Array.from({ length: 20 }, (_, index) => item(`item-${index}`, `Komut ${index}`));
    const model = createCommandCenterInteractionModel(many, { pageStep: 5 });
    model.dispatch({ type: 'open' });
    expect(model.dispatch({ type: 'page-forward' }).activeId).toBe('item-5');
    expect(model.dispatch({ type: 'page-backward' }).activeId).toBe('item-0');
  });

  test('ignores activation ids outside the current result set', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    model.dispatch({ type: 'query', value: 'ölçüm' });
    const before = model.getState();
    const after = model.dispatch({ type: 'activate', id: 'layers', modality: 'pointer' });
    expect(after).toBe(before);
    expect(after.activeId).toBe('measure');
  });

  test('activates a visible result and records modality', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    const state = model.dispatch({ type: 'activate', id: 'legend', modality: 'pointer' });
    expect(state.activeId).toBe('legend');
    expect(state.modality).toBe('pointer');
  });

  test('reports whether the active command can execute only while open', () => {
    const model = createCommandCenterInteractionModel(items);
    expect(model.canExecuteActive()).toBe(false);
    model.dispatch({ type: 'open' });
    expect(model.canExecuteActive()).toBe(true);
    model.dispatch({ type: 'query', value: 'sonuç-yok' });
    expect(model.canExecuteActive()).toBe(false);
  });

  test('returns the active match without exposing disabled commands', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    model.dispatch({ type: 'last' });
    expect(model.getActiveMatch()?.item.id).toBe('sketch');
  });

  test('bounds item cardinality', () => {
    const many = Array.from({ length: 40 }, (_, index) => item(`item-${index}`, `Komut ${index}`));
    const model = createCommandCenterInteractionModel(many, { maxItems: 8 });
    expect(model.getItems()).toHaveLength(8);
    expect(model.getState().matches).toHaveLength(8);
  });

  test('deduplicates ids after sanitization', () => {
    const model = createCommandCenterInteractionModel([
      item('same id', 'Bir'),
      item('same-id', 'İki'),
      item('unique', 'Üç'),
    ]);
    expect(model.getItems().map(entry => entry.id)).toEqual(['same-id', 'unique']);
  });

  test('drops invalid empty ids and labels', () => {
    const model = createCommandCenterInteractionModel([
      item('', 'Boş kimlik'),
      item('empty-label', '   '),
      item('valid', 'Geçerli'),
    ]);
    expect(model.getItems().map(entry => entry.id)).toEqual(['valid']);
  });

  test('bounds distinct group cardinality without dropping existing-group items', () => {
    const model = createCommandCenterInteractionModel([
      item('a1', 'A1', 'A'),
      item('b1', 'B1', 'B'),
      item('c1', 'C1', 'C'),
      item('a2', 'A2', 'A'),
    ], { maxGroups: 2 });
    expect(model.getItems().map(entry => entry.id)).toEqual(['a1', 'b1', 'a2']);
  });

  test('bounds query length before matching and announcing', () => {
    const model = createCommandCenterInteractionModel(items, { maxQueryLength: 16 });
    model.dispatch({ type: 'open' });
    const state = model.dispatch({ type: 'query', value: 'x'.repeat(100) });
    expect(state.query).toHaveLength(16);
    expect(state.announcement).not.toContain('x'.repeat(17));
  });

  test('strips control characters from query state', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    const state = model.dispatch({ type: 'query', value: 'kat\u0000man\n' });
    expect(state.query).toBe('kat man ');
  });

  test('bounds query token count', () => {
    const model = createCommandCenterInteractionModel([
      item('all', 'a b c d e f g h i j'),
    ], { maxTokens: 3 });
    model.dispatch({ type: 'open' });
    const state = model.dispatch({ type: 'query', value: 'a b c missing' });
    expect(state.matches.map(match => match.item.id)).toEqual(['all']);
    expect(state.matches[0]?.matchedTokens).toEqual(['a', 'b', 'c']);
  });

  test('disabled commands never appear even for exact queries', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    expect(model.dispatch({ type: 'query', value: 'devre dışı' }).matches).toHaveLength(0);
  });

  test('updates items atomically while preserving a still-visible active command', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    model.dispatch({ type: 'activate', id: 'legend' });
    const state = model.dispatch({ type: 'items-changed', items: [item('legend', 'Lejant'), item('new', 'Yeni')] });
    expect(state.activeId).toBe('legend');
    expect(model.getItems().map(entry => entry.id)).toEqual(['legend', 'new']);
  });

  test('falls back to first result when active command disappears', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    model.dispatch({ type: 'activate', id: 'legend' });
    const state = model.dispatch({ type: 'items-changed', items: [item('new', 'Yeni'), item('other', 'Diğer')] });
    expect(state.activeId).toBe('new');
  });

  test('keeps current query when command inventory changes', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    model.dispatch({ type: 'query', value: 'katman' });
    const state = model.dispatch({
      type: 'items-changed',
      items: [item('layers-2', 'Katman kataloğu'), item('unrelated', 'Ölçüm')],
    });
    expect(state.query).toBe('katman');
    expect(state.matches.map(match => match.item.id)).toEqual(['layers-2']);
  });

  test('announces empty results without exposing unbounded content', () => {
    const model = createCommandCenterInteractionModel(items, { maxQueryLength: 20 });
    model.dispatch({ type: 'open' });
    const state = model.dispatch({ type: 'query', value: 'olmayan komut' });
    expect(state.announcement).toBe('“olmayan komut” için sonuç bulunamadı.');
  });

  test('increments revision for every accepted state transition', () => {
    const model = createCommandCenterInteractionModel(items);
    expect(model.dispatch({ type: 'open' }).revision).toBe(1);
    expect(model.dispatch({ type: 'move', delta: 1 }).revision).toBe(2);
    expect(model.dispatch({ type: 'query', value: 'harita' }).revision).toBe(3);
    expect(model.dispatch({ type: 'close' }).revision).toBe(4);
  });

  test('does not increment revision for rejected activation', () => {
    const model = createCommandCenterInteractionModel(items);
    model.dispatch({ type: 'open' });
    const revision = model.getState().revision;
    model.dispatch({ type: 'activate', id: 'missing' });
    expect(model.getState().revision).toBe(revision);
  });

  test('clamps unsafe numeric limits to deterministic safe ranges', () => {
    const model = createCommandCenterInteractionModel(items, {
      maxItems: Number.POSITIVE_INFINITY,
      maxQueryLength: -1,
      maxTokens: 9999,
      maxGroups: 0,
      pageStep: Number.NaN,
    });
    expect(model.limits).toEqual({
      maxItems: 1,
      maxQueryLength: 16,
      maxTokens: 32,
      maxGroups: 1,
      pageStep: 1,
    });
  });

  test('freezes public snapshots to discourage accidental mutation', () => {
    const model = createCommandCenterInteractionModel(items);
    expect(Object.isFrozen(model.limits)).toBe(true);
    expect(Object.isFrozen(model.getItems())).toBe(true);
    expect(Object.isFrozen(model.getState())).toBe(true);
    expect(Object.isFrozen(model.getState().matches)).toBe(true);
  });
});
