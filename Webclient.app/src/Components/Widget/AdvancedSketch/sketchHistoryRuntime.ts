import type {
  SketchGraphicSnapshot,
  SketchHistoryEntry,
  SketchHistoryOptions,
  SketchHistoryRuntime,
  SketchHistorySnapshot,
} from './sketchContracts';
import { freezeArray } from './sketchContracts';

const DEFAULT_MAX_ENTRIES = 64;

const normalizeMaxEntries = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_ENTRIES;
  return Math.min(512, Math.max(2, Math.floor(numeric)));
};

const cloneGraphic = (graphic: SketchGraphicSnapshot): SketchGraphicSnapshot => Object.freeze({
  ...graphic,
  geometry: Object.freeze({
    ...graphic.geometry,
    payload: Object.freeze({ ...graphic.geometry.payload }),
  }),
  attributes: Object.freeze({ ...graphic.attributes }),
  symbol: graphic.symbol ? Object.freeze({ ...graphic.symbol }) : null,
});

const cloneGraphics = (graphics: readonly SketchGraphicSnapshot[]): readonly SketchGraphicSnapshot[] =>
  freezeArray(graphics.map(cloneGraphic));

const defaultId = (() => {
  let sequence = 0;
  return (): string => `sketch-history-${++sequence}`;
})();

export const createSketchHistoryRuntime = (
  initialGraphics: readonly SketchGraphicSnapshot[] = [],
  options: SketchHistoryOptions = {},
): SketchHistoryRuntime => {
  const maxEntries = normalizeMaxEntries(options.maxEntries);
  const now = options.now ?? Date.now;
  const createId = options.createId ?? defaultId;
  let entries: SketchHistoryEntry[] = [];
  let cursor = -1;

  const makeEntry = (label: string, graphics: readonly SketchGraphicSnapshot[]): SketchHistoryEntry =>
    Object.freeze({
      id: createId(),
      label: String(label || 'Sketch change').slice(0, 120),
      timestamp: now(),
      graphics: cloneGraphics(graphics),
    });

  const snapshot = (): SketchHistorySnapshot => Object.freeze({
    cursor,
    size: entries.length,
    canUndo: cursor > 0,
    canRedo: cursor >= 0 && cursor < entries.length - 1,
    entries: freezeArray(entries.map(({ id, label, timestamp }) => Object.freeze({ id, label, timestamp }))),
  });

  const trim = (): void => {
    if (entries.length <= maxEntries) return;
    const overflow = entries.length - maxEntries;
    entries = entries.slice(overflow);
    cursor = Math.max(0, cursor - overflow);
  };

  const record = (
    label: string,
    graphics: readonly SketchGraphicSnapshot[],
  ): SketchHistorySnapshot => {
    if (cursor < entries.length - 1) entries = entries.slice(0, cursor + 1);
    entries.push(makeEntry(label, graphics));
    cursor = entries.length - 1;
    trim();
    return snapshot();
  };

  const replace = (
    label: string,
    graphics: readonly SketchGraphicSnapshot[],
  ): SketchHistorySnapshot => {
    if (cursor < 0) return record(label, graphics);
    entries[cursor] = makeEntry(label, graphics);
    return snapshot();
  };

  const current = (): readonly SketchGraphicSnapshot[] =>
    cursor >= 0 ? entries[cursor]?.graphics ?? freezeArray([]) : freezeArray([]);

  const undo = (): readonly SketchGraphicSnapshot[] | null => {
    if (cursor <= 0) return null;
    cursor -= 1;
    return cloneGraphics(current());
  };

  const redo = (): readonly SketchGraphicSnapshot[] | null => {
    if (cursor < 0 || cursor >= entries.length - 1) return null;
    cursor += 1;
    return cloneGraphics(current());
  };

  const clear = (): SketchHistorySnapshot => {
    entries = [];
    cursor = -1;
    return snapshot();
  };

  record('Initial sketch state', initialGraphics);

  return Object.freeze({
    record,
    undo,
    redo,
    replace,
    clear,
    current: () => cloneGraphics(current()),
    snapshot,
  });
};
