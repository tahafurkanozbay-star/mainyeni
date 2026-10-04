import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';
import type { WorkspaceTableTransition } from './ArcGisResultWorkspaceTableExperiencePolicy';
import {
  applyArcGisResultWorkspaceViewportIntent,
  type WorkspaceViewportAlignment,
  type WorkspaceViewportSnapshot,
  type WorkspaceViewportTransition,
} from './ArcGisResultWorkspaceViewportExperiencePolicy';

export type WorkspaceTableViewportReason =
  | 'focus-visible'
  | 'focus-reveal'
  | 'header-focus'
  | 'rows-reconciled'
  | 'no-focus';

export interface WorkspaceTableViewportCoordination {
  readonly viewport: WorkspaceViewportSnapshot;
  readonly viewportTransition: WorkspaceViewportTransition | null;
  readonly scrollRequired: boolean;
  readonly scrollTop: number;
  readonly focusedRowId: string | null;
  readonly reason: WorkspaceTableViewportReason;
  readonly announcement: string;
}

export interface WorkspaceTableViewportOptions {
  readonly alignment?: WorkspaceViewportAlignment;
  readonly announceReveal?: boolean;
}

const MAX_ANNOUNCEMENT = 240;

const cleanText = (value: unknown, limit = MAX_ANNOUNCEMENT): string => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit);

const rowIsRendered = (viewport: WorkspaceViewportSnapshot, rowId: string): boolean => {
  const index = viewport.rowIds.indexOf(rowId);
  return index >= viewport.range.startIndex && index <= viewport.range.endIndex;
};

const rowIsVisible = (viewport: WorkspaceViewportSnapshot, rowId: string): boolean => {
  const index = viewport.rowIds.indexOf(rowId);
  return index >= viewport.range.visibleStartIndex && index <= viewport.range.visibleEndIndex;
};

const focusedRow = (tableTransition: WorkspaceTableTransition): string | null => {
  if (tableTransition.next.focus.inHeader) return null;
  return tableTransition.next.rowIds[tableTransition.next.focus.rowIndex] ?? null;
};

const result = (
  viewport: WorkspaceViewportSnapshot,
  viewportTransition: WorkspaceViewportTransition | null,
  focusedRowId: string | null,
  reason: WorkspaceTableViewportReason,
  announcement = '',
): WorkspaceTableViewportCoordination => Object.freeze({
  viewport: viewportTransition?.next ?? viewport,
  viewportTransition,
  scrollRequired: Boolean(viewportTransition?.scrollRequired),
  scrollTop: viewportTransition?.scrollTop ?? viewport.scrollTop,
  focusedRowId,
  reason,
  announcement: cleanText(announcement),
});

/**
 * Coordinates the governed table and virtual viewport without introducing a
 * second focus or scrolling state machine. Table authority decides focus;
 * viewport authority decides the minimum scroll required to reveal it.
 */
export function coordinateArcGisResultWorkspaceTableViewport(
  workspace: ResultWorkspaceSnapshot,
  viewport: WorkspaceViewportSnapshot,
  tableTransition: WorkspaceTableTransition,
  options: WorkspaceTableViewportOptions = {},
): WorkspaceTableViewportCoordination {
  const nextRows = tableTransition.next.rowIds;
  let workingViewport = viewport;
  let reconcileTransition: WorkspaceViewportTransition | null = null;

  const rowsChanged = nextRows.length !== viewport.rowIds.length
    || nextRows.some((id, index) => viewport.rowIds[index] !== id);
  if (rowsChanged) {
    reconcileTransition = applyArcGisResultWorkspaceViewportIntent(workspace, viewport, {
      type: 'reconcile',
      rowIds: nextRows,
    });
    workingViewport = reconcileTransition.next;
  }

  const rowId = focusedRow(tableTransition);
  if (!rowId) {
    return result(
      viewport,
      reconcileTransition,
      null,
      tableTransition.next.focus.inHeader ? 'header-focus' : rowsChanged ? 'rows-reconciled' : 'no-focus',
      tableTransition.announcement,
    );
  }

  if (!workingViewport.rowIds.includes(rowId)) {
    return result(viewport, reconcileTransition, null, rowsChanged ? 'rows-reconciled' : 'no-focus', tableTransition.announcement);
  }

  if (rowIsVisible(workingViewport, rowId)) {
    return result(viewport, reconcileTransition, rowId, 'focus-visible', tableTransition.announcement);
  }

  const revealTransition = applyArcGisResultWorkspaceViewportIntent(workspace, workingViewport, {
    type: 'focus-row',
    rowId,
    alignment: options.alignment ?? 'nearest',
  });
  const revealAnnouncement = options.announceReveal && !rowIsRendered(workingViewport, rowId)
    ? `Odaklanan sonuç görünür alana getirildi. ${revealTransition.next.accessibility.announcement}`
    : tableTransition.announcement;

  return result(viewport, revealTransition, rowId, 'focus-reveal', revealAnnouncement);
}

export function getArcGisResultWorkspaceTableViewportFocusState(
  viewport: WorkspaceViewportSnapshot,
  rowId: string | null,
): Readonly<{
  admitted: boolean;
  rendered: boolean;
  visible: boolean;
  rowIndex: number;
}> {
  if (!rowId) return Object.freeze({ admitted: false, rendered: false, visible: false, rowIndex: -1 });
  const rowIndex = viewport.rowIds.indexOf(rowId);
  if (rowIndex < 0) return Object.freeze({ admitted: false, rendered: false, visible: false, rowIndex: -1 });
  return Object.freeze({
    admitted: true,
    rendered: rowIsRendered(viewport, rowId),
    visible: rowIsVisible(viewport, rowId),
    rowIndex,
  });
}
