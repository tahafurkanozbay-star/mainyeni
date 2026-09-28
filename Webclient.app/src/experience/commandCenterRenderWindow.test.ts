import { describe, expect, test } from 'vitest';
import { createCommandCenterRenderWindow, isCommandCenterResultRendered } from './commandCenterRenderWindow';
import { createCommandCenterInteractionModel, type CommandCenterItem } from './commandCenterInteractionModel';

const item = (index: number): CommandCenterItem => ({
  id: `command-${index}`,
  group: index % 2 === 0 ? 'Harita' : 'Analiz',
  label: `Komut ${index}`,
  description: `Komut ${index} açıklaması`,
  searchText: `komut ${index} harita analiz`,
});

const setup = (count = 40) => {
  const model = createCommandCenterInteractionModel(
    Array.from({ length: count }, (_, index) => item(index)),
  );
  model.dispatch({ type: 'open' });
  return model;
};

describe('commandCenterRenderWindow', () => {
  test('returns an empty frozen window for empty results', () => {
    const model = setup();
    model.dispatch({ type: 'query', value: 'eşleşmeyen' });
    const window = createCommandCenterRenderWindow(model.getState());
    expect(window).toEqual({
      startIndex: 0,
      endIndex: 0,
      totalCount: 0,
      hiddenBefore: 0,
      hiddenAfter: 0,
      options: [],
    });
    expect(Object.isFrozen(window)).toBe(true);
    expect(Object.isFrozen(window.options)).toBe(true);
  });

  test('renders all results when below the bounded window size', () => {
    const model = setup(5);
    const window = createCommandCenterRenderWindow(model.getState(), { maxRendered: 10 });
    expect(window.startIndex).toBe(0);
    expect(window.endIndex).toBe(5);
    expect(window.hiddenBefore).toBe(0);
    expect(window.hiddenAfter).toBe(0);
    expect(window.options.map(option => option.commandId)).toEqual([
      'command-0', 'command-1', 'command-2', 'command-3', 'command-4',
    ]);
  });

  test('bounds the initial DOM result count for large inventories', () => {
    const model = setup(80);
    const window = createCommandCenterRenderWindow(model.getState(), {
      maxRendered: 12,
      overscan: 2,
    });
    expect(window.options.length).toBeLessThanOrEqual(14);
    expect(window.totalCount).toBe(80);
    expect(window.options[0]?.commandId).toBe('command-0');
    expect(window.hiddenAfter).toBeGreaterThan(0);
  });

  test('moves the render window around a middle active item', () => {
    const model = setup(60);
    model.dispatch({ type: 'activate', id: 'command-30' });
    const window = createCommandCenterRenderWindow(model.getState(), {
      maxRendered: 10,
      overscan: 2,
    });
    expect(window.startIndex).toBeLessThan(30);
    expect(window.endIndex).toBeGreaterThan(30);
    expect(window.options.some(option => option.commandId === 'command-30' && option.active)).toBe(true);
    expect(window.hiddenBefore).toBeGreaterThan(0);
    expect(window.hiddenAfter).toBeGreaterThan(0);
  });

  test('keeps the last item visible without running past the result set', () => {
    const model = setup(33);
    model.dispatch({ type: 'last' });
    const window = createCommandCenterRenderWindow(model.getState(), {
      maxRendered: 8,
      overscan: 3,
    });
    expect(window.endIndex).toBe(33);
    expect(window.hiddenAfter).toBe(0);
    expect(window.options.at(-1)?.commandId).toBe('command-32');
    expect(window.options.at(-1)?.active).toBe(true);
  });

  test('keeps first item visible after wrapping navigation', () => {
    const model = setup(30);
    model.dispatch({ type: 'move', delta: -1 });
    model.dispatch({ type: 'move', delta: 1 });
    const window = createCommandCenterRenderWindow(model.getState(), {
      maxRendered: 8,
      overscan: 1,
    });
    expect(model.getState().activeId).toBe('command-0');
    expect(window.startIndex).toBe(0);
    expect(window.options[0]?.active).toBe(true);
  });

  test('publishes absolute aria positions independent of window offset', () => {
    const model = setup(50);
    model.dispatch({ type: 'activate', id: 'command-25' });
    const window = createCommandCenterRenderWindow(model.getState(), {
      maxRendered: 6,
      overscan: 0,
    });
    expect(window.options[0]?.position).toBe(window.startIndex + 1);
    expect(window.options.every(option => option.setSize === 50)).toBe(true);
    expect(window.options.find(option => option.commandId === 'command-25')?.position).toBe(26);
  });

  test('clamps unsafe maxRendered and overscan values', () => {
    const model = setup(100);
    const tiny = createCommandCenterRenderWindow(model.getState(), {
      maxRendered: -1,
      overscan: -10,
    });
    expect(tiny.options).toHaveLength(4);

    const large = createCommandCenterRenderWindow(model.getState(), {
      maxRendered: 999,
      overscan: 999,
    });
    expect(large.options.length).toBeLessThanOrEqual(80);
  });

  test('falls back to the first window when active id disappears', () => {
    const model = setup(24);
    model.dispatch({ type: 'activate', id: 'command-12' });
    model.dispatch({ type: 'query', value: 'eşleşmeyen' });
    model.dispatch({ type: 'items-changed', items: [item(100), item(101), item(102), item(103)] });
    model.dispatch({ type: 'open' });
    const window = createCommandCenterRenderWindow(model.getState(), { maxRendered: 4 });
    expect(window.startIndex).toBe(0);
    expect(window.options[0]?.commandId).toBe('command-100');
  });

  test('tracks whether a command is currently rendered', () => {
    const model = setup(40);
    model.dispatch({ type: 'activate', id: 'command-20' });
    const window = createCommandCenterRenderWindow(model.getState(), { maxRendered: 8 });
    expect(isCommandCenterResultRendered(window, 'command-20')).toBe(true);
    expect(isCommandCenterResultRendered(window, 'command-0')).toBe(false);
    expect(isCommandCenterResultRendered(window, null)).toBe(false);
  });

  test('keeps option snapshots frozen', () => {
    const model = setup(20);
    const window = createCommandCenterRenderWindow(model.getState());
    expect(Object.isFrozen(window.options)).toBe(true);
    expect(Object.isFrozen(window.options[0])).toBe(true);
  });

  test('supports query-filtered windows without losing full set size facts', () => {
    const model = createCommandCenterInteractionModel([
      ...Array.from({ length: 20 }, (_, index) => ({
        ...item(index),
        searchText: `ortak komut ${index}`,
      })),
      {
        ...item(99),
        label: 'Tekil ölçüm',
        searchText: 'tekil ölçüm analiz',
      },
    ]);
    model.dispatch({ type: 'open' });
    model.dispatch({ type: 'query', value: 'ortak' });
    model.dispatch({ type: 'activate', id: 'command-12' });
    const window = createCommandCenterRenderWindow(model.getState(), { maxRendered: 7 });
    expect(window.totalCount).toBe(20);
    expect(window.options.find(option => option.commandId === 'command-12')?.setSize).toBe(20);
  });
});