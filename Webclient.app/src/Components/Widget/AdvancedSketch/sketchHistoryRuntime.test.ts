import { describe, expect, it } from 'vitest';
import type { SketchGraphicSnapshot } from './sketchContracts';
import { createSketchHistoryRuntime } from './sketchHistoryRuntime';

const graphic = (id: string, updatedAt = 1): SketchGraphicSnapshot => Object.freeze({
  id,
  geometry: Object.freeze({
    type: 'point',
    spatialReferenceWkid: 4326,
    payload: Object.freeze({ x: 32.85, y: 39.92 }),
  }),
  attributes: Object.freeze({ name: id }),
  symbol: null,
  createdAt: 1,
  updatedAt,
});

describe('sketchHistoryRuntime', () => {
  it('records an initial state immediately', () => {
    const history = createSketchHistoryRuntime([graphic('a')], {
      now: () => 10,
      createId: () => 'initial',
    });
    expect(history.snapshot()).toEqual(expect.objectContaining({
      cursor: 0,
      size: 1,
      canUndo: false,
      canRedo: false,
    }));
    expect(history.current().map((item) => item.id)).toEqual(['a']);
  });

  it('records immutable snapshots', () => {
    const source = [graphic('a')];
    const history = createSketchHistoryRuntime(source);
    history.record('second', [graphic('b')]);
    source.push(graphic('mutated'));
    expect(history.undo()?.map((item) => item.id)).toEqual(['a']);
  });

  it('supports undo and redo', () => {
    const history = createSketchHistoryRuntime([]);
    history.record('one', [graphic('a')]);
    history.record('two', [graphic('a'), graphic('b')]);
    expect(history.snapshot().canUndo).toBe(true);

    expect(history.undo()?.map((item) => item.id)).toEqual(['a']);
    expect(history.snapshot().canRedo).toBe(true);
    expect(history.redo()?.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('returns null when undo and redo are unavailable', () => {
    const history = createSketchHistoryRuntime([]);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });

  it('drops future history after recording from an undone state', () => {
    let sequence = 0;
    const history = createSketchHistoryRuntime([], {
      createId: () => `h-${++sequence}`,
    });
    history.record('one', [graphic('a')]);
    history.record('two', [graphic('b')]);
    history.undo();
    history.record('replacement', [graphic('c')]);

    expect(history.snapshot().canRedo).toBe(false);
    expect(history.current().map((item) => item.id)).toEqual(['c']);
    expect(history.snapshot().entries.at(-1)?.label).toBe('replacement');
  });

  it('caps history entries and keeps the cursor valid', () => {
    let sequence = 0;
    const history = createSketchHistoryRuntime([], {
      maxEntries: 3,
      createId: () => `h-${++sequence}`,
    });
    history.record('one', [graphic('1')]);
    history.record('two', [graphic('2')]);
    history.record('three', [graphic('3')]);
    history.record('four', [graphic('4')]);

    expect(history.snapshot().size).toBe(3);
    expect(history.current().map((item) => item.id)).toEqual(['4']);
    expect(history.undo()?.map((item) => item.id)).toEqual(['3']);
  });

  it('normalizes too-small and too-large entry limits', () => {
    const small = createSketchHistoryRuntime([], { maxEntries: 0 });
    for (let index = 0; index < 8; index += 1) {
      small.record(`state-${index}`, [graphic(String(index))]);
    }
    expect(small.snapshot().size).toBe(2);

    const large = createSketchHistoryRuntime([], { maxEntries: 9_999 });
    for (let index = 0; index < 520; index += 1) {
      large.record(`state-${index}`, [graphic(String(index))]);
    }
    expect(large.snapshot().size).toBe(512);
  });

  it('replace rewrites the active entry without increasing size', () => {
    const history = createSketchHistoryRuntime([graphic('a')]);
    const before = history.snapshot().size;
    history.replace('replaced', [graphic('b')]);
    expect(history.snapshot().size).toBe(before);
    expect(history.snapshot().entries.at(-1)?.label).toBe('replaced');
    expect(history.current().map((item) => item.id)).toEqual(['b']);
  });

  it('clear removes all history', () => {
    const history = createSketchHistoryRuntime([graphic('a')]);
    history.record('second', [graphic('b')]);
    expect(history.clear()).toEqual(expect.objectContaining({
      cursor: -1,
      size: 0,
      canUndo: false,
      canRedo: false,
    }));
    expect(history.current()).toEqual([]);
  });

  it('truncates very long labels', () => {
    const history = createSketchHistoryRuntime([]);
    history.record('x'.repeat(1_000), []);
    expect(history.snapshot().entries.at(-1)?.label).toHaveLength(120);
  });

  it('uses injected timestamps', () => {
    const history = createSketchHistoryRuntime([], { now: () => 42 });
    history.record('state', []);
    expect(history.snapshot().entries.at(-1)?.timestamp).toBe(42);
  });

  it('preserves graphic timestamps across history movement', () => {
    const history = createSketchHistoryRuntime([graphic('a', 11)]);
    history.record('updated', [graphic('a', 12)]);
    expect(history.undo()?.[0]?.updatedAt).toBe(11);
    expect(history.redo()?.[0]?.updatedAt).toBe(12);
  });
});
