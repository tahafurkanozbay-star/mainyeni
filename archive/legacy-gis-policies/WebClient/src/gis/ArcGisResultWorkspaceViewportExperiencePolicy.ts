import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';
import type { WorkspaceTableSnapshot } from './ArcGisResultWorkspaceTableExperiencePolicy';

export type WorkspaceViewportAlignment = 'nearest' | 'start' | 'center' | 'end';
export type WorkspaceViewportReason = 'initial' | 'scroll' | 'focus' | 'resize' | 'reconcile';

export interface WorkspaceViewportInput {
  readonly viewportHeight: number;
  readonly rowHeight?: number;
  readonly scrollTop?: number;
  readonly overscanRows?: number;
  readonly stickyHeaderHeight?: number;
}

export interface WorkspaceViewportRange {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly visibleStartIndex: number;
  readonly visibleEndIndex: number;
  readonly count: number;
}

export interface WorkspaceViewportAccessibility {
  readonly ariaRowCount: number;
  readonly setSize: number;
  readonly busy: boolean;
  readonly reducedMotion: boolean;
  readonly minimumTargetSize: 44 | 48;
  readonly announcement: string;
}

export interface WorkspaceViewportSnapshot {
  readonly rowIds: readonly string[];
  readonly viewportHeight: number;
  readonly rowHeight: number;
  readonly stickyHeaderHeight: number;
  readonly scrollTop: number;
  readonly maximumScrollTop: number;
  readonly overscanRows: number;
  readonly range: WorkspaceViewportRange;
  readonly focusedRowId: string | null;
  readonly anchorRowId: string | null;
  readonly accessibility: WorkspaceViewportAccessibility;
  readonly revision: number;
}

export type WorkspaceViewportIntent =
  | { readonly type: 'scroll'; readonly scrollTop: number }
  | { readonly type: 'resize'; readonly viewportHeight: number }
  | { readonly type: 'focus-row'; readonly rowId: string; readonly alignment?: WorkspaceViewportAlignment }
  | { readonly type: 'reconcile'; readonly rowIds: readonly string[] }
  | { readonly type: 'set-row-height'; readonly rowHeight: number };

export interface WorkspaceViewportTransition {
  readonly next: WorkspaceViewportSnapshot;
  readonly reason: WorkspaceViewportReason;
  readonly scrollRequired: boolean;
  readonly scrollTop: number;
}

const MAX_ROWS = 20_000;
const MIN_VIEWPORT_HEIGHT = 1;
const MAX_VIEWPORT_HEIGHT = 16_384;
const MIN_ROW_HEIGHT = 32;
const MAX_ROW_HEIGHT = 160;
const DEFAULT_ROW_HEIGHT = 52;
const MAX_OVERSCAN = 24;
const DEFAULT_OVERSCAN = 4;
const MAX_STICKY_HEADER = 256;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;

const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;
const integer = (value: number, fallback = 0): number => Math.trunc(finite(value, fallback));
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const cleanId = (value: unknown): string => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);

const nextRevision = (revision: number): number => {
  const safe = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  return safe >= MAX_REVISION ? 0 : safe + 1;
};

const normalizeIds = (values: readonly string[]): readonly string[] => {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (output.length >= MAX_ROWS) break;
    const id = cleanId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return Object.freeze(output);
};

const maximumScrollTop = (rowCount: number, rowHeight: number, viewportHeight: number, stickyHeaderHeight: number): number => {
  const contentHeight = rowCount * rowHeight;
  const availableHeight = Math.max(1, viewportHeight - stickyHeaderHeight);
  return Math.max(0, contentHeight - availableHeight);
};

const deriveRange = (
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  stickyHeaderHeight: number,
  rowHeight: number,
  overscanRows: number,
): WorkspaceViewportRange => {
  if (rowCount === 0) {
    return Object.freeze({ startIndex: 0, endIndex: -1, visibleStartIndex: 0, visibleEndIndex: -1, count: 0 });
  }
  const availableHeight = Math.max(1, viewportHeight - stickyHeaderHeight);
  const visibleStartIndex = clamp(Math.floor(scrollTop / rowHeight), 0, rowCount - 1);
  const visibleCount = Math.max(1, Math.ceil(availableHeight / rowHeight));
  const visibleEndIndex = clamp(visibleStartIndex + visibleCount - 1, visibleStartIndex, rowCount - 1);
  const startIndex = Math.max(0, visibleStartIndex - overscanRows);
  const endIndex = Math.min(rowCount - 1, visibleEndIndex + overscanRows);
  return Object.freeze({ startIndex, endIndex, visibleStartIndex, visibleEndIndex, count: endIndex - startIndex + 1 });
};

const announcement = (range: WorkspaceViewportRange, rowCount: number): string => {
  if (rowCount === 0) return 'Gösterilecek sonuç yok.';
  return `${range.visibleStartIndex + 1}-${range.visibleEndIndex + 1} arası sonuçlar gösteriliyor. Toplam ${rowCount} sonuç.`;
};

const buildSnapshot = (
  workspace: ResultWorkspaceSnapshot,
  rowIds: readonly string[],
  viewportHeight: number,
  rowHeight: number,
  stickyHeaderHeight: number,
  scrollTop: number,
  overscanRows: number,
  focusedRowId: string | null,
  anchorRowId: string | null,
  revision: number,
): WorkspaceViewportSnapshot => {
  const maxScroll = maximumScrollTop(rowIds.length, rowHeight, viewportHeight, stickyHeaderHeight);
  const safeScrollTop = clamp(finite(scrollTop, 0), 0, maxScroll);
  const range = deriveRange(rowIds.length, safeScrollTop, viewportHeight, stickyHeaderHeight, rowHeight, overscanRows);
  return Object.freeze({
    rowIds,
    viewportHeight,
    rowHeight,
    stickyHeaderHeight,
    scrollTop: safeScrollTop,
    maximumScrollTop: maxScroll,
    overscanRows,
    range,
    focusedRowId,
    anchorRowId,
    accessibility: Object.freeze({
      ariaRowCount: rowIds.length,
      setSize: rowIds.length,
      busy: workspace.model.status === 'loading',
      reducedMotion: workspace.accessibility.reducedMotion,
      minimumTargetSize: workspace.accessibility.minimumTargetSize,
      announcement: announcement(range, rowIds.length),
    }),
    revision,
  });
};

export function createArcGisResultWorkspaceViewportExperience(
  workspace: ResultWorkspaceSnapshot,
  table: WorkspaceTableSnapshot,
  input: WorkspaceViewportInput,
): WorkspaceViewportSnapshot {
  const rowIds = normalizeIds(table.rowIds);
  const viewportHeight = clamp(integer(input.viewportHeight, 480), MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT);
  const rowHeight = clamp(integer(input.rowHeight ?? DEFAULT_ROW_HEIGHT, DEFAULT_ROW_HEIGHT), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
  const stickyHeaderHeight = clamp(integer(input.stickyHeaderHeight ?? 0), 0, Math.min(MAX_STICKY_HEADER, viewportHeight - 1));
  const overscanRows = clamp(integer(input.overscanRows ?? DEFAULT_OVERSCAN, DEFAULT_OVERSCAN), 0, MAX_OVERSCAN);
  const focusedRowId = table.focus.inHeader ? null : rowIds[table.focus.rowIndex] ?? null;
  return buildSnapshot(
    workspace,
    rowIds,
    viewportHeight,
    rowHeight,
    stickyHeaderHeight,
    finite(input.scrollTop ?? 0, 0),
    overscanRows,
    focusedRowId,
    focusedRowId,
    0,
  );
}

const targetScrollTop = (
  snapshot: WorkspaceViewportSnapshot,
  rowIndex: number,
  alignment: WorkspaceViewportAlignment,
): number => {
  const availableHeight = Math.max(1, snapshot.viewportHeight - snapshot.stickyHeaderHeight);
  const rowStart = rowIndex * snapshot.rowHeight;
  const rowEnd = rowStart + snapshot.rowHeight;
  const viewportStart = snapshot.scrollTop;
  const viewportEnd = viewportStart + availableHeight;
  if (alignment === 'nearest') {
    if (rowStart >= viewportStart && rowEnd <= viewportEnd) return snapshot.scrollTop;
    if (rowStart < viewportStart) return rowStart;
    return rowEnd - availableHeight;
  }
  if (alignment === 'start') return rowStart;
  if (alignment === 'end') return rowEnd - availableHeight;
  return rowStart - Math.max(0, (availableHeight - snapshot.rowHeight) / 2);
};

const transition = (
  workspace: ResultWorkspaceSnapshot,
  current: WorkspaceViewportSnapshot,
  patch: {
    readonly rowIds?: readonly string[];
    readonly viewportHeight?: number;
    readonly rowHeight?: number;
    readonly scrollTop?: number;
    readonly focusedRowId?: string | null;
    readonly anchorRowId?: string | null;
  },
  reason: WorkspaceViewportReason,
): WorkspaceViewportTransition => {
  const next = buildSnapshot(
    workspace,
    patch.rowIds ?? current.rowIds,
    patch.viewportHeight ?? current.viewportHeight,
    patch.rowHeight ?? current.rowHeight,
    current.stickyHeaderHeight,
    patch.scrollTop ?? current.scrollTop,
    current.overscanRows,
    patch.focusedRowId === undefined ? current.focusedRowId : patch.focusedRowId,
    patch.anchorRowId === undefined ? current.anchorRowId : patch.anchorRowId,
    nextRevision(current.revision),
  );
  return Object.freeze({
    next,
    reason,
    scrollRequired: Math.abs(next.scrollTop - current.scrollTop) >= 0.5,
    scrollTop: next.scrollTop,
  });
};

export function applyArcGisResultWorkspaceViewportIntent(
  workspace: ResultWorkspaceSnapshot,
  snapshot: WorkspaceViewportSnapshot,
  intent: WorkspaceViewportIntent,
): WorkspaceViewportTransition {
  if (intent.type === 'scroll') {
    return transition(workspace, snapshot, { scrollTop: finite(intent.scrollTop, snapshot.scrollTop) }, 'scroll');
  }
  if (intent.type === 'resize') {
    const viewportHeight = clamp(integer(intent.viewportHeight, snapshot.viewportHeight), MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT);
    return transition(workspace, snapshot, { viewportHeight }, 'resize');
  }
  if (intent.type === 'set-row-height') {
    const rowHeight = clamp(integer(intent.rowHeight, snapshot.rowHeight), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
    const anchorIndex = snapshot.anchorRowId ? snapshot.rowIds.indexOf(snapshot.anchorRowId) : -1;
    const scrollTop = anchorIndex >= 0 ? anchorIndex * rowHeight : snapshot.scrollTop;
    return transition(workspace, snapshot, { rowHeight, scrollTop }, 'resize');
  }
  if (intent.type === 'focus-row') {
    const rowId = cleanId(intent.rowId);
    const rowIndex = snapshot.rowIds.indexOf(rowId);
    if (rowIndex < 0) return transition(workspace, snapshot, {}, 'focus');
    const scrollTop = targetScrollTop(snapshot, rowIndex, intent.alignment ?? 'nearest');
    return transition(workspace, snapshot, { scrollTop, focusedRowId: rowId, anchorRowId: rowId }, 'focus');
  }
  const rowIds = normalizeIds(intent.rowIds);
  const focusedRowId = snapshot.focusedRowId && rowIds.includes(snapshot.focusedRowId) ? snapshot.focusedRowId : null;
  const anchorRowId = snapshot.anchorRowId && rowIds.includes(snapshot.anchorRowId) ? snapshot.anchorRowId : focusedRowId;
  let scrollTop = snapshot.scrollTop;
  if (anchorRowId) {
    const index = rowIds.indexOf(anchorRowId);
    scrollTop = index * snapshot.rowHeight;
  }
  return transition(workspace, snapshot, { rowIds, focusedRowId, anchorRowId, scrollTop }, 'reconcile');
}

export function getArcGisResultWorkspaceViewportRowIds(snapshot: WorkspaceViewportSnapshot): readonly string[] {
  if (snapshot.range.count === 0) return Object.freeze([]);
  return Object.freeze(snapshot.rowIds.slice(snapshot.range.startIndex, snapshot.range.endIndex + 1));
}

export function getArcGisResultWorkspaceViewportOffsets(snapshot: WorkspaceViewportSnapshot): Readonly<{
  before: number;
  after: number;
  total: number;
}> {
  const before = snapshot.range.count === 0 ? 0 : snapshot.range.startIndex * snapshot.rowHeight;
  const renderedHeight = snapshot.range.count * snapshot.rowHeight;
  const total = snapshot.rowIds.length * snapshot.rowHeight;
  return Object.freeze({ before, after: Math.max(0, total - before - renderedHeight), total });
}
