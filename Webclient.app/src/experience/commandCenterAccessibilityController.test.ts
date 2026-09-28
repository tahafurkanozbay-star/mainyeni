import { describe, expect, test, vi } from 'vitest';
import {
  createCommandCenterAccessibilityController,
  type CommandCenterKeyboardEventLike,
} from './commandCenterAccessibilityController';
import {
  createCommandCenterInteractionModel,
  type CommandCenterItem,
} from './commandCenterInteractionModel';

const item = (
  id: string,
  label: string,
  group = 'Harita',
): CommandCenterItem => ({
  id,
  label,
  group,
  description: `${label} açıklaması`,
  searchText: `${label} ${group} kent rehberi`,
});

const items: readonly CommandCenterItem[] = [
  item('search', 'Genel arama', 'Arama'),
  item('layers', 'Katmanlar'),
  item('legend', 'Lejant'),
  item('basemap', 'Altlık harita'),
  item('measure', 'Ölçüm', 'Analiz'),
  item('sketch', 'Çizim', 'Analiz'),
  item('bookmark', 'Yer imleri'),
  item('help', 'Yardım', 'Yardım'),
];

const keyboardEvent = (
  key: string,
  overrides: Partial<Omit<CommandCenterKeyboardEventLike, 'key' | 'preventDefault'>> = {},
): CommandCenterKeyboardEventLike & { readonly preventDefault: ReturnType<typeof vi.fn> } => {
  const preventDefault = vi.fn();
  return {
    key,
    preventDefault,
    ...overrides,
  };
};

const setup = (pageStep = 3) => {
  const model = createCommandCenterInteractionModel(items, { pageStep });
  const controller = createCommandCenterAccessibilityController(model, 'command center');
  return { model, controller };
};

describe('commandCenterAccessibilityController', () => {
  test('normalizes the DOM id prefix and exposes combobox/listbox facts', () => {
    const { controller } = setup();
    const snapshot = controller.snapshot();

    expect(controller.idPrefix).toBe('command-center');
    expect(snapshot.inputId).toBe('command-center-input');
    expect(snapshot.listboxId).toBe('command-center-results');
    expect(snapshot.statusId).toBe('command-center-status');
    expect(snapshot.resultCount).toBe(items.length);
    expect(snapshot.activeDescendant).toBe('command-center-item-search');
    expect(snapshot.activePosition).toBe(1);
  });

  test('creates deterministic option metadata for every visible match', () => {
    const { controller } = setup();
    const snapshot = controller.snapshot();

    expect(snapshot.options).toHaveLength(items.length);
    expect(snapshot.options[0]).toEqual({
      commandId: 'search',
      domId: 'command-center-item-search',
      label: 'Genel arama',
      group: 'Arama',
      description: 'Genel arama açıklaması',
      active: true,
      position: 1,
      setSize: 8,
      tabIndex: -1,
      ariaSelected: true,
    });
    expect(snapshot.options.at(-1)?.position).toBe(8);
    expect(snapshot.options.every(option => option.setSize === 8)).toBe(true);
  });

  test('opens through the model with caller modality', () => {
    const { controller, model } = setup();
    const result = controller.open('keyboard');

    expect(result.handled).toBe(true);
    expect(result.intent.type).toBe('none');
    expect(result.state.open).toBe(true);
    expect(result.state.modality).toBe('keyboard');
    expect(model.getState().query).toBe('');
  });

  test('closes an open command center and returns a closed intent', () => {
    const { controller } = setup();
    controller.open();
    const result = controller.close('pointer');

    expect(result.handled).toBe(true);
    expect(result.intent.type).toBe('closed');
    expect(result.state.open).toBe(false);
    expect(result.state.modality).toBe('pointer');
  });

  test('does not manufacture a close transition while already closed', () => {
    const { controller, model } = setup();
    const before = model.getState();
    const result = controller.close();

    expect(result.handled).toBe(false);
    expect(result.state).toBe(before);
    expect(result.intent.type).toBe('none');
  });

  test('updates query and active descendant together', () => {
    const { controller } = setup();
    controller.open('keyboard');
    const result = controller.query('ölçüm');

    expect(result.state.query).toBe('ölçüm');
    expect(result.snapshot.resultCount).toBe(1);
    expect(result.snapshot.activeDescendant).toBe('command-center-item-measure');
    expect(result.snapshot.options[0]?.commandId).toBe('measure');
  });

  test('activates a visible pointer target without executing it', () => {
    const { controller } = setup();
    controller.open();
    const result = controller.activate('legend', 'pointer');

    expect(result.state.activeId).toBe('legend');
    expect(result.state.modality).toBe('pointer');
    expect(result.intent.type).toBe('none');
    expect(result.snapshot.options.find(option => option.commandId === 'legend')?.active).toBe(true);
  });

  test('ignores activation outside the visible result set', () => {
    const { controller, model } = setup();
    controller.open();
    controller.query('ölçüm');
    const before = model.getState();
    const result = controller.activate('layers');

    expect(result.state).toBe(before);
    expect(result.snapshot.activeDescendant).toBe('command-center-item-measure');
  });

  test('ArrowDown moves active descendant and prevents browser default', () => {
    const { controller } = setup();
    controller.open('keyboard');
    const event = keyboardEvent('ArrowDown');
    const result = controller.handleKey(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.state.activeId).toBe('layers');
    expect(result.snapshot.activePosition).toBe(2);
  });

  test('ArrowUp wraps from first to last', () => {
    const { controller } = setup();
    controller.open('keyboard');
    const event = keyboardEvent('ArrowUp');
    const result = controller.handleKey(event);

    expect(result.state.activeId).toBe('help');
    expect(result.snapshot.activePosition).toBe(8);
  });

  test('Home and End move to deterministic boundaries', () => {
    const { controller } = setup();
    controller.open();
    controller.activate('measure');

    const home = keyboardEvent('Home');
    expect(controller.handleKey(home).state.activeId).toBe('search');
    expect(home.preventDefault).toHaveBeenCalledTimes(1);

    const end = keyboardEvent('End');
    expect(controller.handleKey(end).state.activeId).toBe('help');
    expect(end.preventDefault).toHaveBeenCalledTimes(1);
  });

  test('PageDown and PageUp use the model page step', () => {
    const { controller } = setup(3);
    controller.open();

    const down = keyboardEvent('PageDown');
    expect(controller.handleKey(down).state.activeId).toBe('basemap');

    const up = keyboardEvent('PageUp');
    expect(controller.handleKey(up).state.activeId).toBe('search');
  });

  test('Enter returns an execute intent without directly closing', () => {
    const { controller } = setup();
    controller.open();
    controller.activate('legend');
    const event = keyboardEvent('Enter');
    const result = controller.handleKey(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.intent).toEqual({ type: 'execute', commandId: 'legend' });
    expect(result.state.open).toBe(true);
  });

  test('Enter is ignored when the query has no active result', () => {
    const { controller } = setup();
    controller.open();
    controller.query('eşleşmeyen içerik');
    const event = keyboardEvent('Enter');
    const result = controller.handleKey(event);

    expect(result.handled).toBe(false);
    expect(result.intent.type).toBe('none');
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('Escape closes and prevents default only when open', () => {
    const { controller } = setup();
    const closedEvent = keyboardEvent('Escape');
    expect(controller.handleKey(closedEvent).handled).toBe(false);
    expect(closedEvent.preventDefault).not.toHaveBeenCalled();

    controller.open();
    const openEvent = keyboardEvent('Escape');
    const result = controller.handleKey(openEvent);
    expect(result.intent.type).toBe('closed');
    expect(result.state.open).toBe(false);
    expect(openEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  test('does not hijack modified navigation keys used by the browser or editor', () => {
    const { controller, model } = setup();
    controller.open();
    const before = model.getState();

    for (const event of [
      keyboardEvent('ArrowDown', { altKey: true }),
      keyboardEvent('ArrowDown', { ctrlKey: true }),
      keyboardEvent('ArrowDown', { metaKey: true }),
      keyboardEvent('ArrowDown', { shiftKey: true }),
      keyboardEvent('Home', { ctrlKey: true }),
      keyboardEvent('End', { metaKey: true }),
    ]) {
      const result = controller.handleKey(event);
      expect(result.handled).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }

    expect(model.getState()).toBe(before);
  });

  test('ignores composition, processed keys and already-prevented events', () => {
    const { controller, model } = setup();
    controller.open();
    const before = model.getState();

    const ignored = [
      keyboardEvent('ArrowDown', { isComposing: true }),
      keyboardEvent('ArrowDown', { defaultPrevented: true }),
      keyboardEvent('Dead'),
      keyboardEvent('Process'),
    ];

    for (const event of ignored) {
      expect(controller.handleKey(event).handled).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(model.getState()).toBe(before);
  });

  test('leaves ordinary text-editing keys to the input', () => {
    const { controller, model } = setup();
    controller.open();
    const before = model.getState();
    const event = keyboardEvent('a');
    const result = controller.handleKey(event);

    expect(result.handled).toBe(false);
    expect(result.state).toBe(before);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('updates option set size after filtering', () => {
    const { controller } = setup();
    controller.open();
    const result = controller.query('analiz');

    expect(result.snapshot.resultCount).toBe(2);
    expect(result.snapshot.options.map(option => option.commandId)).toEqual(['measure', 'sketch']);
    expect(result.snapshot.options.map(option => option.position)).toEqual([1, 2]);
    expect(result.snapshot.options.every(option => option.setSize === 2)).toBe(true);
  });

  test('removes active descendant when there are no results', () => {
    const { controller } = setup();
    controller.open();
    const result = controller.query('yok-yok-yok');

    expect(result.snapshot.resultCount).toBe(0);
    expect(result.snapshot.activeDescendant).toBeNull();
    expect(result.snapshot.activePosition).toBeNull();
    expect(result.snapshot.options).toEqual([]);
  });

  test('keeps snapshot objects frozen for safe React consumption', () => {
    const { controller } = setup();
    const snapshot = controller.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.options)).toBe(true);
    expect(Object.isFrozen(snapshot.options[0])).toBe(true);
  });

  test('keeps a safe fallback prefix for blank or punctuation-only ids', () => {
    const model = createCommandCenterInteractionModel(items);
    const controller = createCommandCenterAccessibilityController(model, ' !!! ');
    expect(controller.idPrefix).toBe('kr-command');
    expect(controller.snapshot().inputId).toBe('kr-command-input');
  });
});