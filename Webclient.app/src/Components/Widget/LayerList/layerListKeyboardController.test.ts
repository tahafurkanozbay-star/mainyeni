import { describe, expect, it, vi } from 'vitest';
import {
  createLayerListKeyboardController,
  evaluateLayerListKeyboardEvent,
  isLayerListEditableTarget,
} from './layerListKeyboardController';
import { LayerListExperienceModel, type LayerListGroupInput } from './layerListExperienceModel';

const GROUPS: readonly LayerListGroupInput[] = [{
  id: 'g',
  title: 'Grup',
  layers: [
    { id: 'a', title: 'A', visible: true, opacity: 100 },
    { id: 'b', title: 'B', visible: false, opacity: 80 },
  ],
}];

const key = (value: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...overrides });

describe('evaluateLayerListKeyboardEvent', () => {
  const model = new LayerListExperienceModel();
  model.replace(GROUPS);
  model.toggleGroup('g');
  const group = model.getSnapshot().rows[0]!;
  const layer = model.getSnapshot().rows[1]!;

  it.each([
    ['ArrowDown', 'move-next'],
    ['ArrowUp', 'move-previous'],
    ['ArrowLeft', 'move-parent'],
    ['ArrowRight', 'move-first-child'],
    ['Home', 'move-first'],
    ['End', 'move-last'],
    ['PageDown', 'move-page-next'],
    ['PageUp', 'move-page-previous'],
  ] as const)('maps %s to %s', (keyboardKey, intent) => {
    expect(evaluateLayerListKeyboardEvent({ key: keyboardKey }, group, false)).toEqual({
      intent,
      handled: true,
      preventDefault: true,
    });
  });

  it('maps Enter to group expansion', () => {
    expect(evaluateLayerListKeyboardEvent({ key: 'Enter' }, group, false).intent).toBe('toggle-expand');
  });

  it('maps Space to layer visibility', () => {
    expect(evaluateLayerListKeyboardEvent({ key: ' ' }, layer, false).intent).toBe('toggle-visibility');
  });

  it('does not activate a disabled row', () => {
    expect(evaluateLayerListKeyboardEvent({ key: 'Enter' }, { ...layer, disabled: true }, false).intent).toBe('none');
  });

  it('does not repeat activation', () => {
    expect(evaluateLayerListKeyboardEvent({ key: 'Enter', repeat: true }, layer, false).intent).toBe('none');
  });

  it('maps slash to search focus', () => {
    expect(evaluateLayerListKeyboardEvent({ key: '/' }, group, false).intent).toBe('focus-search');
  });

  it('maps Escape to clear query only when query exists', () => {
    expect(evaluateLayerListKeyboardEvent({ key: 'Escape' }, group, true).intent).toBe('clear-query');
    expect(evaluateLayerListKeyboardEvent({ key: 'Escape' }, group, false).intent).toBe('none');
  });

  it('fails closed for composing keyboard input', () => {
    expect(evaluateLayerListKeyboardEvent({ key: 'ArrowDown', isComposing: true }, group, false).handled).toBe(false);
  });

  it('fails closed after another handler prevented default', () => {
    expect(evaluateLayerListKeyboardEvent({ key: 'ArrowDown', defaultPrevented: true }, group, false).handled).toBe(false);
  });

  it('does not steal modifier shortcuts', () => {
    expect(evaluateLayerListKeyboardEvent({ key: 'ArrowDown', ctrlKey: true }, group, false).handled).toBe(false);
    expect(evaluateLayerListKeyboardEvent({ key: 'ArrowDown', metaKey: true }, group, false).handled).toBe(false);
    expect(evaluateLayerListKeyboardEvent({ key: 'ArrowDown', altKey: true }, group, false).handled).toBe(false);
  });
});

describe('isLayerListEditableTarget', () => {
  it('recognizes native text-entry controls', () => {
    expect(isLayerListEditableTarget(document.createElement('input'))).toBe(true);
    expect(isLayerListEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isLayerListEditableTarget(document.createElement('select'))).toBe(true);
  });

  it('recognizes contenteditable surfaces', () => {
    const target = document.createElement('div');
    target.contentEditable = 'true';
    Object.defineProperty(target, 'isContentEditable', { value: true });
    expect(isLayerListEditableTarget(target)).toBe(true);
  });

  it('rejects regular buttons and null targets', () => {
    expect(isLayerListEditableTarget(document.createElement('button'))).toBe(false);
    expect(isLayerListEditableTarget(null)).toBe(false);
  });
});

describe('createLayerListKeyboardController', () => {
  const createHarness = () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.toggleGroup('g');
    const focusSearch = vi.fn();
    const toggleVisibility = vi.fn();
    const controller = createLayerListKeyboardController(model, focusSearch, toggleVisibility);
    return { model, focusSearch, toggleVisibility, controller };
  };

  it('moves active rows and prevents native scrolling', () => {
    const { model, controller } = createHarness();
    const event = key('ArrowDown');
    controller.handleKeyDown(event, model.getSnapshot().rows[0]!, false);
    expect(event.defaultPrevented).toBe(true);
    expect(model.getSnapshot().activeKey).toBe('layer:g:a');
  });

  it('expands and collapses active groups with Enter', () => {
    const { model, controller } = createHarness();
    model.toggleGroup('g');
    const group = model.getSnapshot().rows[0]!;
    controller.handleKeyDown(key('Enter'), group, false);
    expect(model.getSnapshot().rows.map((row) => row.kind)).toEqual(['group', 'layer', 'layer']);
  });

  it('delegates layer visibility intent without mutating GIS state itself', () => {
    const { model, controller, toggleVisibility } = createHarness();
    const layer = model.getSnapshot().rows.find((row) => row.layerId === 'a')!;
    controller.handleKeyDown(key(' '), layer, false);
    expect(toggleVisibility).toHaveBeenCalledWith(layer);
    expect(model.getSnapshot().rows.find((row) => row.layerId === 'a')?.visible).toBe(true);
  });

  it('focuses search on slash', () => {
    const { model, controller, focusSearch } = createHarness();
    controller.handleKeyDown(key('/'), model.getSnapshot().rows[0]!, false);
    expect(focusSearch).toHaveBeenCalledTimes(1);
  });

  it('clears query on Escape', () => {
    const { model, controller } = createHarness();
    model.setQuery('a');
    controller.handleKeyDown(key('Escape'), model.getSnapshot().rows[0]!, true);
    expect(model.getSnapshot().query).toBe('');
  });

  it('leaves ordinary input typing alone', () => {
    const { model, controller, focusSearch } = createHarness();
    const input = document.createElement('input');
    const event = key('a');
    Object.defineProperty(event, 'target', { value: input });
    expect(controller.handleKeyDown(event, model.getSnapshot().rows[0]!, false)).toBe('none');
    expect(focusSearch).not.toHaveBeenCalled();
  });

  it('still lets Escape clear a layer query from search input', () => {
    const { model, controller } = createHarness();
    model.setQuery('a');
    const input = document.createElement('input');
    const event = key('Escape');
    Object.defineProperty(event, 'target', { value: input });
    controller.handleKeyDown(event, model.getSnapshot().rows[0]!, true);
    expect(model.getSnapshot().query).toBe('');
  });
});
