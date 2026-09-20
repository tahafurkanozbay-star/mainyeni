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
    expect(sketchToolFromShortcut({
      key,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: false,
    })).toBe(tool);
  });

  it('does not expose shortcuts for unsupported legacy tools', () => {
    expect(sketchToolFromShortcut({
      key: 'T',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: false,
    })).toBeNull();
  });

  it('ignores modified and already handled shortcuts', () => {
    expect(sketchToolFromShortcut({
      key: 'P',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: false,
    })).toBeNull();
    expect(sketchToolFromShortcut({
      key: 'P',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: true,
    })).toBeNull();
  });

  it('does not intercept typing targets', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const button = document.createElement('button');

    expect(shouldHandleSketchShortcut({
      target: input,
      isComposing: false,
      defaultPrevented: false,
    })).toBe(false);
    expect(shouldHandleSketchShortcut({
      target: textarea,
      isComposing: false,
      defaultPrevented: false,
    })).toBe(false);
    expect(shouldHandleSketchShortcut({
      target: select,
      isComposing: false,
      defaultPrevented: false,
    })).toBe(false);
    expect(shouldHandleSketchShortcut({
      target: button,
      isComposing: false,
      defaultPrevented: false,
    })).toBe(true);
  });

  it('does not intercept contenteditable targets', () => {
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.appendChild(editable);
    expect(shouldHandleSketchShortcut({
      target: editable,
      isComposing: false,
      defaultPrevented: false,
    })).toBe(false);
    editable.remove();
  });

  it('creates and reuses one live region', () => {
    document.querySelector('#advanced-sketch-live-region')?.remove();
    const first = createSketchLiveRegion(document);
    const second = createSketchLiveRegion(document);
    expect(first).toBe(second);
    expect(first).toHaveAttribute('aria-live', 'polite');
    first.remove();
  });

  it('announces polite and assertive status', () => {
    const region = document.createElement('div');
    announceSketchStatus(region, 'Hazır');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveTextContent('Hazır');

    announceSketchStatus(region, 'Hata', true);
    expect(region).toHaveAttribute('role', 'alert');
    expect(region).toHaveAttribute('aria-live', 'assertive');
    expect(region).toHaveTextContent('Hata');
  });

  it('moves roving toolbar focus with wrap-around', () => {
    const items = Array.from({ length: 3 }, () => document.createElement('button'));
    const focus = items[0]!.focus = vi.fn();
    expect(focusSketchToolbarItem(items, 2, 'next')).toBe(0);
    expect(focus).toHaveBeenCalled();
    expect(items.map((item) => item.tabIndex)).toEqual([0, -1, -1]);

    expect(focusSketchToolbarItem(items, 0, 'previous')).toBe(2);
    expect(items.map((item) => item.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('supports first and last roving focus commands', () => {
    const items = Array.from({ length: 4 }, () => document.createElement('button'));
    expect(focusSketchToolbarItem(items, 2, 'first')).toBe(0);
    expect(focusSketchToolbarItem(items, 0, 'last')).toBe(3);
  });

  it('returns -1 for an empty toolbar', () => {
    expect(focusSketchToolbarItem([], 0, 'next')).toBe(-1);
  });
});
