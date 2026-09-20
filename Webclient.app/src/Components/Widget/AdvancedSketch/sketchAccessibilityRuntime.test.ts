import { describe, expect, it, vi } from 'vitest';
import {
  announceSketchStatus,
  createSketchLiveRegion,
  describeSketchTool,
  focusSketchToolbarItem,
  sketchToolFromShortcut,
  shouldHandleSketchShortcut,
  SKETCH_TOOL_DESCRIPTORS,
} from './sketchAccessibilityRuntime';

const keyboardEvent = (
  key: string,
  overrides: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'defaultPrevented'>> = {},
) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  ...overrides,
});

const shortcutTarget = (
  target: EventTarget | null,
  overrides: Partial<Pick<KeyboardEvent, 'isComposing' | 'defaultPrevented'>> = {},
) => ({
  target,
  isComposing: false,
  defaultPrevented: false,
  ...overrides,
});

describe('sketchAccessibilityRuntime', () => {
  it('defines every sketch tool exactly once', () => {
    const tools = SKETCH_TOOL_DESCRIPTORS.map((descriptor) => descriptor.tool);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toEqual(expect.arrayContaining([
      'move',
      'point',
      'polyline',
      'freehand',
      'polygon',
      'circle',
      'rectangle',
      'clear',
    ]));
  });

  it('keeps the destructive tool shortcut-free', () => {
    const clear = SKETCH_TOOL_DESCRIPTORS.find((descriptor) => descriptor.tool === 'clear');
    expect(clear).toEqual(expect.objectContaining({ destructive: true, shortcut: null }));
  });

  it('keeps drawing shortcuts unique', () => {
    const shortcuts = SKETCH_TOOL_DESCRIPTORS
      .map((descriptor) => descriptor.shortcut)
      .filter((shortcut): shortcut is string => shortcut !== null);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it('keeps every descriptor labelled and described for assistive technology', () => {
    for (const descriptor of SKETCH_TOOL_DESCRIPTORS) {
      expect(descriptor.label.trim().length).toBeGreaterThan(0);
      expect(descriptor.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('returns stable descriptions for tools', () => {
    expect(describeSketchTool('point')).toEqual(expect.objectContaining({
      label: 'Nokta',
      shortcut: 'P',
      destructive: false,
    }));
    expect(describeSketchTool('clear').destructive).toBe(true);
  });

  it.each([
    ['P', 'point'],
    ['p', 'point'],
    ['L', 'polyline'],
    ['f', 'freehand'],
    ['G', 'polygon'],
    ['c', 'circle'],
    ['R', 'rectangle'],
    ['V', 'move'],
  ])('maps shortcut %s to %s', (key, tool) => {
    expect(sketchToolFromShortcut(keyboardEvent(key))).toBe(tool);
  });

  it('normalizes surrounding whitespace in shortcut keys', () => {
    expect(sketchToolFromShortcut(keyboardEvent(' p '))).toBe('point');
  });

  it('returns null for unknown and empty shortcuts', () => {
    expect(sketchToolFromShortcut(keyboardEvent('X'))).toBeNull();
    expect(sketchToolFromShortcut(keyboardEvent('   '))).toBeNull();
  });

  it('does not expose shortcuts for unsupported legacy tools', () => {
    expect(sketchToolFromShortcut(keyboardEvent('T'))).toBeNull();
  });

  it.each([
    ['Alt', { altKey: true }],
    ['Control', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['handled', { defaultPrevented: true }],
  ])('ignores %s-modified or already handled shortcuts', (_name, overrides) => {
    expect(sketchToolFromShortcut(keyboardEvent('P', overrides))).toBeNull();
  });

  it.each(['input', 'textarea', 'select'])('does not intercept %s typing targets', (tagName) => {
    const element = document.createElement(tagName);
    expect(shouldHandleSketchShortcut(shortcutTarget(element))).toBe(false);
  });

  it('allows shortcuts from ordinary buttons', () => {
    const button = document.createElement('button');
    expect(shouldHandleSketchShortcut(shortcutTarget(button))).toBe(true);
  });

  it('does not intercept direct contenteditable targets', () => {
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.appendChild(editable);
    expect(shouldHandleSketchShortcut(shortcutTarget(editable))).toBe(false);
    editable.remove();
  });

  it('does not intercept plaintext-only contenteditable targets', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'plaintext-only');
    document.body.appendChild(editable);
    expect(shouldHandleSketchShortcut(shortcutTarget(editable))).toBe(false);
    editable.remove();
  });

  it('does not intercept an empty contenteditable attribute', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', '');
    document.body.appendChild(editable);
    expect(shouldHandleSketchShortcut(shortcutTarget(editable))).toBe(false);
    editable.remove();
  });

  it('does not intercept descendants of contenteditable surfaces', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editable.appendChild(child);
    document.body.appendChild(editable);
    expect(shouldHandleSketchShortcut(shortcutTarget(child))).toBe(false);
    editable.remove();
  });

  it('does not intercept deeply nested descendants of contenteditable surfaces', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const wrapper = document.createElement('span');
    const child = document.createElement('strong');
    wrapper.appendChild(child);
    editable.appendChild(wrapper);
    document.body.appendChild(editable);
    expect(shouldHandleSketchShortcut(shortcutTarget(child))).toBe(false);
    editable.remove();
  });

  it('allows shortcuts below an explicitly non-editable contenteditable boundary', () => {
    const surface = document.createElement('div');
    surface.setAttribute('contenteditable', 'false');
    const child = document.createElement('span');
    surface.appendChild(child);
    document.body.appendChild(surface);
    expect(shouldHandleSketchShortcut(shortcutTarget(child))).toBe(true);
    surface.remove();
  });

  it('ignores composing keyboard input', () => {
    const button = document.createElement('button');
    expect(shouldHandleSketchShortcut(shortcutTarget(button, { isComposing: true }))).toBe(false);
  });

  it('ignores already prevented keyboard input', () => {
    const button = document.createElement('button');
    expect(shouldHandleSketchShortcut(shortcutTarget(button, { defaultPrevented: true }))).toBe(false);
  });

  it('allows shortcuts when the event target is not an HTMLElement', () => {
    expect(shouldHandleSketchShortcut(shortcutTarget(document))).toBe(true);
    expect(shouldHandleSketchShortcut(shortcutTarget(null))).toBe(true);
  });

  it('creates and reuses one live region', () => {
    document.querySelector('#advanced-sketch-live-region')?.remove();
    const first = createSketchLiveRegion(document);
    const second = createSketchLiveRegion(document);
    expect(first).toBe(second);
    expect(first).toHaveAttribute('role', 'status');
    expect(first).toHaveAttribute('aria-live', 'polite');
    expect(first).toHaveAttribute('aria-atomic', 'true');
    expect(first).toHaveClass('visually-hidden');
    first.remove();
  });

  it('appends a newly created live region to the requested document body', () => {
    document.querySelector('#advanced-sketch-live-region')?.remove();
    const region = createSketchLiveRegion(document);
    expect(region.ownerDocument).toBe(document);
    expect(region.parentElement).toBe(document.body);
    region.remove();
  });

  it('reuses a pre-existing live region without duplicating it', () => {
    document.querySelector('#advanced-sketch-live-region')?.remove();
    const existing = document.createElement('div');
    existing.id = 'advanced-sketch-live-region';
    document.body.appendChild(existing);
    expect(createSketchLiveRegion(document)).toBe(existing);
    expect(document.querySelectorAll('#advanced-sketch-live-region')).toHaveLength(1);
    existing.remove();
  });

  it('announces polite status with atomic semantics', () => {
    const region = document.createElement('div');
    announceSketchStatus(region, 'Hazır');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toHaveTextContent('Hazır');
  });

  it('announces assertive failures', () => {
    const region = document.createElement('div');
    announceSketchStatus(region, 'Hata', true);
    expect(region).toHaveAttribute('role', 'alert');
    expect(region).toHaveAttribute('aria-live', 'assertive');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toHaveTextContent('Hata');
  });

  it('replaces rather than appends status messages', () => {
    const region = document.createElement('div');
    announceSketchStatus(region, 'Birinci');
    announceSketchStatus(region, 'İkinci');
    expect(region).toHaveTextContent('İkinci');
    expect(region.textContent).toBe('İkinci');
  });

  it('can downgrade an assertive region back to polite status', () => {
    const region = document.createElement('div');
    announceSketchStatus(region, 'Hata', true);
    announceSketchStatus(region, 'Hazır');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Hazır');
  });

  it('is a no-op when no live region is available', () => {
    expect(() => announceSketchStatus(null, 'Hazır')).not.toThrow();
  });

  it('moves roving toolbar focus forward with wrap-around', () => {
    const items = Array.from({ length: 3 }, () => document.createElement('button'));
    const focus = items[0]!.focus = vi.fn();
    expect(focusSketchToolbarItem(items, 2, 'next')).toBe(0);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(items.map((item) => item.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves roving toolbar focus backward with wrap-around', () => {
    const items = Array.from({ length: 3 }, () => document.createElement('button'));
    const focus = items[2]!.focus = vi.fn();
    expect(focusSketchToolbarItem(items, 0, 'previous')).toBe(2);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(items.map((item) => item.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('supports first and last roving focus commands', () => {
    const items = Array.from({ length: 4 }, () => document.createElement('button'));
    const firstFocus = items[0]!.focus = vi.fn();
    expect(focusSketchToolbarItem(items, 2, 'first')).toBe(0);
    expect(firstFocus).toHaveBeenCalledTimes(1);
    const lastFocus = items[3]!.focus = vi.fn();
    expect(focusSketchToolbarItem(items, 0, 'last')).toBe(3);
    expect(lastFocus).toHaveBeenCalledTimes(1);
  });

  it('normalizes a missing current toolbar index when moving next', () => {
    const items = Array.from({ length: 3 }, () => document.createElement('button'));
    expect(focusSketchToolbarItem(items, -1, 'next')).toBe(1);
    expect(items.map((item) => item.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('normalizes a missing current toolbar index when moving previous', () => {
    const items = Array.from({ length: 3 }, () => document.createElement('button'));
    expect(focusSketchToolbarItem(items, -1, 'previous')).toBe(2);
    expect(items.map((item) => item.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('keeps exactly one toolbar item in the tab sequence after repeated moves', () => {
    const items = Array.from({ length: 4 }, () => document.createElement('button'));
    let index = focusSketchToolbarItem(items, 0, 'next');
    index = focusSketchToolbarItem(items, index, 'next');
    index = focusSketchToolbarItem(items, index, 'previous');
    expect(index).toBe(1);
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it('focuses only the requested first item', () => {
    const items = Array.from({ length: 3 }, () => document.createElement('button'));
    items.forEach((item) => { item.focus = vi.fn(); });
    focusSketchToolbarItem(items, 2, 'first');
    expect(items[0]!.focus).toHaveBeenCalledTimes(1);
    expect(items[1]!.focus).not.toHaveBeenCalled();
    expect(items[2]!.focus).not.toHaveBeenCalled();
  });

  it('focuses only the requested last item', () => {
    const items = Array.from({ length: 3 }, () => document.createElement('button'));
    items.forEach((item) => { item.focus = vi.fn(); });
    focusSketchToolbarItem(items, 0, 'last');
    expect(items[0]!.focus).not.toHaveBeenCalled();
    expect(items[1]!.focus).not.toHaveBeenCalled();
    expect(items[2]!.focus).toHaveBeenCalledTimes(1);
  });

  it('returns -1 for an empty toolbar', () => {
    expect(focusSketchToolbarItem([], 0, 'next')).toBe(-1);
  });
});
